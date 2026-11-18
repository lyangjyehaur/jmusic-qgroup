import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { openDatabase, type DB } from '@qgroup/database';
import { legacySchema } from '../../packages/database/src/legacy-schema';
import type { StoredIntent } from '../../apps/api/src/erasure-journal';
import { digest } from './music-codec';

type Row = Record<string, unknown>;
type SchemaObject = { type: string; name: string; tbl_name: string; sql: string | null };
export const quoted = (name: string) => '"' + name.replaceAll('"', '""') + '"';
export const schemaObjects = (db: DB) => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as SchemaObject[];
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? { sqliteInteger: item.toString() } : Buffer.isBuffer(item) ? { sqliteBlob: item.toString('base64') } : item);
}
function inventory() {
  const legacy = new Database(':memory:'); const current = openDatabase(':memory:');
  try {
    legacy.exec(legacySchema);
    const source = schemaObjects(legacy), tables = source.filter(row => row.type === 'table').map(row => row.name);
    if (tables.length !== 59) throw new Error('Frozen board inventory requires review');
    const names = new Set(tables);
    return { tables, source, target: schemaObjects(current).filter(row => names.has(row.tbl_name)) };
  } finally { legacy.close(); current.close(); }
}
// Enumerate the frozen schema, never heuristics over the candidate's new tables.
const boardSchema = inventory();
export const boardTables: readonly string[] = Object.freeze(boardSchema.tables);
export function boardPrimaryKeys(db: DB, table: string) {
  return (db.prepare(`PRAGMA table_info(${quoted(table)})`).all() as { name: string; pk: number }[]).filter(row => row.pk).sort((a, b) => a.pk - b.pk).map(row => row.name);
}
export function boardId(value: Row, keys: string[]) {
  return canonical(keys.length ? keys.map(key => value[key]) : [value.__source_rowid__]);
}
export function boardPayload(value: Row) {
  const { __source_rowid__: _rowid, ...payload } = value; return payload;
}
export function* boardRows(db: DB, table: string) {
  let last: bigint | null = null;
  const read = db.prepare(`SELECT rowid AS __source_rowid__,* FROM ${quoted(table)} WHERE (? IS NULL OR rowid>?) ORDER BY rowid LIMIT 256`).safeIntegers(true);
  for (;;) {
    const rows = read.all(last, last) as Row[];
    if (!rows.length) return;
    yield* rows; last = rows.at(-1)!.__source_rowid__ as bigint;
  }
}
function reject(): never { throw new Error('Board reconciliation failed; no candidate was published'); }
function equal(a: unknown, b: unknown) { if (canonical(a) !== canonical(b)) reject(); }
function verifyErasureMarkers(candidate:DB, entries:StoredIntent[]) {
  const unique=new Map<string,StoredIntent>();
  for(const entry of entries){
    const id='request_id' in entry?entry.request_id:entry.requestId;
    if(unique.has(id)&&canonical(unique.get(id))!==canonical(entry))reject();unique.set(id,entry);
  }
  const applied=candidate.prepare('SELECT request_id FROM erasure_applied').all() as {request_id:string}[];
  equal(applied.map(row=>row.request_id).sort(),[...unique.keys()].sort());
  let receipts=0;
  for(const entry of unique.values())if('version' in entry){
    receipts++;
    equal(candidate.prepare('SELECT signature,secret_hash FROM privacy_receipts WHERE request_id=?').get(entry.requestId),{signature:entry.signature,secret_hash:entry.secretHash});
  }
  equal(candidate.prepare('SELECT count(*) n FROM privacy_receipts').get(),{n:receipts});
  return unique.size;
}

// An independent, board-only erasure specification. This does not invoke the
// API's privacy replay or infer allowed changes from migration_map statuses.
// It runs on a private frozen source copy; business/history/bot tables stay exact.
function projectClosures(expected: DB, entries: StoredIntent[]) {
  const revoked = new Set<string>(); const requests = new Map<string, string>();
  for (const entry of entries) {
    const id = 'request_id' in entry ? entry.request_id : entry.requestId, encoded = canonical(entry);
    if (requests.has(id) && requests.get(id) !== encoded) reject();
    requests.set(id, encoded);
    if ('version' in entry && (entry.version === 2 || entry.kind === 'music')) continue;
    const user = 'user_id' in entry ? entry.user_id : entry.userId;
    const stamp = 'created_at' in entry ? entry.created_at : entry.createdAt;
    if (!expected.prepare('SELECT 1 FROM users WHERE id=?').get(user) || expected.prepare('SELECT 1 FROM privacy_requests WHERE user_id=?').get(user)) continue;
    expected.prepare(`UPDATE time_polls SET vote_revision=vote_revision+1 WHERE status IN ('open','closed')
      AND EXISTS(SELECT 1 FROM time_poll_ballots b WHERE b.poll_id=time_polls.id AND b.user_id=?)`).run(user);
    expected.prepare('DELETE FROM time_poll_votes WHERE user_id=?').run(user);
    expected.prepare('DELETE FROM time_poll_ballots WHERE user_id=?').run(user);
    expected.prepare(`DELETE FROM login_attempts WHERE provider='qq' AND EXISTS(SELECT 1 FROM external_identities i
      WHERE i.user_id=? AND i.provider='qq' AND i.client_id=login_attempts.app_id AND i.subject=login_attempts.openid)`).run(user);
    expected.prepare(`DELETE FROM login_attempts WHERE token_hash IN (SELECT token_hash FROM browser_sessions WHERE user_id=?)`).run(user);
    expected.prepare(`DELETE FROM auth_requests WHERE token_hash IN (SELECT token_hash FROM browser_sessions WHERE user_id=?)`).run(user);
    expected.prepare(`DELETE FROM browser_accounts WHERE token_hash IN (SELECT token_hash FROM browser_sessions WHERE user_id=?) OR user_id=?`).run(user, user);
    expected.prepare(`DELETE FROM visitor_sessions WHERE token_hash IN (SELECT token_hash FROM browser_sessions WHERE user_id=?)`).run(user);
    expected.prepare('DELETE FROM browser_sessions WHERE user_id=?').run(user);
    for (const table of ['external_profiles','external_identities','qq_accounts','qq_attempts','login_attempts','privacy_consents','user_payment_codes','notifications','request_results','device_links','admin_user_metadata','event_access']) {
      expected.prepare(`DELETE FROM ${quoted(table)} WHERE user_id=?`).run(user);
    }
    expected.exec(`DELETE FROM image_assets WHERE NOT EXISTS(SELECT 1 FROM user_payment_codes c WHERE c.digest=image_assets.digest)
      AND NOT EXISTS(SELECT 1 FROM settlement_code_images c WHERE c.digest=image_assets.digest)
      AND NOT EXISTS(SELECT 1 FROM settlement_receipt_images c WHERE c.digest=image_assets.digest)`);
    const role = expected.prepare('SELECT revision FROM user_admin_roles WHERE user_id=? AND is_admin=1').safeIntegers(true).get(user) as {revision:bigint}|undefined;
    if (role) {
      expected.prepare('UPDATE user_admin_roles SET is_admin=0,revision=revision+1,updated_at=? WHERE user_id=?').run(stamp,user);
      expected.prepare("INSERT INTO admin_role_history(user_id,actor_ref,before_value,after_value,revision,created_at) VALUES(?,'account_closure',1,0,?,?)").run(user,role.revision+1n,stamp);
    }
    expected.prepare("UPDATE users SET nickname='已注销用户',token_hash=? WHERE id=?").run('reconciliation:revoked:'+user,user);
    expected.prepare("INSERT INTO privacy_requests(id,user_id,status,created_at,updated_at) VALUES(?,?,'completed',?,?)").run(id,user,stamp,stamp);
    revoked.add(user);
  }
  return revoked;
}
// Shared history may be introduced by the paired music import. Its existence
// is checked directly; privacy_requests.status is never used as the oracle.
const sharedColumns: Record<string, string[]> = {
  appearance_actions:['actor_id'],music_catalog_actions:['actor_id'],events:['owner_id'],registrations:['user_id'],roster_parties:['manager_id'],attendees:['user_id','manager_id'],
  event_audit:['actor_id'],attendee_consents:['actor_id'],event_roles:['user_id'],management_invitations:['recipient_id','initiator_id','accepted_by'],settlement_history:['actor_id'],
  finance_reports:['reporter_id'],finance_report_actions:['actor_id'],finance_entries:['actor_id'],attendee_claims:['issuer_id','requester_id'],attendee_payment_origins:['payer_user_id'],
  time_polls:['owner_id'],time_poll_history:['actor_id'],account_audit:['user_id'],admin_role_history:['user_id'],music_profile_audit:['actor_id'],music_contact_history:['actor_id'],
  music_field_history:['actor_id'],bot_outbox:['recipient_user_id'],
};
function hasSharedHistory(candidate: DB, user: string) {
  for (const [table, columns] of Object.entries(sharedColumns)) if (candidate.prepare(`SELECT 1 FROM ${quoted(table)} WHERE ${columns.map(column => `${quoted(column)}=?`).join(' OR ')} LIMIT 1`).get(...columns.map(() => user))) return true;
  return !!candidate.prepare(`SELECT 1 FROM music_legacy_identity WHERE table_name='link_audit' AND
    (json_extract(payload_json,'$.before_user_id')=? OR json_extract(payload_json,'$.after_user_id')=? OR json_extract(payload_json,'$.actor')=?) LIMIT 1`).get(user,user,'account:'+user)
    || !!candidate.prepare('SELECT 1 FROM music_ownership_history WHERE before_user_id=? OR after_user_id=? OR actor_ref=? LIMIT 1').get(user,user,'account:'+user)
    || !!candidate.prepare('SELECT 1 FROM music_pin_history WHERE user_id=? OR actor_ref=? LIMIT 1').get(user,'account:'+user);
}
type TableEvidence = { source: number; target: number; preserved: number; redacted: number; erased: number; replayed: number; sourceDigest: string; targetDigest: string; comparisonDigest: string };

/** Source and expected are private snapshot copies; candidate has no live writers.
 * Expected must be a fresh frozen source copy, used once and then discarded. */
export function reconcileBoard(source: DB, expected: DB, candidate: DB, entries: StoredIntent[]) {
  equal(schemaObjects(source),boardSchema.source); equal(schemaObjects(expected),boardSchema.source);
  equal(schemaObjects(candidate).filter(row=>boardTables.includes(row.tbl_name)),boardSchema.target);
  const erasureRequests=verifyErasureMarkers(candidate,entries);
  expected.pragma('foreign_keys = ON');
  const revoked = expected.transaction(()=>projectClosures(expected,entries)).immediate();
  for (const {user_id:user} of expected.prepare('SELECT user_id FROM privacy_requests').all() as {user_id:string}[]) {
    if (hasSharedHistory(candidate,user)) expected.prepare("UPDATE privacy_requests SET status='shared_review' WHERE user_id=?").run(user);
  }
  const evidence: Record<string,TableEvidence> = {};
  const mapping = candidate.prepare("SELECT target_id,source_revision,payload_digest,status FROM migration_map WHERE source=? AND entity_type=? AND source_id=?");
  let sourceTotal=0,replayedTotal=0;
  for (const table of boardTables) {
    equal(source.pragma(`table_xinfo(${quoted(table)})`),candidate.pragma(`table_xinfo(${quoted(table)})`));
    equal(source.pragma(`foreign_key_list(${quoted(table)})`),candidate.pragma(`foreign_key_list(${quoted(table)})`));
    const keys=boardPrimaryKeys(source,table), sourceHash=createHash('sha256'),targetHash=createHash('sha256'),comparisonHash=createHash('sha256');
    const item:TableEvidence={source:0,target:0,preserved:0,redacted:0,erased:0,replayed:0,sourceDigest:'',targetDigest:'',comparisonDigest:''};
    const expectedRead=expected.prepare(`SELECT rowid AS __source_rowid__,* FROM ${quoted(table)} WHERE rowid=?`).safeIntegers(true);
    for(const row of boardRows(source,table)){
      item.source++; sourceHash.update(canonical(row)+'\n');
      const payload=boardPayload(row),id=boardId(row,keys),after=expectedRead.get(row.__source_rowid__) as Row|undefined;
      const status=!after?'erased':canonical(payload)===canonical(boardPayload(after))?'preserved':'erasure_redacted';
      equal(mapping.get('board',table,id),{target_id:id,source_revision:canonical(payload.revision??payload.version??''),payload_digest:digest(canonical(payload)),status});
      if(status==='erased')item.erased++;else if(status==='preserved')item.preserved++;else item.redacted++;
    }
    const expectedRows=boardRows(expected,table),sourceRead=source.prepare(`SELECT 1 FROM ${quoted(table)} WHERE rowid=?`);
    for(const actual of boardRows(candidate,table)){
      const next=expectedRows.next(); if(next.done)reject(); const wanted=next.value;
      targetHash.update(canonical(actual)+'\n');
      if(table==='users'&&revoked.has(String(actual.id))){
        if(typeof actual.token_hash!=='string'||!/^[a-f0-9]{64}$/.test(actual.token_hash)||source.prepare('SELECT 1 FROM users WHERE token_hash=?').get(actual.token_hash))reject();
        actual.token_hash=wanted.token_hash;
      }
      equal(actual,wanted); comparisonHash.update(canonical(actual)+'\n'); item.target++;
      if(!sourceRead.get(actual.__source_rowid__)){
        item.replayed++;
        const payload=boardPayload(actual),id=boardId(actual,keys);
        equal(mapping.get('erasure',table,id),{target_id:id,source_revision:'',payload_digest:digest(canonical(payload)),status:'replayed'});
      }
    }
    if(!expectedRows.next().done)reject();
    item.sourceDigest=sourceHash.digest('hex');item.targetDigest=targetHash.digest('hex');item.comparisonDigest=comparisonHash.digest('hex');
    sourceTotal+=item.source;replayedTotal+=item.replayed;evidence[table]=item;
  }
  equal(candidate.prepare("SELECT count(*) n FROM migration_map WHERE source='board'").get(),{n:sourceTotal});
  equal(candidate.prepare("SELECT count(*) n FROM migration_map WHERE source='erasure'").get(),{n:replayedTotal});
  const sequences=(db:DB)=>db.prepare('SELECT name,seq FROM sqlite_sequence ORDER BY name').safeIntegers(true).all() as {name:string;seq:bigint}[];
  const wanted=sequences(expected).filter(row=>boardTables.includes(row.name)),actual=sequences(candidate).filter(row=>boardTables.includes(row.name));equal(actual,wanted);
  if((expected.pragma('foreign_key_check') as unknown[]).length||expected.pragma('integrity_check',{simple:true})!=='ok')reject();
  return {version:1,verified:true,tableCount:boardTables.length,sourceRows:sourceTotal,replayedRows:replayedTotal,revokedTokens:revoked.size,erasureRequests,
    schemaDigest:digest(canonical(boardSchema.target)),sequenceDigest:digest(canonical(actual)),tables:evidence};
}
