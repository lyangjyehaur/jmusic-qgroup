import {musicProfileActiveSQL} from '@qgroup/database';
import type { DB } from '@qgroup/database';
import { musicCreatedIds } from '@qgroup/database';
import { profileFields } from './music-fields';

type RecordValue = Record<string, unknown>;
type Profile = { id: string; user_id: string | null; legacy_key: string | null; consent: number | null; pin_hash: string | null; fields_json: string | null; created_at: string | null };
const records = <T>(pairs: [string, T][]) => Object.fromEntries(pairs);
function profiles(db: DB) {
  return db.prepare(`SELECT p.id,p.user_id,l.legacy_key,l.consent,l.pin_hash,l.fields_json,c.created_at
    FROM music_profiles p LEFT JOIN music_legacy_profiles l ON l.profile_id=p.id
    LEFT JOIN music_profile_creation c ON c.profile_id=p.id WHERE ${musicProfileActiveSQL('p')} ORDER BY p.rowid`).all() as Profile[];
}
/** Administrative data export, never an authentication or complete restore package. */
export function exportMusic(db: DB, latest: DB = db) {
  const current = new Map(profiles(latest).map(row => [row.id, row]));
  const erasedKeys = new Set((latest.prepare('SELECT legacy_key FROM music_legacy_erasures').all() as { legacy_key: string }[]).map(row => row.legacy_key));
  const erasedIds = new Set((latest.prepare('SELECT id FROM music_profiles WHERE erased_at IS NOT NULL').all() as { id: string }[]).map(row => row.id));
  const rows = profiles(db).filter(row => !erasedIds.has(row.id) && !erasedKeys.has(row.legacy_key ?? row.id));
  const keyFor = new Map(rows.map(row => [row.id, row.legacy_key ?? row.id]));
  const creator = (key: string) => erasedIds.has(key) || erasedKeys.has(key) ? '' : keyFor.get(key) ?? key;
  const entries = records((db.prepare(`SELECT e.id,e.name,e.kind,d.category,d.aliases_json,d.created_by,d.created_at_json,d.updated_at_json
    FROM music_entries e LEFT JOIN music_entry_details d ON d.entry_id=e.id ORDER BY e.rowid`).all() as {
    id: string; name: string; kind: string; category: string | null; aliases_json: string | null; created_by: string | null; created_at_json: string | null; updated_at_json: string | null;
  }[]).map(row => [row.id, { id: row.id, text: row.name, kind: row.kind, category: row.category ?? (row.kind === 'main' ? '领域' : '其他'),
    aliases: JSON.parse(row.aliases_json ?? '[]') as unknown, createdBy: creator(row.created_by ?? ''),
    createdAt: JSON.parse(row.created_at_json ?? '0') as unknown, updatedAt: JSON.parse(row.updated_at_json ?? 'null') as unknown }]));
  const members = records(rows.map(row => {
    const fields: RecordValue = row.fields_json === null ? {} : JSON.parse(row.fields_json) as RecordValue;
    const info = profileFields(db, row.id), live = current.get(row.id);
    const contact = live&&latest.prepare('SELECT contact_qq FROM music_profile_contacts WHERE profile_id=?').get(row.id) as { contact_qq: string } | undefined;
    const last = db.prepare('SELECT last_post_at FROM music_shout_authors WHERE profile_id=?').get(row.id) as { last_post_at: number } | undefined;
    const selections = db.prepare('SELECT entry_id AS id,level FROM music_selections WHERE profile_id=? ORDER BY position').all(row.id);
    // Latest identity and explicit empty contacts override every historical copy.
    return [keyFor.get(row.id)!, { ...fields, qq: keyFor.get(row.id), name: info.name, consent: row.consent === null ? true : !!row.consent,
      selection: selections, created: musicCreatedIds(db, row.id).filter(id => Object.hasOwn(entries, id)),
      pinHash: live?.pin_hash ?? '', boardUserId: live?.user_id ?? '', contactQQ: contact?.contact_qq ?? '',
      note: info.note, noteAt: info.noteAt, gender: info.gender, genderPublic: info.genderPublic,
      ...(row.created_at && Number.isFinite(Date.parse(row.created_at)) ? { createdAt: Date.parse(row.created_at) / 1000 } : {}), ...(last ? { lastShoutAt: last.last_post_at } : {}) }];
  }));
  const shouts: RecordValue[] = [], shoutHistory: RecordValue[] = [];
  for (const row of db.prepare('SELECT * FROM music_shouts ORDER BY ordinal').all() as { id: string; profile_id: string | null; legacy_key: string; name: string; body: string; created_at: number; archived_at: number | null }[]) {
    if (row.profile_id && !keyFor.has(row.profile_id) || erasedKeys.has(row.legacy_key) || erasedIds.has(row.legacy_key)) continue;
    const value = { id: row.id, qq: row.profile_id ? keyFor.get(row.profile_id)! : row.legacy_key, name: row.name, text: row.body, createdAt: row.created_at,
      ...(row.archived_at === null ? {} : { archivedAt: row.archived_at }) };
    (row.archived_at === null ? shouts : shoutHistory).push(value);
  }
  const trend = (db.prepare("SELECT payload_json FROM music_documents WHERE kind IN ('trend','trend_sample') ORDER BY CASE kind WHEN 'trend' THEN 0 ELSE 1 END,position").all() as { payload_json: string }[]).map(row => JSON.parse(row.payload_json) as unknown);
  // Do not dump music_documents.settings: it retains an inactive legacy admin hash.
  return { entries, members, settings: {}, shouts, shoutHistory, trend };
}
