import {musicProfileActiveSQL} from '@qgroup/database';
import type { DB } from '@qgroup/database';
import { keys, object, profileId, parseJson, stringifyJson, type Json, type ObjectValue } from '../../../packages/database/src/legacy-music-codec';
import type { StoredIntent } from './erasure-journal';

const memberFields = ['qq','name','consent','selection','created','createdAt','pinHash','lastJoinAt','boardUserId','gender','genderPublic','note','noteAt','lastShoutAt','contactQQ'];
function list(value: Json | undefined) { if (value === undefined) return []; if (!Array.isArray(value)) throw Error('Invalid historical list'); return value; }
/** Historical JSON is data, never an identity source or restoration package.
 * Legacy files have no unified applied markers: replay scoped IDs, never infer
 * completion from a filename, nickname, mtime or clock. */
export function exportLegacyMusic(raw: Json, db: DB, intents: StoredIntent[], legacyErased: ReadonlySet<string>) {
  const data = object(parseJson(stringifyJson(object(raw, 'historical music'))), 'historical music');
  keys(data, ['entries','members','settings','shouts','shoutHistory','trend'], 'historical music');
  const entries = object(data.entries, 'historical entries'), members = object(data.members, 'historical members');
  const erasedKeys = new Set([...legacyErased, ...(db.prepare('SELECT legacy_key FROM music_legacy_erasures').all() as {legacy_key:string}[]).map(row=>row.legacy_key)]);
  const erasedIds = new Set((db.prepare('SELECT id FROM music_profiles WHERE erased_at IS NOT NULL').all() as {id:string}[]).map(row=>row.id));
  for(const key of erasedKeys)erasedIds.add(profileId(key));
  const erasedEntries = new Set<string>(); let resetHistory = false;
  for (const intent of intents) if ('version' in intent) {
    if (intent.version === 2) {
      intent.profiles.forEach(row=>erasedIds.add(row.id));
      if (intent.command === 'reset_music') { resetHistory = true; intent.entries.forEach(id=>erasedEntries.add(id)); }
    } else if(intent.version===3){erasedKeys.add(intent.legacyKey);erasedIds.add(intent.profileId);}
    else if (intent.kind !== 'account' && intent.profileId) erasedIds.add(intent.profileId);
  }
  const removed = (key: string) => erasedKeys.has(key) || erasedIds.has(key) || erasedIds.has(profileId(key));
  for (const [key,value] of Object.entries(entries)) {
    const entry = object(value, 'historical entry');
    keys(entry, ['id','text','kind','category','aliases','createdAt','updatedAt','createdBy'], 'historical entry');
    if (entry.id !== key || typeof entry.text !== 'string' || (entry.createdBy !== undefined && typeof entry.createdBy !== 'string')) throw Error('Invalid historical entry');
    for(const field of ['kind','category'])if(entry[field]!==undefined&&typeof entry[field]!=='string')throw Error('Invalid historical entry field');
    for(const field of ['createdAt','updatedAt'])if(entry[field]!==undefined&&entry[field]!==null&&typeof entry[field]!=='number'&&typeof entry[field]!=='string')throw Error('Invalid historical entry time');
    if (list(entry.aliases).some(alias=>typeof alias !== 'string')) throw Error('Invalid historical aliases');
    if (erasedEntries.has(key)) delete entries[key];
    else if (typeof entry.createdBy === 'string' && removed(entry.createdBy)) entry.createdBy = '';
  }
  for (const [key,value] of Object.entries(members)) {
    const member = object(value, 'historical member'); keys(member, memberFields, 'historical member');
    if (member.qq !== key || !/^(?:[0-9]{4,12}|m_[a-f0-9]{24})$/.test(key)) throw Error('Invalid historical member key');
    for (const field of ['name','pinHash','boardUserId','contactQQ','gender','note']) if (member[field] !== undefined && typeof member[field] !== 'string') throw Error('Invalid historical member field');
    for(const field of ['consent','genderPublic'])if(member[field]!==undefined&&typeof member[field]!=='boolean')throw Error('Invalid historical member flag');
    for(const field of ['createdAt','lastJoinAt','noteAt','lastShoutAt'])if(member[field]!==undefined&&member[field]!==null&&typeof member[field]!=='number'&&typeof member[field]!=='string')throw Error('Invalid historical member time');
    if (removed(key)) { delete members[key]; continue; }
    member.selection = list(member.selection).filter(value=>{
      if (typeof value === 'string') return !erasedEntries.has(value);
      const item = object(value, 'historical selection'); keys(item, ['id','entryId','level'], 'historical selection');
      for(const field of ['id','entryId'])if(item[field]!==undefined&&typeof item[field]!=='string')throw Error('Invalid historical selection ID');
      if(item.level!==undefined&&item.level!==null&&!['number','string','boolean'].includes(typeof item.level))throw Error('Invalid historical selection level');
      return !erasedEntries.has(String(item.id || item.entryId || ''));
    });
    member.created = list(member.created).filter(id=>{ if(typeof id !== 'string')throw Error('Invalid historical creation');return !erasedEntries.has(id); });
    const live = db.prepare(`SELECT p.id,p.user_id,l.pin_hash FROM music_profiles p JOIN music_legacy_profiles l ON l.profile_id=p.id
      WHERE l.legacy_key=? AND ${musicProfileActiveSQL('p')}`).get(key) as {id:string;user_id:string|null;pin_hash:string}|undefined;
    const contact = live && db.prepare('SELECT contact_qq FROM music_profile_contacts WHERE profile_id=?').get(live.id) as {contact_qq:string}|undefined;
    member.boardUserId = live?.user_id ?? '';
    member.pinHash = live?.pin_hash ?? '';
    member.contactQQ = contact?.contact_qq ?? '';
  }
  for (const kind of ['shouts','shoutHistory'] as const) {
    const values = list(data[kind]).filter(value=>{
      const shout = object(value, 'historical shout'); keys(shout, ['id','qq','name','text','createdAt','archivedAt'], 'historical shout');
      if (typeof shout.qq !== 'string' || typeof shout.text !== 'string') throw Error('Invalid historical shout');
      for(const field of ['id','name'])if(shout[field]!==undefined&&typeof shout[field]!=='string')throw Error('Invalid historical shout field');
      for(const field of ['createdAt','archivedAt'])if(shout[field]!==undefined&&shout[field]!==null&&typeof shout[field]!=='number'&&typeof shout[field]!=='string')throw Error('Invalid historical shout time');
      return !removed(shout.qq);
    });
    data[kind] = resetHistory ? [] : values;
  }
  const trend = list(data.trend); for (const value of trend) {
    const point=object(value,'historical trend');keys(point,['t','counts'],'historical trend');
    if(typeof point.t!=='number'||Object.values(object(point.counts,'historical trend counts')).some(count=>typeof count!=='number'))throw Error('Invalid historical trend');
  }
  data.trend = resetHistory ? [] : trend;
  keys(object(data.settings ?? {}, 'historical settings'), ['adminPasswordHash'], 'historical settings');
  data.settings = {};
  return data as ObjectValue;
}
