import { digest, parseJson, type Json } from '../../runtime/src/strict-json';
export { digest, parseJson, type Json, type ObjectValue } from '../../runtime/src/strict-json';
import { seedMusicFields, seedMusicShouts, type DB } from '@qgroup/database';
import { assertIdentitySchema } from './legacy-identity-source';

import type { ObjectValue } from '../../runtime/src/strict-json';
export const profileId = (key: string) => 'm_' + digest('qgroup:legacy-music-profile:v1:' + key).slice(0, 40);
export function object(value: Json | undefined, label: string): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid object: ' + label);
  return value;
}
export function keys(value: ObjectValue, allowed: string[], label: string) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unclassified fields: ' + label);
}
function text(value: Json | undefined, label: string, fallback = '') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new Error('Invalid string: ' + label);
  return value;
}
function list(value: Json | undefined, label: string): Json[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Invalid list: ' + label);
  return value;
}
export type Identity = Record<string, ObjectValue[]>;
const memberFields = ['qq', 'name', 'consent', 'selection', 'created', 'createdAt', 'pinHash', 'lastJoinAt', 'boardUserId', 'gender', 'genderPublic', 'note', 'noteAt', 'lastShoutAt', 'contactQQ'];
const identityColumns: Record<string, string[]> = {
  sessions: ['token_hash', 'qq', 'expires', 'source_session', 'pending_until'], links: ['qq', 'app_id', 'openid', 'user_id', 'created', 'source'],
  prelinks: ['qq', 'user_id', 'created'], link_overrides: ['qq', 'user_id', 'revision', 'updated'], link_audit: ['id', 'qq', 'actor', 'before_user_id', 'after_user_id', 'created'],
  native_profiles: ['qq', 'payload'], profile_contacts: ['qq', 'number', 'updated'], entry_intents: ['token_hash', 'qq', 'source_session', 'target_user_id', 'payload', 'expires'],
  login_attempts: ['bucket', 'created'], used_oauth: ['attempt', 'created'],
};
export function readIdentity(db: DB): Identity {
  assertIdentitySchema(db);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  if (tables.map(row => row.name).join() !== Object.keys(identityColumns).sort().join()) throw new Error('Unsupported music identity tables');
  return Object.fromEntries(tables.map(({ name }) => {
    const columns = db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[];
    if (columns.map(row => row.name).join() !== identityColumns[name]!.join()) throw new Error('Unsupported music identity columns');
    const rawRows = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).safeIntegers(true).all() as Record<string, unknown>[];
    const rows = rawRows.map(row => Object.fromEntries(Object.entries(row).map(([column, raw]) => {
      let value = raw;
      if (typeof value === 'bigint') {
        if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('Unsafe music identity integer; explicit representation review required');
        value = Number(value);
      }
      if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) throw new Error('Unsupported music identity storage value');
      return [column, value];
    }))) as ObjectValue[];
    for (const row of rows) { keys(row, identityColumns[name]!, 'identity'); if (row.payload !== undefined) parseJson(text(row.payload, 'identity payload')); }
    return [name, rows];
  }));
}
export function musicErasures(source: string) {
  if (source && !source.endsWith('\n')) throw new Error('Incomplete music erasure ledger');
  const erased = new Map<string, Json>();
  for (const line of source.split('\n').filter(line => line.trim())) {
    const entry = object(parseJson(line), 'music erasure'); keys(entry, ['qq', 'erased_at'], 'music erasure');
    const key = text(entry.qq, 'music erasure key'); if (!key || key.length > 128) throw new Error('Invalid music erasure key');
    erased.set(key, entry.erased_at ?? null);
  }
  return erased;
}
export function projectMusic(raw: Json, originalIdentity: Identity, erased: Map<string, Json>, additionalErasedIds:ReadonlySet<string>=new Set()) {
  const data = structuredClone(object(raw, 'music root'));
  keys(data, ['entries', 'members', 'settings', 'shouts', 'shoutHistory', 'trend'], 'music root');
  const members = object(data.members, 'music members'); const entries = object(data.entries, 'music entries');
  const identity = Object.fromEntries(Object.entries(originalIdentity).map(([table, rows]) => [table, rows.filter(row => !erased.has(String(row.qq ?? '')))]));
  // The latest deletion ledger is applied before native recovery, never after it.
  for (const key of erased.keys()) delete members[key];
  for (const row of identity.native_profiles!) {
    const key = text(row.qq, 'native key'); const member = object(parseJson(text(row.payload, 'native payload')), 'native profile'); keys(member, memberFields, 'native profile');
    if (member.qq !== key) throw new Error('Native profile key mismatch');
    if (!Object.hasOwn(members, key)) Object.defineProperty(members, key, { value: member, enumerable: true, configurable: true, writable: true });
  }
  for (const row of identity.profile_contacts!) if (Object.hasOwn(members, String(row.qq))) object(members[String(row.qq)], 'member').contactQQ = row.number!;
  for (const table of ['link_overrides', 'prelinks', 'links']) for (const row of identity[table]!) if (Object.hasOwn(members, String(row.qq))) object(members[String(row.qq)], 'member').boardUserId = row.user_id!;
  const erasedIds=new Set([...erased.keys()].map(profileId));for(const id of additionalErasedIds)erasedIds.add(id);
  for (const entry of Object.values(entries)) { const item = object(entry, 'entry'); if (erased.has(String(item.createdBy ?? ''))||erasedIds.has(String(item.createdBy??''))) item.createdBy = ''; }
  for (const kind of ['shouts', 'shoutHistory']) data[kind] = list(data[kind], kind).filter(value => !erased.has(String(object(value, kind).qq ?? '')));
  return { data, identity };
}
export function importMusic(db: DB, raw: Json, sourceIdentity: Identity, erased: Map<string, Json>, stamp: string, additionalErasedIds:ReadonlySet<string>=new Set()) {
  const { data, identity } = projectMusic(raw, sourceIdentity, erased,additionalErasedIds);
  const original = object(raw, 'original music'); const originalEntries = object(original.entries, 'original entries'), originalMembers = object(original.members, 'original members');
  const members = object(data.members, 'members'); const entries = object(data.entries, 'entries');
  const map = db.prepare('INSERT INTO migration_map VALUES(?,?,?,?,?,?,?)');
  let owned = 0; let selections = 0;let entrySourcePosition=0;
  for (const [key, value] of Object.entries(entries)) {
    const entry = object(value, 'entry'); keys(entry, ['id', 'text', 'kind', 'category', 'aliases', 'createdAt', 'updatedAt', 'createdBy'], 'entry');
    if (text(entry.id, 'entry id') !== key || !key || key.length > 80) throw new Error('Entry key does not match stable ID');
    const kind = ['main', 'sub'].includes(String(entry.kind)) ? entry.kind! : entry.category === '领域' ? 'main' : 'sub';
    db.prepare('INSERT INTO music_entries VALUES(?,?,?)').run(key, text(entry.text, 'entry text'), kind);
    const aliases = list(entry.aliases, 'aliases'); if (aliases.some(alias => typeof alias !== 'string')) throw new Error('Invalid aliases');
    db.prepare('INSERT INTO music_entry_details VALUES(?,?,?,?,?,?)').run(key, text(entry.category, 'category', '其他'), JSON.stringify(aliases), text(entry.createdBy, 'entry creator'), JSON.stringify(entry.createdAt ?? 0), JSON.stringify(entry.updatedAt ?? null));
    db.prepare('INSERT INTO music_documents VALUES(?,?,?)').run('entry_source',entrySourcePosition++,JSON.stringify({entryId:key,entry}));
    const sourceEntry = JSON.stringify(originalEntries[key]);
    map.run('music', 'entry', key, key, '', digest(sourceEntry), sourceEntry === JSON.stringify(entry) ? 'preserved' : 'erasure_redacted');
  }
  const owners = new Set<string>(); const contacts = new Set<string>(); let sourcePosition=0;
  for (const [key, value] of Object.entries(members)) {
    const member = object(value, 'member');
    keys(member, memberFields, 'member');
    if (text(member.qq, 'member key') !== key || !/^(?:[0-9]{4,12}|m_[a-f0-9]{24})$/.test(key)) throw new Error('Unsupported legacy member key');
    const links = identity.links!.filter(row => row.qq === key); const prelinks = identity.prelinks!.filter(row => row.qq === key);
    const mappings = new Set([...links, ...prelinks].map(row => text(row.user_id, 'owner')));
    if (links.length > 1 || prelinks.length > 1 || mappings.size > 1) throw new Error('Conflicting effective music ownership');
    let userId = [...mappings][0] ?? ''; let ownership = links.length ? 'oauth' : prelinks.length ? 'prelinked' : 'unlinked';
    const projected = text(member.boardUserId, 'projected owner');
    if (!userId && projected) throw new Error('JSON-only ownership requires explicit review');
    if (links.some(link => !db.prepare("SELECT 1 FROM external_identities WHERE provider='qq' AND client_id=? AND subject=? AND user_id=?").get(link.app_id, link.openid, userId)) && !db.prepare('SELECT 1 FROM privacy_requests WHERE user_id=?').get(userId)) throw new Error('OAuth music identity does not match board account');
    if (userId && !db.prepare('SELECT 1 FROM users WHERE id=?').get(userId)) throw new Error('Music owner is missing from board');
    if (userId && db.prepare('SELECT 1 FROM privacy_requests WHERE user_id=?').get(userId)) { userId = ''; ownership = 'closed_account'; }
    if (userId) { if (owners.has(userId)) throw new Error('Duplicate effective music owner'); owners.add(userId); owned++; }
    const contact = /^[0-9]{4,12}$/.test(key) ? key : text(member.contactQQ, 'contact');
    if (contact && (!/^[0-9]{4,12}$/.test(contact) || contacts.has(contact))) throw new Error('Conflicting contact alias');
    if (contact) contacts.add(contact);
    const id = profileId(key);
    db.prepare('INSERT INTO music_profiles(id,user_id,revision,updated_at) VALUES(?,?,0,?)').run(id, userId || null, stamp);
    const fields = Object.fromEntries(Object.entries(member).filter(([field]) => !['qq', 'name', 'consent', 'selection', 'created', 'pinHash', 'boardUserId', 'contactQQ'].includes(field)));
    const created = list(member.created, 'created entries'); if (created.some(item => typeof item !== 'string' || !Object.hasOwn(entries, item))) throw new Error('Unresolved created entry');
    if (member.consent !== undefined && typeof member.consent !== 'boolean') throw new Error('Invalid music consent');
    db.prepare('INSERT INTO music_legacy_profiles VALUES(?,?,?,?,?,?,?,?,?)').run(id, key, text(member.name, 'member name'), Number(member.consent ?? false), text(member.pinHash, 'PIN hash'), contact, JSON.stringify(fields), JSON.stringify(created), ownership);
    db.prepare('INSERT INTO music_profile_contacts VALUES(?,?,?,0,?)').run(id, contact, /^[0-9]{4,12}$/.test(key) ? 'legacy' : 'self_reported', stamp);
    const seen = new Set<string>(); let position = 0;
    for (const item of list(member.selection, 'selections')) {
      let entryId: string; let level = 3;
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        keys(item, ['id', 'entryId', 'level'], 'selection'); entryId = String(item.id || item.entryId || '');
        const number = typeof item.level === 'number' ? Math.trunc(item.level) : typeof item.level === 'string' && /^[+-]?\d+$/.test(item.level.trim()) ? Number(item.level) : item.level === true ? 1 : 3;
        level = Math.max(1, Math.min(4, item.level ? number : 3));
      } else entryId = text(item, 'selection id');
      if (!entryId || seen.has(entryId)) continue;
      seen.add(entryId); if (!Object.hasOwn(entries, entryId)) throw new Error('Unresolved selection entry');
      db.prepare('INSERT INTO music_selections VALUES(?,?,?,?)').run(id, entryId, level, position++); selections++;
    }
    const native = sourceIdentity.native_profiles!.find(row => row.qq === key);
    const sourceMember = Object.hasOwn(originalMembers,key) ? originalMembers[key]! : parseJson(text(native?.payload,'native source'));
    // Private, inactive source evidence retains duplicate choices, original
    // fields and overridden projections. It never authenticates an account.
    db.prepare('INSERT INTO music_documents VALUES(?,?,?)').run('profile_source',sourcePosition++,JSON.stringify({profileId:id,legacyKey:key,source:Object.hasOwn(originalMembers,key)?'json':'native',member:sourceMember}));
    map.run('music', 'profile', key, id, '', digest(JSON.stringify(sourceMember)), 'preserved');
  }
  for (const [table, rows] of Object.entries(sourceIdentity)) rows.forEach((row, index) => {
    // Preserved as private migration evidence; never accepted as new authentication.
    const removed = erased.has(String(row.qq ?? ''));
    if (!removed) db.prepare('INSERT INTO music_legacy_identity VALUES(?,?,?)').run(table, index, JSON.stringify(row));
    if (!removed && table === 'login_attempts') {
      if (typeof row.bucket !== 'string' || !/^(?:qq|ip):[a-f0-9]{64}$/.test(row.bucket) || typeof row.created !== 'number' || !Number.isFinite(row.created) || row.created < 0 || row.created > Number.MAX_SAFE_INTEGER) throw new Error('Invalid legacy PIN rate bucket');
      db.prepare('INSERT INTO music_claim_attempts VALUES(?,?)').run(row.bucket, row.created);
    }
    const orphan = row.qq !== undefined && !Object.hasOwn(members, String(row.qq));
    map.run('music-identity', table, String(index), table + ':' + index, '', digest(JSON.stringify(row)), removed ? 'erased' : orphan ? 'requires_legacy_review' : ['sessions', 'entry_intents'].includes(table) ? 'requires_legacy_adapter' : 'preserved');
  });
  for (const kind of ['settings', 'shouts', 'shoutHistory', 'trend']) {
    const documents = kind === 'settings' ? [object(original[kind] ?? {}, kind)] : list(original[kind], kind);
    documents.forEach((payload, index) => {
      if (kind === 'settings') keys(object(payload, kind), ['adminPasswordHash'], kind);
      if (kind === 'shouts' || kind === 'shoutHistory') keys(object(payload, kind), ['id', 'qq', 'name', 'text', 'createdAt', 'archivedAt'], kind);
      if (kind === 'trend') keys(object(payload, kind), ['t', 'counts'], kind);
      const removed = ['shouts', 'shoutHistory'].includes(kind) && erased.has(String(object(payload, kind).qq ?? ''));
      if (!removed) db.prepare('INSERT INTO music_documents VALUES(?,?,?)').run(kind, index, JSON.stringify(payload));
      map.run('music', kind, String(index), kind + ':' + index, '', digest(JSON.stringify(payload)), removed ? 'erased' : kind === 'settings' ? 'inactive_legacy_credential' : 'preserved');
    });
  }
  for (const [key, time] of erased) {
    db.prepare('INSERT INTO music_legacy_erasures VALUES(?,?)').run(key, JSON.stringify(time));
    db.prepare('INSERT INTO music_profiles(id,user_id,revision,updated_at,erased_at) VALUES(?,NULL,0,?,?) ON CONFLICT(id) DO NOTHING').run(profileId(key), stamp, stamp);
    const native = sourceIdentity.native_profiles!.find(row => row.qq === key);
    const sourceMember = Object.hasOwn(originalMembers,key) ? originalMembers[key]! : native ? parseJson(text(native.payload,'native source')) : undefined;
    map.run('music', 'profile', key, profileId(key), '', sourceMember===undefined?'':digest(JSON.stringify(sourceMember)), 'erased');
  }
  seedMusicFields(db);
  seedMusicShouts(db);
  return { entries: Object.keys(entries).length, profiles: Object.keys(members).length, owned, selections, erased: erased.size };
}
