import { createHash } from 'node:crypto';
import {musicProfileActiveSQL,readMusicRetirements,type DB} from '@qgroup/database';
import { readVerifiedErasureJournal, type ErasureJournal } from '../../apps/api/src/erasure-journal';
import { assertRollbackSource } from './rollback-source';
import { keys, object, parseJson, jsonObjectKeys, jsonObjectFromEntries, type Json, type ObjectValue } from './music-codec';
import { readSourceRebaseEvidence } from './source-rebase-evidence';
import { verifyRollbackMusic } from './rollback-music-reconciliation';

export type RollbackMusicKey={profileId:string;legacyKey:string;mode:'preserved'|'generated';erased:boolean;retired?:true};
export type RollbackMusic={data:ObjectValue;keys:RollbackMusicKey[]};
const oldKey=/^(?:[0-9]{4,12}|m_[a-f0-9]{24})$/;
const generated=(id:string)=>'m_'+createHash('sha256').update('qgroup:rollback-music-key:v1:'+id).digest('hex').slice(0,24);
const stringify=(value:unknown):string=>JSON.stringify(value,(_key,item:unknown)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item);
const same=(a:unknown,b:unknown)=>stringify(a)===stringify(b);
const array=(value:Json|undefined):Json[]=>{if(value===undefined)return [];if(!Array.isArray(value))throw Error('Invalid rollback source array');return value;};
const entryFields=['id','text','kind','category','aliases','createdBy','createdAt','updatedAt'];
const memberFields=['qq','name','consent','selection','created','createdAt','pinHash','lastJoinAt','boardUserId','gender','genderPublic','note','noteAt','lastShoutAt','contactQQ'];
function strings(values:unknown[]){if(values.some(value=>value!==null&&typeof value!=='string'))throw Error('Unsupported rollback music string storage');}
function time(value:unknown){if(typeof value!=='number'||!Number.isFinite(value)||Math.abs(value)>Number.MAX_SAFE_INTEGER)throw Error('Unrepresentable rollback music time');}
function choices(value:Json|undefined){
  const seen=new Set<string>(),out:{id:string;level:number}[]=[];
  for(const item of array(value)){
    let id:string,level=3;
    if(item&&typeof item==='object'&&!Array.isArray(item)){
      keys(item,['id','entryId','level'],'rollback choice');id=String(item.id||item.entryId||'');
      const raw=item.level;
      const number=typeof raw==='number'?Math.trunc(raw):typeof raw==='string'&&/^[+-]?\d+$/.test(raw.trim())?Number(raw):raw===true?1:3;
      level=Math.max(1,Math.min(4,raw?number:3));
    }else{if(typeof item!=='string')throw Error('Invalid rollback choice ID');id=item;}
    if(id&&!seen.has(id)){seen.add(id);out.push({id,level});}
  }return out;
}
/** Preserve original representation whenever its effective value is unchanged. */
function patch(target:ObjectValue,field:string,current:Json,previous:Json|undefined){if(!same(current,previous))target[field]=current;}
export function rollbackMusicKeys(db:DB){
  const retired=new Map(readMusicRetirements(db).map(row=>[row.profileId,row]));
  const rebased=readSourceRebaseEvidence(db),bindings=new Map(rebased?.bindings.map(row=>[row.profileId,row]));
  const profiles=db.prepare('SELECT id,erased_at FROM music_profiles ORDER BY rowid').all() as {id:string;erased_at:string|null}[];
  const aliases=new Map<string,Set<string>>(),reserved=new Set<string>();
  const add=(id:string,key:string)=>{if(!oldKey.test(key))throw Error('Unsupported rollback legacy key');reserved.add(key);const names=aliases.get(id)??new Set<string>();names.add(key);aliases.set(id,names);};
  for(const row of db.prepare('SELECT profile_id,legacy_key FROM music_legacy_profiles').all() as {profile_id:string;legacy_key:string}[])add(row.profile_id,row.legacy_key);
  for(const row of db.prepare("SELECT target_id,source_id FROM migration_map WHERE source='music' AND entity_type='profile'").all() as {target_id:string;source_id:string}[])add(row.target_id,row.source_id);
  for(const row of db.prepare('SELECT legacy_key FROM music_legacy_erasures').all() as {legacy_key:string}[]){if(!oldKey.test(row.legacy_key))throw Error('Invalid rollback erased key');reserved.add(row.legacy_key);}
  const used=new Set<string>();return profiles.map(row=>{
    if(typeof row.id!=='string'||!/^m_(?:[a-f0-9]{32}|[a-f0-9]{40})$/.test(row.id))throw Error('Unsupported rollback profile ID');
    const names=aliases.get(row.id);if(names&&names.size!==1)throw Error('Ambiguous rollback profile key');
    const binding=bindings.get(row.id),mode=binding?.mode??(names?'preserved':'generated'),legacyKey=binding?.legacyKey??(names?[...names][0]!:generated(row.id));
    if(binding&&names&&[...names].some(name=>name!==binding.legacyKey))throw Error('Rollback rebased profile alias differs');
    if(used.has(legacyKey)||mode==='generated'&&reserved.has(legacyKey)&&!binding)throw Error('Rollback profile key collision');used.add(legacyKey);
    if(!row.erased_at&&db.prepare('SELECT 1 FROM music_legacy_erasures WHERE legacy_key=?').get(legacyKey))throw Error('Active rollback profile has an erased legacy key');
    if(retired.has(row.id)&&retired.get(row.id)!.legacyKey!==legacyKey)throw Error('Retired rollback profile alias differs');
    return {profileId:row.id,legacyKey,mode,erased:row.erased_at!==null,...(retired.has(row.id)?{retired:true as const}:{})} as RollbackMusicKey;
  });
}
/** Private component only. Identity SQLite, audits, assets, ledgers and a fixed
 * old-runtime rehearsal must accompany this JSON before rollback is eligible. */
export function projectRollbackMusic(db:DB,journal:ErasureJournal){
  if(db.inTransaction)throw Error('Rollback music projection requires a standalone source transaction');
  return db.transaction(()=>{
    assertRollbackSource(db);const intents=readVerifiedErasureJournal(db,journal),rebased=readSourceRebaseEvidence(db,intents);const mapping=rollbackMusicKeys(db),byId=new Map(mapping.map(row=>[row.profileId,row]));
    const erased=new Set(mapping.filter(row=>row.erased).flatMap(row=>[row.profileId,row.legacyKey]));
    for(const row of db.prepare('SELECT legacy_key FROM music_legacy_erasures').all() as {legacy_key:string}[])erased.add(row.legacy_key);
    const translate=(value:string)=>erased.has(value)?'':byId.get(value)?.legacyKey??value;
    const originalEntries=new Map<string,ObjectValue>(),originalProfiles=new Map<string,ObjectValue>(),originalShouts=new Map<string,{kind:string;value:ObjectValue}>();
    for(const row of db.prepare("SELECT kind,payload_json FROM music_documents WHERE kind IN ('entry_source','profile_source','shouts','shoutHistory') ORDER BY kind,position").all() as {kind:string;payload_json:string}[]){
      const doc=object(parseJson(row.payload_json),'rollback source');
      if(row.kind==='entry_source'){
        keys(doc,['entryId','entry'],'rollback entry source');const entry=object(doc.entry,'rollback entry');keys(entry,entryFields,'rollback entry');
        if(typeof doc.entryId!=='string'||entry.id!==doc.entryId||originalEntries.has(doc.entryId))throw Error('Ambiguous rollback entry source');originalEntries.set(doc.entryId,entry);
      }else if(row.kind==='profile_source'){
        keys(doc,['profileId','legacyKey','source','member'],'rollback profile source');const member=object(doc.member,'rollback member');keys(member,memberFields,'rollback member');
        if(typeof doc.profileId!=='string'||member.qq!==doc.legacyKey||originalProfiles.has(doc.profileId))throw Error('Ambiguous rollback profile source');originalProfiles.set(doc.profileId,member);
      }else{
        keys(doc,['id','qq','name','text','createdAt','archivedAt'],'rollback shout');if(typeof doc.id!=='string'||originalShouts.has(doc.id))throw Error('Ambiguous rollback shout source');originalShouts.set(doc.id,{kind:row.kind,value:doc});
      }
    }
    const entries: ObjectValue=jsonObjectFromEntries((db.prepare(`SELECT e.id,e.name,e.kind,d.category,d.aliases_json,d.created_by,d.created_at_json,d.updated_at_json FROM music_entries e
      LEFT JOIN music_entry_details d ON d.entry_id=e.id ORDER BY e.rowid`).all() as {id:string;name:string;kind:string;category:string|null;aliases_json:string|null;created_by:string|null;created_at_json:string|null;updated_at_json:string|null}[]).map(row=>{
      strings([row.id,row.name,row.kind,row.category,row.aliases_json,row.created_by,row.created_at_json,row.updated_at_json]);
      if(typeof row.id!=='string'||!row.id)throw Error('Invalid rollback entry ID');
      if(array(parseJson(row.aliases_json??'[]')).some(value=>typeof value!=='string'))throw Error('Invalid rollback entry aliases');
      const old=originalEntries.get(row.id),entry: ObjectValue=old?structuredClone(old):{id:row.id};
      patch(entry,'text',row.name,old?.text??'');patch(entry,'kind',row.kind,old?.kind==='main'||old?.kind==='sub'?old.kind:old?.category==='领域'?'main':'sub');
      patch(entry,'category',row.category??(row.kind==='main'?'领域':'其他'),old?.category??'其他');
      patch(entry,'aliases',parseJson(row.aliases_json??'[]'),old?.aliases??[]);
      const creator=translate(row.created_by??'');if(old?.createdBy!==undefined||creator)entry.createdBy=creator;
      patch(entry,'createdAt',parseJson(row.created_at_json??'0'),old?.createdAt??0);patch(entry,'updatedAt',parseJson(row.updated_at_json??'null'),old?.updatedAt??null);
      if(!old){entry.text=row.name;entry.kind=row.kind;entry.aliases=parseJson(row.aliases_json??'[]');}
      return [row.id,entry];
    }));
    const memberPairs:[string,Json][]=[];
    for(const row of db.prepare(`SELECT p.id,p.user_id,l.consent,l.pin_hash,l.fields_json,l.created_entries_json,f.name,f.note,f.note_at,f.gender,f.gender_public,c.contact_qq,pc.created_at
      FROM music_profiles p LEFT JOIN music_legacy_profiles l ON l.profile_id=p.id LEFT JOIN music_profile_fields f ON f.profile_id=p.id
      LEFT JOIN music_profile_contacts c ON c.profile_id=p.id LEFT JOIN music_profile_creation pc ON pc.profile_id=p.id WHERE ${musicProfileActiveSQL('p')} ORDER BY p.rowid`).all() as {
        id:string;user_id:string|null;consent:number|null;pin_hash:string|null;fields_json:string|null;created_entries_json:string|null;name:string|null;note:string|null;note_at:number|null;gender:string|null;gender_public:number|null;contact_qq:string|null;created_at:string|null
      }[]){
      if(row.name===null||row.note===null||row.note_at===null||row.gender===null||row.gender_public===null)throw Error('Missing rollback profile fields');
      strings([row.id,row.user_id,row.pin_hash,row.fields_json,row.created_entries_json,row.name,row.note,row.gender,row.contact_qq,row.created_at]);time(row.note_at);
      if(row.consent!==null&&![0,1].includes(row.consent)||![0,1].includes(row.gender_public))throw Error('Invalid rollback music flag');
      if(row.user_id&&db.prepare('SELECT 1 FROM privacy_requests WHERE user_id=?').get(row.user_id))throw Error('Closed rollback owner requires erasure recovery');
      const old=originalProfiles.get(row.id),member:ObjectValue=old?structuredClone(old):{},fields=row.fields_json===null?{}:object(parseJson(row.fields_json),'rollback current fields');
      keys(fields,['createdAt','lastJoinAt','gender','genderPublic','note','noteAt','lastShoutAt'],'rollback current fields');
      member.qq=byId.get(row.id)!.legacyKey;
      patch(member,'name',row.name,old?.name??'');patch(member,'consent',row.consent===null?true:!!row.consent,old?.consent??false);
      patch(member,'note',row.note,old?.note??'');patch(member,'noteAt',row.note_at,old?.noteAt??0);patch(member,'gender',row.gender,old?.gender??'');patch(member,'genderPublic',!!row.gender_public,old?.genderPublic??false);
      if(!old)member.name=row.name;
      member.boardUserId=row.user_id??'';
      // A rebased source retains the old raw field when its effective contact
      // is unchanged. Numeric old keys are their own implicit QQ contact.
      const oldContact=/^\d{4,12}$/.test(String(member.qq))?String(member.qq):String(old?.contactQQ??'');
      if(!(rebased&&old&&oldContact===(row.contact_qq??'')))member.contactQQ=row.contact_qq??'';
      patch(member,'pinHash',row.pin_hash??'',old?.pinHash??'');
      const selections=db.prepare('SELECT entry_id AS id,level FROM music_selections WHERE profile_id=? ORDER BY position').all(row.id) as {id:string;level:number}[];
      if(!(old&&!Object.hasOwn(old,'selection')&&selections.length===0))member.selection=old&&same(choices(old.selection),selections)?structuredClone(old.selection??[]):selections as unknown as Json[];
      const originalCreated=array(old?.created).filter(id=>{if(typeof id!=='string')throw Error('Invalid rollback created list');return Object.hasOwn(entries,id);}) as string[];
      const currentCreated= row.created_entries_json===null?[]:array(parseJson(row.created_entries_json)).filter(id=>{if(typeof id!=='string')throw Error('Invalid rollback current created list');return Object.hasOwn(entries,id);}) as string[];
      const recorded=(db.prepare('SELECT entry_id FROM music_entry_creations WHERE profile_id=? ORDER BY position').all(row.id) as {entry_id:string}[]).map(r=>r.entry_id);
      const native=(db.prepare('SELECT e.id AS entry_id FROM music_entries e JOIN music_entry_details d ON d.entry_id=e.id WHERE d.created_by=? ORDER BY e.rowid').all(row.id) as {entry_id:string}[]).map(r=>r.entry_id);
      const current=[...new Set([...currentCreated,...recorded,...native])];
      const base=old?originalCreated:currentCreated;
      if(!(old&&!Object.hasOwn(old,'created')&&current.length===0))member.created=[...base.filter(id=>current.includes(id)),...current.filter(id=>!base.includes(id))];
      const last=db.prepare('SELECT last_post_at FROM music_shout_authors WHERE profile_id=?').get(row.id) as {last_post_at:number}|undefined;
      for(const field of ['createdAt','lastJoinAt','lastShoutAt'])if(fields[field]!==undefined&&!(field==='lastShoutAt'&&last))patch(member,field,fields[field]!,old?.[field]);
      if(row.created_at!==null){const time=Date.parse(row.created_at);if(!Number.isFinite(time))throw Error('Invalid rollback profile creation provenance');member.createdAt=time/1000;}
      if(last){time(last.last_post_at);patch(member,'lastShoutAt',last.last_post_at,Number(old?.lastShoutAt??0));}
      memberPairs.push([member.qq as string,member]);
    }
    const shouts:Json[]=[],shoutHistory:Json[]=[];
    for(const row of db.prepare('SELECT * FROM music_shouts ORDER BY ordinal').all() as {id:string;profile_id:string|null;legacy_key:string;name:string;body:string;created_at:number;archived_at:number|null}[]){
      if(row.archived_at===null&&row.profile_id&&byId.get(row.profile_id)?.retired)continue;
      strings([row.id,row.profile_id,row.legacy_key,row.name,row.body]);time(row.created_at);if(row.archived_at!==null)time(row.archived_at);
      if(row.profile_id&&byId.get(row.profile_id)?.erased||erased.has(row.legacy_key))throw Error('Erased rollback shout requires recovery');
      const source=originalShouts.get(row.id),old=source?.value,value:ObjectValue=old?structuredClone(old):{id:row.id};
      value.qq=row.profile_id?byId.get(row.profile_id)!.legacyKey:translate(row.legacy_key);
      patch(value,'name',row.name,old?.name||'群友');patch(value,'text',row.body,old?.text??'');patch(value,'createdAt',row.created_at,Number(old?.createdAt??0));
      if(!old){value.name=row.name;value.text=row.body;value.createdAt=row.created_at;}
      if(row.archived_at!==null)patch(value,'archivedAt',row.archived_at,source?.kind==='shoutHistory'?Number(old?.archivedAt??0):-1);
      else if(source?.kind==='shoutHistory')delete value.archivedAt;
      (row.archived_at===null?shouts:shoutHistory).push(value);
    }
    const trend=(db.prepare("SELECT payload_json FROM music_documents WHERE kind IN ('trend','trend_sample') ORDER BY CASE kind WHEN 'trend' THEN 0 ELSE 1 END,position").all() as {payload_json:string}[]).map(row=>{
      const point=object(parseJson(row.payload_json),'rollback trend');keys(point,['t','counts'],'rollback trend');return point;
    });
    const entryOrder=[...(rebased?originalEntries.keys():[]),...jsonObjectKeys(entries)].filter((id,index,all)=>Object.hasOwn(entries,id)&&all.indexOf(id)===index);
    const memberValues=new Map(memberPairs),memberOrder=[...(rebased?originalProfiles.keys():[])].map(id=>byId.get(id)?.legacyKey).filter((key):key is string=>key!==undefined&&memberValues.has(key));
    for(const [key] of memberPairs)if(!memberOrder.includes(key))memberOrder.push(key);
    const result:RollbackMusic={data:{entries:jsonObjectFromEntries(entryOrder.map(id=>[id,entries[id]!])),members:jsonObjectFromEntries(memberOrder.map(key=>[key,memberValues.get(key)!])),settings:{},shouts,shoutHistory,trend},keys:mapping};
    const report=verifyRollbackMusic(db,result,intents);return {...result,report};
  }).immediate();
}
