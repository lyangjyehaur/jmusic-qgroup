import { createHash, randomBytes } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { openDatabase, REBUILD_SCHEMA_VERSION, type DB } from '@qgroup/database';
import { decodeErasureJournal, erasureRequestId, readVerifiedErasureJournal, type StoredIntent } from './erasure-journal';
import { openPairedBackup } from './paired-backups';
import { createPrivacy } from './privacy';

const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const encode = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? { integer: item.toString() } : item);
const authTables = ['browser_accounts', 'browser_sessions', 'visitor_sessions', 'admin_sessions', 'auth_requests', 'login_attempts', 'qq_attempts', 'device_links', 'music_claim_intents'];
const botTables = ['bot_group_ignores', 'bot_groups', 'bot_outbox', 'bot_runtime', 'bot_settings', 'bot_settings_history'];
function existsEntry(path: string) {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return false; }
}
function canonical(path: string, directory: boolean) {
  const result = resolve(path), stat = lstatSync(result);
  if (realpathSync(result) !== result || stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error('Recovery input must be a canonical regular path');
  return result;
}
function read(path: string, max = 512 * 1024 * 1024) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = fstatSync(fd); if (!stat.isFile() || stat.size > max) throw new Error('Invalid recovery evidence file'); return readFileSync(fd); }
  finally { closeSync(fd); }
}
function sync(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function write(path: string, bytes: Buffer | string) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
const decode = (bytes: Buffer) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
function readBotEvidence(root: string) {
  canonical(root, true);
  return readdirSync(root).sort().map(name => {
    if (!/^(?:bot-group-state(?:-[a-f0-9]{20})?\.json|bot-health\.json|bot-events\.jsonl(?:\.[1-4])?)$/.test(name)) throw new Error('Unclassified bot evidence');
    const bytes = read(join(root, name));
    if (name.startsWith('bot-group-state')) {
      const state: unknown = JSON.parse(decode(bytes));
      if (!state || typeof state !== 'object' || !('push_authorized' in state) || typeof state.push_authorized !== 'boolean') throw new Error('Invalid bot authorization state');
    }
    return { name, bytes, sha256: digest(bytes), size: bytes.length };
  });
}
function ledger(raw: Buffer) {
  const entries = decodeErasureJournal(decode(raw)), ids = new Map<string, string>();
  for (const entry of entries) {
    const id = erasureRequestId(entry), value = JSON.stringify(entry);
    if (ids.has(id) && ids.get(id) !== value) throw new Error('Conflicting latest erasure intent');
    ids.set(id, value);
  }
  return entries;
}
function replay(db: DB, entries: StoredIntent[]) {
  const journal = { read: () => entries, append() { throw new Error('Read-only recovery journal'); } };
  createPrivacy(db, journal); readVerifiedErasureJournal(db, journal);
}
function schema(db: DB) { return encode(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()); }
function columns(db: DB, table: string) { return (db.prepare('PRAGMA table_info(' + quote(table) + ')').all() as {name:string}[]).map(row => row.name); }
function tableDigest(db: DB, table: string) {
  // Token hashes are revoked later; account-closure replay randomizes them.
  const fields = columns(db, table).filter(name => table !== 'users' || name !== 'token_hash').map(quote);
  const hash = createHash('sha256');
  for (const row of db.prepare('SELECT ' + fields.join(',') + ' FROM ' + quote(table) + ' ORDER BY ' + fields.map(field => field + ' COLLATE BINARY').join(',')).safeIntegers(true).raw(true).iterate()) hash.update(encode(row) + '\n');
  return hash.digest('hex');
}
function revokeAuth(db: DB) {
  db.transaction(() => {
    for (const table of authTables) db.exec('DELETE FROM ' + quote(table));
    // Keep rate limits, PINs, linked identities, durable business receipts and invitation tokens.
    db.exec("UPDATE migration_map SET status='erased' WHERE source='music-identity' AND entity_type IN ('sessions','entry_intents'); DELETE FROM music_legacy_identity WHERE table_name IN ('sessions','entry_intents')");
    const update = db.prepare('UPDATE users SET token_hash=? WHERE id=?');
    for (const {id} of db.prepare('SELECT id FROM users').all() as {id:string}[]) update.run(randomBytes(32).toString('hex'), id);
  }).immediate();
}
function reconcileBot(before: DB, latest: DB) {
  const identity = ['event_id', 'poll_id', 'kind', 'dedupe_key', 'channel', 'target', 'payload_json', 'due_at', 'created_at', 'recipient_user_id'];
  for (const row of before.prepare('SELECT * FROM bot_outbox').safeIntegers(true).iterate() as Iterable<Record<string, unknown>>) {
    const next = latest.prepare('SELECT * FROM bot_outbox WHERE id=?').safeIntegers(true).get(row.id) as Record<string, unknown>|undefined;
    if (!next || identity.some(key => encode(next[key]) !== encode(row[key])) || (next.attempts as bigint) < (row.attempts as bigint)) throw new Error('Checkpoint lost or changed bot delivery identity');
    if ((row.status === 'sent' || row.status === 'skipped') && encode(next) !== encode(row)) throw new Error('Checkpoint changed a terminal bot delivery');
    if (row.status === 'sending' && next.status === 'pending') throw new Error('Checkpoint reset an uncertain bot delivery');
    if (row.simulated_at !== null && encode(next) !== encode(row)) throw new Error('Checkpoint changed a simulated bot delivery');
    if (row.delivered_payload_json !== null && row.delivered_payload_json !== next.delivered_payload_json) throw new Error('Checkpoint lost frozen bot delivery');
  }
  for (const row of before.prepare('SELECT * FROM bot_settings_history').iterate() as Iterable<{revision:number}>) {
    if (encode(latest.prepare('SELECT * FROM bot_settings_history WHERE revision=?').get(row.revision)) !== encode(row)) throw new Error('Checkpoint lost bot configuration history');
  }
}
export interface RecoveryInput {
  backup: string; checkpoint: string; latestLedger: string; botEvidence: string; destination: string;
  /** Human assertion only: this tool cannot stop or lock either running service. */
  quiescent: true;
}
/** Build a private, blocked candidate. Never start a worker or overwrite a service DB. */
export function restorePairedBackup(input: RecoveryInput, now = new Date()) {
  if (input.quiescent !== true) throw new Error('An explicit quiescent-copy assertion is required');
  const backupPath = canonical(input.backup, true), checkpointPath = canonical(input.checkpoint, true);
  const ledgerPath = canonical(input.latestLedger, false), evidencePath = canonical(input.botEvidence, true), destination = resolve(input.destination);
  if (existsEntry(destination)) throw new Error('Refusing existing recovery destination');
  canonical(dirname(destination), true);
  for (const source of [backupPath, checkpointPath, ledgerPath, evidencePath]) if (destination === source || destination.startsWith(source + sep) || source.startsWith(destination + sep)) throw new Error('Recovery source and destination must be isolated');
  const rawLedger = read(ledgerPath), entries = ledger(rawLedger), evidence = readBotEvidence(evidencePath);
  const before = openPairedBackup(backupPath, entries);
  let latest: ReturnType<typeof openPairedBackup>|undefined, stage: string|undefined;
  try {
    latest = openPairedBackup(checkpointPath, entries);
    if (before.manifest.version !== 2 || latest.manifest.version !== 2 || before.manifest.lineageId !== latest.manifest.lineageId) throw new Error('Recovery requires matching version 2 storage lineage');
    if (latest.manifest.sequence < before.manifest.sequence || Date.parse(latest.manifest.createdAt) < Date.parse(before.manifest.createdAt)) throw new Error('Checkpoint predates selected backup');
    const reference = openDatabase(':memory:');
    try { if (schema(before.db) !== schema(reference) || schema(latest.db) !== schema(reference)) throw new Error('Recovery schema requires explicit review'); }
    finally { reference.close(); }
    replay(before.db, entries); replay(latest.db, entries);
    reconcileBot(before.db, latest.db);
    // Normalize ephemeral proofs only on disposable images. Neither input is edited.
    revokeAuth(before.db); revokeAuth(latest.db);
    const domain: Record<string,string> = {};
    const tables = (latest.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[]).map(row => row.name);
    for (const table of tables.filter(table => !authTables.includes(table) && !botTables.includes(table))) {
      const current = tableDigest(latest.db, table);
      if (tableDigest(before.db, table) !== current) throw new Error('Selected backup would lose newer business data; select the latest complete checkpoint');
      domain[table] = current;
    }
    // Use the latest complete checkpoint after reconciliation, including every bot
    // column, newest jobs, claims, retries, simulated states and configuration.
    for (const row of before.db.prepare('SELECT name,seq FROM sqlite_sequence').safeIntegers(true).all() as {name:string;seq:bigint}[]) {
      const prior = latest.db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').safeIntegers(true).get(row.name) as {seq:bigint}|undefined;
      if (!prior) latest.db.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)').run(row.name,row.seq);
      else if (prior.seq < row.seq) latest.db.prepare('UPDATE sqlite_sequence SET seq=? WHERE name=?').run(row.seq,row.name);
    }
    latest.db.exec('UPDATE rebuild_storage SET recovery_required=1 WHERE id=1');
    if (latest.db.pragma('integrity_check', {simple:true}) !== 'ok' || (latest.db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Recovery candidate integrity failure');
    stage = mkdtempSync(join(dirname(destination), '.qgroup-recovery-'));
    // mkdtemp creates 0700; files are always exclusive 0600.
    const image = latest.db.serialize(); image[18] = 1; image[19] = 1;
    write(join(stage, 'unified.sqlite3'), image); write(join(stage, 'unified.erasures.jsonl'), rawLedger);
    const files: {path:string;size:number;sha256:string}[] = [{path:'unified.sqlite3',size:image.length,sha256:digest(image)},{path:'unified.erasures.jsonl',size:rawLedger.length,sha256:digest(rawLedger)}];
    const save = (path: string, bytes: Buffer) => { write(join(stage!,path),bytes); files.push({path,size:bytes.length,sha256:digest(bytes)}); };
    const images = latest.db.prepare('SELECT digest FROM image_assets ORDER BY digest').all() as {digest:string}[];
    if (images.length) mkdirSync(join(stage,'images'),{mode:0o700});
    for (const {digest: key} of images) {
      const folder = join(stage,'images',key.slice(0,2)); if (!existsSync(folder)) mkdirSync(folder,{mode:0o700});
      save('images/' + key.slice(0,2) + '/' + key + '.png', latest.readImage(key)); sync(folder);
    }
    if (images.length) sync(join(stage,'images'));
    mkdirSync(join(stage,'bot-evidence'),{mode:0o700}); mkdirSync(join(stage,'bot-logs'),{mode:0o700});
    for (const file of evidence) {
      save('bot-evidence/' + file.name,file.bytes);
      // Old health/log files are evidence, never a new running-health claim.
      if (file.name.startsWith('bot-group-state')) save('bot-logs/' + file.name,file.bytes);
    }
    sync(join(stage,'bot-evidence')); sync(join(stage,'bot-logs'));
    const review = latest.db.prepare("SELECT id,status,attempts,simulated_at FROM bot_outbox WHERE status IN ('sending','failed') OR (status='skipped' AND simulated_at IS NULL) ORDER BY id").all();
    const report = {version:1,schema:REBUILD_SCHEMA_VERSION,createdAt:now.toISOString(),lineageId:latest.manifest.lineageId,backup:before.fingerprint,checkpoint:latest.fingerprint,ledger:digest(rawLedger),
      domain,files,authenticationRevoked:true,recoveryRequired:true,releaseEligible:false,botDeliveryReview:review,
      remaining:['verify_actual_web_bot_versions','verify_quiescent_complete_sources','review_platform_delivery_uncertainty','verify_group_authorization_and_external_config','verify_database_and_runtime_compatibility','offline_activation_procedure']};
    write(join(stage,'recovery-manifest.json'), JSON.stringify(report,null,2) + '\n'); sync(stage);
    canonical(backupPath,true); canonical(checkpointPath,true); canonical(ledgerPath,false); canonical(evidencePath,true); canonical(dirname(destination),true);
    before.assertUnchanged(); latest.assertUnchanged();
    if (!read(ledgerPath).equals(rawLedger) || encode(readBotEvidence(evidencePath).map(({name,size,sha256})=>({name,size,sha256}))) !== encode(evidence.map(({name,size,sha256})=>({name,size,sha256})))) throw new Error('Recovery evidence changed during recovery');
    // A destination reservation prevents two recovery commands publishing together.
    // The parent is operator-controlled; external writers must remain stopped.
    const reservation = destination + '.recovery-lock';
    const lock = openSync(reservation, constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try {
      if (existsEntry(destination)) throw new Error('Recovery destination appeared during recovery');
      renameSync(stage,destination); stage=undefined; sync(dirname(destination));
    } finally { closeSync(lock); rmSync(reservation); }
    return {status:'candidate_created' as const,schema:report.schema,recoveryRequired:true,releaseEligible:false};
  } finally { before.db.close(); latest?.db.close(); if (stage) rmSync(stage,{recursive:true,force:true}); }
}
