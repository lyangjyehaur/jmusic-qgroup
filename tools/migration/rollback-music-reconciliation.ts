import { createHash } from 'node:crypto';
import type { DB } from '@qgroup/database';
import {erasureRequestId, type  StoredIntent } from '../../apps/api/src/erasure-journal';
import type { RollbackMusic } from './rollback-music';
import {readSourceRebaseEvidence} from './source-rebase-evidence';
type RecordValue=Record<string,unknown>;
const reject=():never=>{throw Error('Rollback music reconciliation failed; retain the complete latest source');};
const obj=(value:unknown):RecordValue=>{if(!value||typeof value!=='object'||Array.isArray(value))return reject();return value as RecordValue;};
const list=(value:unknown):unknown[]=>{if(value===undefined)return [];if(!Array.isArray(value))return reject();return value;};
function canonical(value:unknown):string{return JSON.stringify(value,(_key,item:unknown)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item);}
const equal=(a:unknown,b:unknown)=>{if(canonical(a)!==canonical(b))reject();};
function fields(value:RecordValue,allowed:string[]){if(Object.keys(value).some(key=>!allowed.includes(key)))reject();}
function normalizedSelection(value:unknown){
  const result:{id:string;level:number}[]=[],seen=new Set<string>();
  for(const raw of list(value)){
    let id:string,level=3;
    if(raw&&typeof raw==='object'&&!Array.isArray(raw)){
      const row=obj(raw);id=String(row.id||row.entryId||'');const value=row.level;
      if(value){if(typeof value==='number')level=Math.trunc(value);else if(typeof value==='string'&&/^[+-]?\d+$/.test(value.trim()))level=Number(value);else if(value===true)level=1;}
      level=Math.min(4,Math.max(1,level));
    }else{if(typeof raw!=='string')return reject();id=raw;}
    if(id&&!seen.has(id)){seen.add(id);result.push({id,level});}
  }return result;
}
/** Independently reads latest normalized rows and source evidence. It neither
 * calls the projector nor authorizes differences from its generated report. */
export function verifyRollbackMusic(db:DB,result:RollbackMusic,intents:StoredIntent[]){
  const rebased=readSourceRebaseEvidence(db,intents),bindings=new Map(rebased?.bindings.map(row=>[row.profileId,row]));
  const root=obj(result.data);equal(Object.keys(root).sort(),['entries','members','settings','shouts','shoutHistory','trend'].sort());
  const entries=obj(root.entries),members=obj(root.members),profiles=db.prepare('SELECT id,erased_at FROM music_profiles ORDER BY rowid').all() as {id:string;erased_at:string|null}[];
  const map=new Map(result.keys.map(row=>[row.profileId,row]));if(map.size!==result.keys.length||map.size!==profiles.length)reject();
  const used=new Set<string>(),erased=new Set<string>();
  const reserved=new Set((db.prepare('SELECT legacy_key FROM music_legacy_erasures').all() as {legacy_key:string}[]).map(row=>row.legacy_key));
  for(const row of db.prepare("SELECT source_id FROM migration_map WHERE source='music' AND entity_type='profile'").all() as {source_id:string}[])reserved.add(row.source_id);
  for(const row of db.prepare('SELECT legacy_key FROM music_legacy_profiles').all() as {legacy_key:string}[])reserved.add(row.legacy_key);
  for(const p of profiles){
    if(typeof p.id!=='string'||!/^m_(?:[a-f0-9]{32}|[a-f0-9]{40})$/.test(p.id))reject();
    const key=map.get(p.id)??reject();if(key.erased!==(p.erased_at!==null)||used.has(key.legacyKey)||!/^(?:[0-9]{4,12}|m_[a-f0-9]{24})$/.test(key.legacyKey))reject();used.add(key.legacyKey);
    const names=db.prepare("SELECT legacy_key AS name FROM music_legacy_profiles WHERE profile_id=? UNION SELECT source_id AS name FROM migration_map WHERE source='music' AND entity_type='profile' AND target_id=?").all(p.id,p.id) as {name:string}[];
    const binding=bindings.get(p.id);
    if(binding){if(key.mode!==binding.mode||key.legacyKey!==binding.legacyKey||names.some(row=>row.name!==binding.legacyKey))reject();}
    else if(names.length){if(names.length!==1||key.mode!=='preserved'||key.legacyKey!==names[0]!.name)reject();}
    else{const expected='m_'+createHash('sha256').update('qgroup:rollback-music-key:v1:'+p.id).digest('hex').slice(0,24);if(key.mode!=='generated'||key.legacyKey!==expected||reserved.has(expected))reject();}
    if(key.erased){erased.add(p.id);erased.add(key.legacyKey);}else if(reserved.has(key.legacyKey)&&db.prepare('SELECT 1 FROM music_legacy_erasures WHERE legacy_key=?').get(key.legacyKey))reject();
  }
  for(const key of reserved)if(db.prepare('SELECT 1 FROM music_legacy_erasures WHERE legacy_key=?').get(key))erased.add(key);
  const creator=(value:string)=>erased.has(value)?'':map.get(value)?.legacyKey??value;
  equal(Object.keys(members).sort(),profiles.filter(p=>p.erased_at===null).map(p=>map.get(p.id)!.legacyKey).sort());
  const terms=db.prepare(`SELECT e.id,e.name,e.kind,d.category,d.aliases_json,d.created_by,d.created_at_json,d.updated_at_json FROM music_entries e
    LEFT JOIN music_entry_details d ON d.entry_id=e.id ORDER BY e.rowid`).all() as {id:string;name:string;kind:string;category:string|null;aliases_json:string|null;created_by:string|null;created_at_json:string|null;updated_at_json:string|null}[];
  equal(Object.keys(entries).sort(),terms.map(row=>row.id).sort());
  for(const row of terms){
    const entry=obj(entries[row.id]);fields(entry,['id','text','kind','category','aliases','createdBy','createdAt','updatedAt']);equal(entry.id,row.id);equal(entry.text,row.name);
    equal(entry.kind==='main'||entry.kind==='sub'?entry.kind:entry.category==='领域'?'main':'sub',row.kind);
    equal(entry.category??'其他',row.category??(row.kind==='main'?'领域':'其他'));equal(entry.aliases??[],JSON.parse(row.aliases_json??'[]'));
    equal(entry.createdBy??'',creator(row.created_by??''));equal(entry.createdAt??0,JSON.parse(row.created_at_json??'0'));equal(entry.updatedAt??null,JSON.parse(row.updated_at_json??'null'));
    const evidence=db.prepare("SELECT payload_json FROM music_documents WHERE kind='entry_source' AND json_extract(payload_json,'$.entryId')=?").get(row.id) as {payload_json:string}|undefined;
    if(evidence){const old=obj(obj(JSON.parse(evidence.payload_json)).entry);
      for(const field of ['aliases','createdAt','updatedAt','kind','category']){
        const fallback=field==='aliases'?[]:field==='createdAt'?0:field==='updatedAt'?null:field==='kind'?(old.category==='领域'?'main':'sub'):'其他';
        if(canonical(old[field]??fallback)===canonical(entry[field]??fallback))equal(Object.hasOwn(entry,field)?entry[field]:undefined,Object.hasOwn(old,field)?old[field]:undefined);
      }
    }
  }
  let choices=0;
  for(const row of db.prepare(`SELECT p.id,p.user_id,l.consent,l.pin_hash,l.fields_json,l.created_entries_json,f.name,f.note,f.note_at,f.gender,f.gender_public,c.contact_qq,pc.created_at
    FROM music_profiles p LEFT JOIN music_legacy_profiles l ON l.profile_id=p.id LEFT JOIN music_profile_fields f ON f.profile_id=p.id
    LEFT JOIN music_profile_contacts c ON c.profile_id=p.id LEFT JOIN music_profile_creation pc ON pc.profile_id=p.id WHERE p.erased_at IS NULL ORDER BY p.rowid`).all() as {
      id:string;user_id:string|null;consent:number|null;pin_hash:string|null;fields_json:string|null;created_entries_json:string|null;name:string|null;note:string|null;note_at:number|null;gender:string|null;gender_public:number|null;contact_qq:string|null;created_at:string|null
    }[]){
    const member=obj(members[map.get(row.id)!.legacyKey]);fields(member,['qq','name','consent','selection','created','createdAt','pinHash','lastJoinAt','boardUserId','gender','genderPublic','note','noteAt','lastShoutAt','contactQQ']);
    for(const value of list(member.selection))if(value&&typeof value==='object'&&!Array.isArray(value))fields(obj(value),['id','entryId','level']);
    equal(member.qq,map.get(row.id)!.legacyKey);equal(member.name??'',row.name);equal(member.consent??false,row.consent===null?true:!!row.consent);
    equal(member.boardUserId,row.user_id??'');equal(member.pinHash??'',row.pin_hash??'');
    if(rebased){const key=String(member.qq),contact=/^[0-9]{4,12}$/.test(key)?key:String(member.contactQQ??'');equal(contact,row.contact_qq??'');}
    else equal(member.contactQQ,row.contact_qq??'');
    equal(member.note??'',row.note);equal(member.noteAt??0,row.note_at);equal(member.gender??'',row.gender);equal(member.genderPublic??false,!!row.gender_public);
    const expected=db.prepare('SELECT entry_id AS id,level FROM music_selections WHERE profile_id=? ORDER BY position').all(row.id);equal(normalizedSelection(member.selection),expected);choices+=list(expected).length;
    const created=[...new Set([...list(row.created_entries_json===null?[]:JSON.parse(row.created_entries_json)).filter(id=>typeof id==='string'&&Object.hasOwn(entries,id)),
      ...(db.prepare('SELECT entry_id FROM music_entry_creations WHERE profile_id=? ORDER BY position').all(row.id) as {entry_id:string}[]).map(r=>r.entry_id),
      ...(db.prepare('SELECT e.id FROM music_entries e JOIN music_entry_details d ON d.entry_id=e.id WHERE d.created_by=? ORDER BY e.rowid').all(row.id) as {id:string}[]).map(r=>r.id)])];
    if(list(member.created).some(id=>typeof id!=='string'||!Object.hasOwn(entries,id)))reject();equal([...new Set(list(member.created))],created);
    const source=db.prepare("SELECT payload_json FROM music_documents WHERE kind='profile_source' AND json_extract(payload_json,'$.profileId')=?").get(row.id) as {payload_json:string}|undefined;
    if(source){const old=obj(obj(JSON.parse(source.payload_json)).member);
      if(rebased){const key=String(member.qq),originalContact=/^[0-9]{4,12}$/.test(key)?key:String(old.contactQQ??'');if(originalContact===(row.contact_qq??''))equal(member.contactQQ,old.contactQQ);else equal(member.contactQQ,row.contact_qq??'');}
      if(canonical(normalizedSelection(old.selection))===canonical(expected))equal(member.selection,old.selection);
      for(const field of ['note','noteAt','gender','genderPublic']){const fallback=field==='noteAt'?0:field==='genderPublic'?false:'';if(canonical(old[field]??fallback)===canonical(member[field]??fallback))equal(Object.hasOwn(member,field)?member[field]:undefined,Object.hasOwn(old,field)?old[field]:undefined);}
      const expectedRaw=list(old.created).filter(id=>typeof id==='string'&&created.includes(id));
      const fullCreated=[...expectedRaw,...created.filter(id=>!expectedRaw.includes(id))];
      equal(member.created,Object.hasOwn(old,'created')||fullCreated.length?fullCreated:undefined);
    }else{
      const base=list(row.created_entries_json===null?[]:JSON.parse(row.created_entries_json)).filter(id=>typeof id==='string'&&created.includes(id));
      equal(member.created,[...base,...created.filter(id=>!base.includes(id))]);
    }
    const last=db.prepare('SELECT last_post_at FROM music_shout_authors WHERE profile_id=?').get(row.id) as {last_post_at:number}|undefined;
    const metadata=row.fields_json===null?{}:obj(JSON.parse(row.fields_json));for(const field of ['createdAt','lastJoinAt','lastShoutAt'])if(Object.hasOwn(metadata,field)&&!(field==='lastShoutAt'&&last))equal(member[field],metadata[field]);
    if(row.created_at!==null)equal(member.createdAt,Date.parse(row.created_at)/1000);
    if(last){
      equal(Number(member.lastShoutAt??0),last.last_post_at);
      if(source){const old=obj(obj(JSON.parse(source.payload_json)).member);if(Number(old.lastShoutAt??0)===last.last_post_at)equal(member.lastShoutAt,old.lastShoutAt);}
    }
  }
  const liveShouts=db.prepare('SELECT * FROM music_shouts ORDER BY ordinal').all() as {id:string;profile_id:string|null;legacy_key:string;name:string;body:string;created_at:number;archived_at:number|null}[];
  let active=0,history=0;
  for(const kind of ['shouts','shoutHistory']){
    const expected=liveShouts.filter(row=>(row.archived_at===null)===(kind==='shouts')),values=list(root[kind]);equal(values.length,expected.length);
    expected.forEach((row,index)=>{
      const shout=obj(values[index]);fields(shout,['id','qq','name','text','createdAt','archivedAt']);equal(shout.id,row.id);equal(shout.qq,row.profile_id?map.get(row.profile_id)!.legacyKey:creator(row.legacy_key));equal(shout.name||'群友',row.name);equal(shout.text,row.body);equal(Number(shout.createdAt??0),row.created_at);if(kind==='shoutHistory')equal(Number(shout.archivedAt??0),row.archived_at);if(erased.has(String(shout.qq)))reject();
      const original=db.prepare("SELECT kind,payload_json FROM music_documents WHERE kind IN ('shouts','shoutHistory') AND json_extract(payload_json,'$.id')=?").all(row.id) as {kind:string;payload_json:string}[];
      if(original.length>1)reject();if(original.length){const record=original[0]!,old=obj(JSON.parse(record.payload_json));
        if(Number(old.createdAt??0)===row.created_at)equal(shout.createdAt,old.createdAt);
        if((old.name||'群友')===row.name)equal(shout.name,old.name);
        if(kind==='shoutHistory'&&record.kind==='shoutHistory'&&Number(old.archivedAt??0)===row.archived_at)equal(shout.archivedAt,old.archivedAt);
      }
    });
    if(kind==='shouts')active=values.length;else history=values.length;
  }
  for(const point of list(root.trend))fields(obj(point),['t','counts']);
  equal(root.trend,(db.prepare("SELECT payload_json FROM music_documents WHERE kind IN ('trend','trend_sample') ORDER BY CASE kind WHEN 'trend' THEN 0 ELSE 1 END,position").all() as {payload_json:string}[]).map(row=>JSON.parse(row.payload_json)));equal(root.settings,{});
  const requestIds=new Set(intents.map(entry=>erasureRequestId(entry)));equal((db.prepare('SELECT request_id FROM erasure_applied').all() as {request_id:string}[]).map(row=>row.request_id).sort(),[...requestIds].sort());
  return {version:1 as const,entries:terms.length,profiles:Object.keys(members).length,selections:choices,shouts:active,shoutHistory:history,keys:map.size,dataDigest:createHash('sha256').update(canonical(result.data)).digest('hex'),rollbackEligible:false as const,
    remaining:['identity_sqlite','latest_erasure_package','full_source_audits_receipts_consents','media','browser_requests','fixed_old_web_music_bot_rehearsal']};
}
