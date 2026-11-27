import type { DB } from '@qgroup/database';
import { MusicEntryNames } from '@qgroup/contracts';
import { DomainError, emptyMusicNames, musicChineseKey, musicEntryKey, musicNameAliases, musicNameValues, musicText, type MusicNames } from '@qgroup/domain';
import { withApiError } from './error-display';
import { Converter } from 'opencc-js';
const toHans=Converter({from:'tw',to:'cn'}),toHant=Converter({from:'cn',to:'tw'});
/** Display fallbacks belong to the response, never to the editable names. */
export const musicEntryTranslations=(names:MusicNames)=>({zhHant:names.zhHant||toHant(names.zhHans),zhHans:names.zhHans||toHans(names.zhHant)});

/** Extension documents retain the v15 storage contract and full SQLite backups. */
export function musicEntryNames(db:DB) {
  const result=new Map<string,MusicNames>();
  for(const row of db.prepare("SELECT payload_json FROM music_documents WHERE kind='entry_names' ORDER BY position").all() as {payload_json:string}[]) {
    const raw=JSON.parse(row.payload_json) as {entryId:string;names:unknown};
    if(typeof raw.entryId!=='string'||result.has(raw.entryId))throw Error('Invalid music entry name document');
    result.set(raw.entryId,MusicEntryNames.parse(raw.names));
  }
  return result;
}
export function removeMusicEntryNames(db:DB,id:string) {
  db.prepare("DELETE FROM music_documents WHERE kind='entry_names' AND json_extract(payload_json,'$.entryId')=?").run(id);
}
export function saveMusicEntryNames(db:DB,id:string,names:MusicNames) {
  if(names.aliases.length>32)throw withApiError(new DomainError('ENTRY_ALIAS_LIMIT','其他別名最多 32 項；請先整理別名再保存或合併'));
  MusicEntryNames.parse(names);
  const payload=JSON.stringify({entryId:id,names}), existing=db.prepare("SELECT position FROM music_documents WHERE kind='entry_names' AND json_extract(payload_json,'$.entryId')=?").get(id) as {position:number}|undefined;
  if(existing)db.prepare("UPDATE music_documents SET payload_json=? WHERE kind='entry_names' AND position=?").run(payload,existing.position);
  else {
    const maximum=(db.prepare("SELECT max(position) AS n FROM music_documents WHERE kind='entry_names'").get() as {n:number|null}).n??-1;
    if(!Number.isSafeInteger(maximum)||maximum>=Number.MAX_SAFE_INTEGER)throw Error('Music entry name positions exhausted');
    db.prepare("INSERT INTO music_documents VALUES('entry_names',?,?)").run(maximum+1,payload);
  }
}
export function normalizeMusicEntryNames(input:MusicNames|undefined,before:{name:string;aliases:readonly string[];names?:MusicNames}|undefined,name:string,entries:readonly {id:string;name:string;aliases:readonly string[]}[],id?:string) {
  const value=input??before?.names??{...emptyMusicNames(),aliases:before?.aliases??[]};
  const clean=(text:string)=>{
    const result=musicText(text);
    if(Array.from(result).length>96||/[\x00-\x1f\x7f]/.test(result))throw withApiError(new DomainError('ENTRY_LABEL','譯名、讀音及別名最多 96 字，不可包含控制字元'));
    return result;
  };
  const aliases=[...value.aliases];
  // A correction keeps the previous identity searchable, including older clients.
  if(before&&musicEntryKey(before.name)!==musicEntryKey(name))aliases.push(before.name);
  const names={zhHant:clean(value.zhHant),zhHans:clean(value.zhHans),english:clean(value.english),reading:clean(value.reading),romaji:clean(value.romaji),aliases:[] as string[]};
  const seen=new Set([musicEntryKey(name),...musicNameValues(names).map(musicEntryKey)]);
  for(const raw of aliases){const alias=clean(raw),key=musicEntryKey(alias);if(!key||seen.has(key))continue;seen.add(key);names.aliases.push(alias);}
  if(names.aliases.length>32)throw withApiError(new DomainError('ENTRY_ALIAS_LIMIT','其他別名最多 32 項'));
  const originalKeys=new Set(before?[before.name,...before.aliases].map(musicChineseKey):[]);
  for(const candidate of [name,...musicNameAliases(name,names)]) {
    const key=musicChineseKey(candidate);
    // Existing imported aliases may overlap. Preserve them; reject newly introduced collisions.
    if(originalKeys.has(key))continue;
    const duplicate=entries.find(entry=>entry.id!==id&&[entry.name,...entry.aliases].some(label=>musicChineseKey(label)===key));
    if(duplicate)throw new DomainError('ENTRY_EXISTS','名稱或別名已屬於「'+duplicate.name+'」，請編輯既有詞條或合併',409);
  }
  return names;
}
