import { randomUUID, createHash } from 'node:crypto';
import { constants, closeSync, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import type { DB } from '@qgroup/database';
import { migrateDatabase, REBUILD_SCHEMA_VERSION } from '@qgroup/database';
import { z } from 'zod';
import { readPaymentImage } from './payment-media';
import { decodeErasureJournal, erasureRequestId, readVerifiedErasureJournal, type ErasureJournal, type StoredIntent } from './erasure-journal';

const idPattern = /^[0-9]{8}-[0-9]{6}-[a-f0-9]{32}$/;
const filePattern = /^(?:state\.sqlite3|state\.erasures\.jsonl|images\/[a-f0-9]{2}\/[a-f0-9]{64}\.png)$/;
const File = z.object({ path: z.string().regex(filePattern), size: z.number().int().nonnegative().safe(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const common = { id: z.string().regex(idPattern), createdAt: z.iso.datetime(), sequence: z.number().int().positive().safe(), files: z.array(File), restoreEligible: z.literal(false) };
const Manifest = z.union([
  z.object({ ...common, version: z.literal(1), schema: z.literal(13) }).strict(),
  z.object({ ...common, version: z.literal(2), schema: z.literal(REBUILD_SCHEMA_VERSION), lineageId: z.string().regex(/^[a-f0-9]{32}$/) }).strict(),
]).refine(m => {
  const paths = m.files.map(f => f.path);
  return paths.length === new Set(paths).size && paths.includes('state.sqlite3') && paths.includes('state.erasures.jsonl') &&
    paths.every(path => !path.startsWith('images/') || path.split('/')[1] === path.split('/')[2]!.slice(0, 2));
});
type Manifest = z.infer<typeof Manifest>;
const hash = (raw: Buffer) => createHash('sha256').update(raw).digest('hex');
function directory(path: string, create = false) {
  if (create && !existsSync(path)) mkdirSync(path, { mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe backup directory');
}
function read(path: string, maxSize = Number.MAX_SAFE_INTEGER) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const info = fstatSync(fd); if (!info.isFile() || info.size > maxSize) throw new Error('Invalid backup file'); return readFileSync(fd); }
  finally { closeSync(fd); }
}
function sync(path: string) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function write(path: string, raw: Buffer) { const fd = openSync(path, 'wx', 0o600); try { writeFileSync(fd, raw); fsyncSync(fd); } finally { closeSync(fd); } }

/** Synchronous while holding the same SQLite writer lock as images and erasures.
 * No live WAL copy, bot work execution, authentication import, or in-place restore.
 */
export function createPairedBackups(db: DB, journal: ErasureJournal, now: () => Date) {
  if (db.name === ':memory:') return undefined;
  const root = join(dirname(db.name), 'paired-backups');
  const folder = (id: string) => { if (!idPattern.test(id)) throw new Error('Invalid backup name'); directory(root); const path = join(root, id); directory(path); return path; };
  function manifest(id: string) {
    const result = Manifest.parse(JSON.parse(read(join(folder(id), 'manifest.json'), 4 * 1024 * 1024).toString('utf8')));
    if (result.id !== id) throw new Error('Backup name mismatch');
    return result;
  }
  function records() {
    if (!existsSync(root)) return [];
    directory(root);
    return readdirSync(root, { withFileTypes: true }).filter(item => idPattern.test(item.name)).map(item => {
      if (!item.isDirectory() || item.isSymbolicLink()) throw new Error('Unsafe backup entry');
      const m = manifest(item.name);
      return { id: m.id, createdAt: m.createdAt, sequence: m.sequence, size: m.files.reduce((sum, f) => sum + f.size, 0), schema: m.schema };
    }).sort((a, b) => b.sequence - a.sequence || b.id.localeCompare(a.id));
  }
  const list = () => records().map(({ id, createdAt, size, schema }) => ({ id, createdAt, size, schema }));
  function prune() {
    const cutoff = now().getTime() - 14 * 86400 * 1000;
    for (const [index, item] of list().entries()) {
      if (index < 30 && Date.parse(item.createdAt) >= cutoff) continue;
      const path = folder(item.id), m = manifest(item.id);
      // Refuse unclassified content instead of recursively deleting unrelated data.
      const expected = new Set(['manifest.json', ...m.files.map(f => f.path)]);
      function check(path: string, prefix = '') {
        for (const child of readdirSync(path, { withFileTypes: true })) {
          const relative = prefix + child.name;
          if (child.isSymbolicLink()) throw new Error('Unsafe backup retention entry');
          if (child.isDirectory() && (relative === 'images' || /^images\/[a-f0-9]{2}$/.test(relative))) check(join(path, child.name), relative + '/');
          else if (!child.isFile() || !expected.has(relative)) throw new Error('Unclassified backup retention entry');
        }
      }
      check(path); rmSync(path, { recursive: true }); sync(root);
    }
  }
  function capture() {
    return db.transaction(() => {
      // Nested callers may have started a deferred transaction; upgrade it before
      // reading either SQLite, external image files, or the durable journal.
      db.exec('UPDATE rebuild_schema SET version=version WHERE 0');
      directory(dirname(db.name)); directory(root, true); sync(dirname(root));
      const sequence = (records()[0]?.sequence ?? 0) + 1;
      const createdAt = now().toISOString(), stamp = createdAt.slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
      const id = stamp + '-' + randomUUID().replaceAll('-', ''), stage = join(root, '.' + id + '.tmp');
      mkdirSync(stage, { mode: 0o700 });
      try {
        const files: Manifest['files'] = [];
        const save = (path: string, raw: Buffer) => { write(join(stage, path), raw); files.push({ path, size: raw.length, sha256: hash(raw) }); };
        // serialize includes the complete transaction snapshot even in WAL mode.
        const database = db.serialize();
        // SQLite deserialize cannot open a WAL header in memory. The serialized
        // image already includes WAL pages; mark this standalone copy as rollback.
        database[18] = 1; database[19] = 1;
        save('state.sqlite3', database);
        const entries = readVerifiedErasureJournal(db, journal);
        save('state.erasures.jsonl', Buffer.from(entries.map(entry => JSON.stringify(entry) + '\n').join('')));
        const images = db.prepare('SELECT digest,size,mime FROM image_assets ORDER BY digest').all() as { digest: string; size: number; mime: string }[];
        if (images.length) mkdirSync(join(stage, 'images'), { mode: 0o700 });
        for (const image of images) {
          if (!/^[a-f0-9]{64}$/.test(image.digest) || image.mime !== 'image/png') throw new Error('Invalid paired image reference');
          const raw = readPaymentImage(db, image.digest);
          if (raw.length !== image.size) throw new Error('Paired image size mismatch');
          const prefix = join(stage, 'images', image.digest.slice(0, 2)); directory(prefix, true);
          save('images/' + image.digest.slice(0, 2) + '/' + image.digest + '.png', raw); sync(prefix);
        }
        if (images.length) sync(join(stage, 'images'));
        const lineageId = (db.prepare('SELECT lineage_id FROM rebuild_storage WHERE id=1').get() as {lineage_id:string}).lineage_id;
        const m = Manifest.parse({ version: 2, lineageId, id, createdAt, sequence, schema: REBUILD_SCHEMA_VERSION, files, restoreEligible: false });
        const encoded = Buffer.from(JSON.stringify(m) + '\n');
        if (encoded.length > 4 * 1024 * 1024) throw new Error('Backup manifest exceeds supported size');
        write(join(stage, 'manifest.json'), encoded); sync(stage);
        renameSync(stage, join(root, id)); sync(root);
        return { id, createdAt, size: files.reduce((sum, file) => sum + file.size, 0), schema: m.schema };
      } finally { if (existsSync(stage)) rmSync(stage, { recursive: true }); }
    }).immediate();
  }
  const open = (id: string, latest?: StoredIntent[]) => openPairedBackup(folder(id), latest).db;
  return { capture, list, open, prune };
}
export type PairedBackups = NonNullable<ReturnType<typeof createPairedBackups>>;

function verifiedFile(base: string, file: z.infer<typeof File>) {
  if (file.path.startsWith('images/')) { directory(join(base, 'images')); directory(join(base, dirname(file.path))); }
  const raw = read(join(base, file.path), file.size);
  if (raw.length !== file.size || hash(raw) !== file.sha256) throw new Error('Backup checksum mismatch');
  return raw;
}
function assertLayout(base: string, manifest: Manifest) {
  const files = new Set(['manifest.json', ...manifest.files.map(file => file.path)]);
  const folders = new Set(manifest.files.filter(file => file.path.startsWith('images/')).flatMap(file => ['images', dirname(file.path)]));
  function visit(path: string, prefix = '') {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error('Unsafe backup layout');
      if (entry.isDirectory() && folders.has(relative)) visit(join(path, entry.name), relative + '/');
      else if (!entry.isFile() || !files.has(relative)) throw new Error('Unclassified backup entry');
    }
  }
  visit(base);
}
/** Read an immutable native archive without opening or altering its source DB. */
export function openPairedBackup(base: string, latest?: StoredIntent[]) {
  directory(base);
  const encoded = read(join(base, 'manifest.json'), 4 * 1024 * 1024), m = Manifest.parse(JSON.parse(encoded.toString('utf8')));
  if (basename(base) !== m.id) throw new Error('Backup directory name mismatch');
  assertLayout(base, m);
  let bytes: Buffer | undefined;
  let entries: StoredIntent[] = [];
  for (const file of m.files) {
    const raw = verifiedFile(base, file);
    if (file.path === 'state.sqlite3') bytes = raw;
    if (file.path === 'state.erasures.jsonl') entries = decodeErasureJournal(raw.toString('utf8'));
  }
  const copy = new Database(bytes!);
  try {
    copy.pragma('foreign_keys = ON');
    const version = copy.prepare('SELECT version FROM rebuild_schema').get() as { version: number } | undefined;
    if (version?.version !== m.schema || copy.pragma('integrity_check', { simple: true }) !== 'ok' || (copy.pragma('foreign_key_check') as unknown[]).length) throw new Error('Backup database integrity failure');
    readVerifiedErasureJournal(copy, { read: () => entries, append() { throw new Error('Read-only backup ledger'); } });
    if (latest) {
      const current = new Map(latest.map(entry => [erasureRequestId(entry), JSON.stringify(entry)]));
      if (entries.some(entry => current.get(erasureRequestId(entry)) !== JSON.stringify(entry))) throw new Error('Latest erasure journal lost a historical intent');
    }
    if (m.version === 2 && (copy.prepare('SELECT lineage_id FROM rebuild_storage WHERE id=1').get() as {lineage_id:string}|undefined)?.lineage_id !== m.lineageId) throw new Error('Backup storage lineage mismatch');
    migrateDatabase(copy);
    // Manifest may not omit a referenced private image even if all listed hashes match.
    const imagePaths = m.files.filter(f => f.path.startsWith('images/')).map(f => f.path).sort();
    const referenced = (copy.prepare('SELECT digest,size FROM image_assets').all() as { digest: string; size: number }[]).map(image => {
      const path = 'images/' + image.digest.slice(0, 2) + '/' + image.digest + '.png';
      if (m.files.find(file => file.path === path)?.size !== image.size) throw new Error('Backup image pairing failure');
      return path;
    }).sort();
    if (JSON.stringify(imagePaths) !== JSON.stringify(referenced)) throw new Error('Backup image pairing failure');
    return { db: copy, manifest: m, entries, fingerprint: hash(encoded),
      readImage(digest: string) { const path = 'images/' + digest.slice(0, 2) + '/' + digest + '.png'; const file = m.files.find(f => f.path === path); if (!file) throw new Error('Missing backup image'); return verifiedFile(base, file); },
      assertUnchanged() { directory(base); assertLayout(base, m); if (!read(join(base, 'manifest.json'), 4 * 1024 * 1024).equals(encoded)) throw new Error('Backup manifest changed during recovery'); for (const file of m.files) verifiedFile(base, file); },
    };
  } catch (error) { copy.close(); throw error; }
}
