import Database from 'better-sqlite3';
import { chmodSync, closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { seedWallpapers, openDatabase, detachLegacyAccount, REBUILD_SCHEMA_VERSION, type DB } from '@qgroup/database';
import { legacySchema } from '../../packages/database/src/legacy-schema';
import { schemaV1 } from '../../packages/database/src/schema-v1';
import { createPrivacy, sharedRecords } from '../../apps/api/src/privacy';
import { erasureJournal } from '../../apps/api/src/erasure-journal';
import { digest, importMusic, musicErasures, parseJson, profileId, readIdentity, object } from './music-codec';
import { boardTables, boardRows, boardPrimaryKeys, boardId, boardPayload, canonical, schemaObjects as objects, reconcileBoard } from './board-reconciliation';
import { reconcileMusic } from './music-reconciliation';
import { captureIdentitySource } from './identity-source';

type File = { path: string; digest: string; size: number };
function check(db: DB) {
  if (db.pragma('integrity_check', { simple: true }) !== 'ok' || (db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Snapshot database integrity/foreign-key check failed');
}
function assertLegacyBoard(db: DB) {
  check(db); if (!(db.prepare('SELECT id FROM site_settings WHERE id=1').get())) throw new Error('Missing board settings');
  const reference = new Database(':memory:');
  try {
    reference.exec(legacySchema);
    if (JSON.stringify(objects(reference)) !== JSON.stringify(objects(db))) throw new Error('Unsupported board schema: explicit review is required');
    const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
    if (JSON.stringify(versions) !== JSON.stringify(reference.prepare('SELECT version FROM schema_migrations ORDER BY version').all())) throw new Error('Unsupported board migration ledger');
  } finally { reference.close(); }
}
function walk(root: string, sub = ''): File[] {
  const result: File[] = [];
  for (const name of readdirSync(join(root, sub)).sort()) {
    const path = sub ? sub + '/' + name : name; const full = join(root, path); const stat = lstatSync(full);
    if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw new Error('Snapshot contains a link or special file');
    if (stat.isDirectory()) result.push(...walk(root, path));
    else {
      if (stat.size > 512 * 1024 * 1024) throw new Error('Snapshot file exceeds offline import limit');
      const bytes = readPrivateFile(full); result.push({ path, digest: digest(bytes), size: bytes.length });
    }
  }
  return result;
}
function readPrivateFile(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return readFileSync(fd); } finally { closeSync(fd); }
}
function writePrivate(path: string, bytes: string | Buffer) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
function syncDirectory(path: string) { const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
function syncTree(path: string) {
  for (const name of readdirSync(path)) {
    const child = join(path, name);
    if (lstatSync(child).isDirectory()) syncTree(child);
    else { const fd = openSync(child, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
  }
  syncDirectory(path);
}
const decode = (bytes: Buffer) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
function validateLayout(files: File[]) {
  const required = ['board.sqlite3', 'board.erasures.jsonl', 'music/data.json', 'music/identity.sqlite3', 'music/erasures.jsonl', 'music/walls/manifest.json'];
  if (required.some(path => !files.some(file => file.path === path))) throw new Error('Incomplete paired snapshot: explicit current ledgers and walls manifest are required');
  for (const { path } of files) {
    if (required.includes(path) || /^images\/[a-f0-9]{2}\/[a-f0-9]{64}\.png$/.test(path) || /^music\/walls\/[^/]+\.(?:png|jpg|jpeg|webp)$/.test(path)) continue;
    throw new Error('Unclassified snapshot file; no data was published');
  }
}
function recordBoard(db: DB, reconcile = false) {
  const counts: Record<string, number> = {};
  const insert = db.prepare('INSERT INTO migration_map VALUES(?,?,?,?,?,?,?)');
  if (reconcile) db.prepare("UPDATE migration_map SET status='erased' WHERE source='board'").run();
  for (const table of boardTables) {
    const pk = boardPrimaryKeys(db, table);
    let count = 0;
    for (const value of boardRows(db, table)) {
      const row = boardPayload(value); const id = boardId(value, pk);
      const hash = digest(canonical(row));
      if (!reconcile) insert.run('board', table, id, id, canonical(row.revision ?? row.version ?? ''), hash, 'preserved');
      else {
        const prior = db.prepare("SELECT payload_digest FROM migration_map WHERE source='board' AND entity_type=? AND source_id=?").get(table, id) as { payload_digest: string } | undefined;
        if (prior) db.prepare("UPDATE migration_map SET status=? WHERE source='board' AND entity_type=? AND source_id=?").run(prior.payload_digest === hash ? 'preserved' : 'erasure_redacted', table, id);
        else insert.run('erasure', table, id, id, '', hash, 'replayed');
      }
      count++;
    }
    counts[table] = count;
  }
  return counts;
}
/** Offline only. Source must be a complete, quiescent copy, never a running service directory. */
export async function importSnapshot(sourcePath: string, destinationPath: string, now = new Date()) {
  const source = resolve(sourcePath); const destination = resolve(destinationPath);
  if (lstatSync(source).isSymbolicLink() || realpathSync(source) !== source) throw new Error('Snapshot path must be canonical and not a symlink');
  if (destination === source || destination.startsWith(source + sep) || source.startsWith(destination + sep)) throw new Error('Source and destination must be isolated');
  const files = walk(source); validateLayout(files); const fingerprint = digest(JSON.stringify(files));
  if (existsSync(destination)) {
    if (lstatSync(destination).isSymbolicLink()) throw new Error('Refusing existing destination');
    const manifestPath = join(destination, 'import-manifest.json');
    if (existsSync(manifestPath)) {
      const prior = parseJson(decode(readPrivateFile(manifestPath))) as { sourceDigest?: string; schema?: number; report?: unknown };
      if (prior.sourceDigest === fingerprint && prior.schema === REBUILD_SCHEMA_VERSION) {
        const live = new Database(join(destination, 'unified.sqlite3'), { readonly: true, fileMustExist: true });
        try { check(live); if (!live.prepare('SELECT 1 FROM migration_runs WHERE source_digest=?').get(fingerprint)) throw new Error('Missing committed import marker'); }
        finally { live.close(); }
        return { status: 'already_imported', ...prior };
      }
    }
    throw new Error('Refusing to replace destination or newer business data');
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  if (realpathSync(dirname(destination)) !== dirname(destination)) throw new Error('Destination parent must be canonical');
  const stage = mkdtempSync(join(dirname(destination), '.qgroup-import-')); chmodSync(stage, 0o700);
  let db: DB | undefined;
  try {
    const boardCopy = join(stage, '.source-board.sqlite3'), expectedCopy = join(stage, '.expected-board.sqlite3');
    writePrivate(boardCopy, readPrivateFile(join(source, 'board.sqlite3')));
    const sourceDB = new Database(boardCopy, { readonly: true, fileMustExist: true });
    try { assertLegacyBoard(sourceDB); await sourceDB.backup(join(stage, 'unified.sqlite3')); await sourceDB.backup(expectedCopy); chmodSync(expectedCopy, 0o600); } finally { sourceDB.close(); }
    const copy = new Database(join(stage, 'unified.sqlite3'));
    try { copy.pragma('foreign_keys = ON'); copy.transaction(() => copy.exec(schemaV1)).immediate(); } finally { copy.close(); }
    db = openDatabase(join(stage, 'unified.sqlite3')); chmodSync(db.name, 0o600);
    const boardLedger = readPrivateFile(join(source, 'board.erasures.jsonl'));
    for (const line of decode(boardLedger).split('\n').filter(line => line.trim())) parseJson(line);
    writePrivate(join(stage, 'unified.erasures.jsonl'), boardLedger);
    // Replay current account closures before resolving any music ownership.
    const boardCounts = db.transaction(() => recordBoard(db!)).immediate();
    const boardJournal = erasureJournal(db);
    createPrivacy(db, {read:()=>boardJournal.read().filter(intent=>!('version' in intent&&intent.version===2)),append:entry=>boardJournal.append(entry)});
    const identityCopy = join(stage, '.source-identity.sqlite3');
    writePrivate(identityCopy, readPrivateFile(join(source, 'music/identity.sqlite3')));
    const identityDB = new Database(identityCopy, { readonly: true, fileMustExist: true }); let identity, identityEvidence;
    try { check(identityDB); identity = readIdentity(identityDB); identityEvidence = captureIdentitySource(identityDB); } finally { identityDB.close(); }
    const music = parseJson(decode(readPrivateFile(join(source, 'music/data.json'))));
    const ledger = readPrivateFile(join(source, 'music/erasures.jsonl')); const erased = musicErasures(decode(ledger));
    const memberKeys = new Set([...Object.keys(object(object(music, 'music').members, 'members')), ...identity.native_profiles!.map(row => String(row.qq))]);const erasedProfileIds=new Set<string>();
    for (const intent of boardJournal.read()) if ('kind' in intent && intent.kind !== 'account') {
      const ids=intent.version===2?new Set(intent.profiles.map(p=>p.id)):new Set([intent.profileId]);
      for(const id of ids)if(id)erasedProfileIds.add(id);
      for (const key of memberKeys) if (ids.has(profileId(key))) erased.set(key, intent.createdAt);
    }
    writePrivate(join(stage, 'legacy-music.erasures.jsonl'), ledger);
    const report = db.transaction(() => {
      db!.prepare('INSERT INTO music_documents VALUES(?,?,?)').run('identity_source', 0, JSON.stringify(identityEvidence));
      const imported = importMusic(db!, music, identity, erased, now.toISOString(),erasedProfileIds);
      seedWallpapers(db!,join(source,'music/walls'));
      // Administrative intents apply only after importing their legacy music scopes.
      // Captured reset entry IDs cannot return, and each action gets one audit record.
      createPrivacy(db!,boardJournal);
      for (const { user_id: id } of db!.prepare('SELECT user_id FROM privacy_requests').all() as { user_id: string }[]) { detachLegacyAccount(db!, id); if (Object.keys(sharedRecords(db!, id)).length) db!.prepare("UPDATE privacy_requests SET status='shared_review' WHERE user_id=?").run(id); }
      const boardAfterErasure = recordBoard(db!, true);
      const musicAfterErasure = {profiles:(db!.prepare('SELECT count(*) n FROM music_profiles WHERE erased_at IS NULL').get() as {n:number}).n,entries:(db!.prepare('SELECT count(*) n FROM music_entries').get() as {n:number}).n};
      const original = new Database(boardCopy, { readonly: true, fileMustExist: true }), expected = new Database(expectedCopy, { fileMustExist: true });
      let boardReconciliation,musicReconciliation;
      try {
        boardReconciliation = reconcileBoard(original, expected, db!, boardJournal.read());
        const identitySource = new Database(identityCopy,{readonly:true,fileMustExist:true});
        try { musicReconciliation=reconcileMusic(db!,parseJson(decode(readPrivateFile(join(source,'music/data.json')))),readIdentity(identitySource),decode(ledger),boardJournal.read(),original,now.toISOString(),identitySource); }
        finally { identitySource.close(); }
      } finally { original.close(); expected.close(); }
      const result = { board: boardCounts, boardAfterErasure, boardReconciliation, music: imported, musicAfterErasure, musicReconciliation, releaseEligible: false, remaining: ['historical_backups', 'browser_drafts', 'legacy_auth_adapters', 'rollback_export', 'full_capability_acceptance', 'production_version_pair'] };
      db!.prepare('INSERT INTO migration_runs VALUES(?,?,?,?)').run(fingerprint, JSON.stringify(files), JSON.stringify(result), now.toISOString()); check(db!); return result;
    }).immediate();
    for (const file of files.filter(file => file.path.startsWith('images/') || file.path.startsWith('music/walls/'))) {
      const bytes = readPrivateFile(join(source, file.path));
      if (digest(bytes) !== file.digest) throw new Error('Snapshot changed during import');
      if (file.path.startsWith('images/') && digest(bytes) !== file.path.split('/').at(-1)!.slice(0, -4)) throw new Error('Board image digest mismatch');
      if (file.path.startsWith('images/') && !db.prepare('SELECT 1 FROM image_assets WHERE digest=?').get(file.path.split('/').at(-1)!.slice(0, -4))) continue;
      writePrivate(join(stage, file.path.startsWith('music/') ? file.path.slice(6) : file.path), bytes);
    }
    // Require every referenced private PNG and every wallpaper manifest item to be present.
    for (const { digest: image } of db.prepare('SELECT digest FROM image_assets').all() as { digest: string }[]) if (!existsSync(join(stage, 'images', image.slice(0, 2), image + '.png'))) throw new Error('Referenced board image is missing');
    const walls = parseJson(decode(readPrivateFile(join(stage, 'walls/manifest.json'))));
    if (!walls || typeof walls !== 'object' || Array.isArray(walls) || !Array.isArray(walls.items)) throw new Error('Invalid wallpaper manifest');
    for (const item of walls.items) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.src !== 'string' || !/^\/walls\/[^/]+\.(?:png|jpg|jpeg|webp)$/.test(item.src) || item.src.includes('..') || !existsSync(join(stage, item.src.slice(1)))) throw new Error('Missing or unsafe wallpaper reference');
    }
    if (JSON.stringify(walk(source)) !== JSON.stringify(files)) throw new Error('Snapshot changed during import');
    db.pragma('wal_checkpoint(TRUNCATE)'); db.close(); db = undefined;
    for (const path of [boardCopy, expectedCopy, identityCopy]) for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
    const manifest = { sourceDigest: fingerprint, schema: REBUILD_SCHEMA_VERSION, report };
    writePrivate(join(stage, 'import-manifest.json'), JSON.stringify(manifest, null, 2) + '\n'); syncTree(stage);
    if (existsSync(destination)) throw new Error('Destination appeared during import');
    renameSync(stage, destination); syncDirectory(dirname(destination));
    return { status: 'imported', ...manifest };
  } catch (error) { db?.close(); rmSync(stage, { recursive: true, force: true }); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [source, destination, ...extra] = process.argv.slice(2);
  if (!source || !destination || extra.length) { process.stderr.write('Usage: npm run import:rebuild -- <private-snapshot-directory> <new-isolated-directory>\n'); process.exitCode = 1; }
  else try { const result = await importSnapshot(source, destination); process.stdout.write(JSON.stringify({ status: result.status, sourceDigest: result.sourceDigest, schema: result.schema, releaseEligible: false }) + '\n'); }
  catch { process.stderr.write('Import rejected. No candidate was published; inspect the private snapshot and migration rules.\n'); process.exitCode = 1; }
}
