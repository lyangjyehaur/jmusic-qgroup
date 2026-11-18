import type { DB } from '@qgroup/database';
import type { StoredIntent } from '../../apps/api/src/erasure-journal';
import { digest, parseJson, profileId, musicErasures, type Identity, type Json, type ObjectValue } from './music-codec';
import { reconcileIdentitySource } from './identity-reconciliation';

type Row = Record<string, unknown>;
function reject():never { throw new Error('Music reconciliation failed; no candidate was published'); }
const encode=(value:unknown)=>JSON.stringify(value);
const equal=(a:unknown,b:unknown)=>{if(encode(a)!==encode(b))reject();};
const obj=(value:Json|undefined):ObjectValue=>{if(!value||typeof value!=='object'||Array.isArray(value))reject();return value;};
const array=(value:Json|undefined):Json[]=>{if(value===undefined)return [];if(!Array.isArray(value))reject();return value;};
const text=(value:Json|undefined)=>{if(value===undefined)return '';if(typeof value!=='string')reject();return value;};
const quoted=(name:string)=>'"'+name.replaceAll('"','""')+'"';
// Structural comparison is restricted to documents changed by account closure;
// untouched source JSON strings must remain byte-for-byte equal.
function jsonValue(value:unknown):unknown {
  if(Array.isArray(value))return value.map(jsonValue);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,jsonValue(item)]));
  return value;
}
const tables=[
  'music_entries','music_entry_details','music_profiles','music_legacy_profiles','music_profile_contacts','music_selections','music_profile_fields',
  'music_legacy_identity','music_legacy_erasures','music_documents','music_shouts','music_account_epochs','music_catalog_actions',
  'music_profile_creation','music_entry_creations','music_profile_audit','music_profile_receipts','music_contact_history','music_field_history',
  'music_pin_history','music_ownership_history','music_claim_intents','music_shout_authors','music_shout_deletions','music_claim_attempts',
] as const;

/** Independent source projection: never calls importMusic/projectMusic, seeds,
 * privacy replay, or uses migration statuses to authorize data differences. */
export function reconcileMusic(candidate:DB, raw:Json, identity:Identity, legacyLedger:string, journal:StoredIntent[], board:DB, stamp:string, identitySource:DB){
  const data=obj(raw),originalMembers=obj(data.members),originalEntries=obj(data.entries);
  const expected:Record<string,Row[]>=Object.fromEntries(tables.map(table=>[table,[]]));
  const add=(table:string,row:Row)=>expected[table]!.push(row);
  const identityReconciliation = reconcileIdentitySource(candidate, identitySource);
  add('music_documents', {kind:'identity_source',position:0,payload_json:encode(identityReconciliation.evidence)});
  const mappings:Row[]=[];
  const map=(source:string,entity_type:string,source_id:string,target_id:string,payload_digest:string,status:string)=>mappings.push({source,entity_type,source_id,target_id,source_revision:'',payload_digest,status});
  const users=new Set((board.prepare('SELECT id FROM users').all() as {id:string}[]).map(row=>row.id));
  const closed=new Set((board.prepare('SELECT user_id FROM privacy_requests').all() as {user_id:string}[]).map(row=>row.user_id));
  const unique=new Map<string,StoredIntent>();
  for(const intent of journal){const id='request_id' in intent?intent.request_id:intent.requestId;if(unique.has(id)&&encode(unique.get(id))!==encode(intent))reject();unique.set(id,intent);}
  const tombstones=new Map<string,Row>(),epochs=new Map<string,number>();
  const epoch=(user:Json|undefined)=>{if(typeof user==='string'&&users.has(user))epochs.set(user,(epochs.get(user)??0)+1);};
  for(const intent of unique.values()){
    if('user_id' in intent){if(users.has(intent.user_id))closed.add(intent.user_id);continue;}
    if(intent.version===2)continue;
    if(intent.kind!=='music'&&users.has(intent.userId))closed.add(intent.userId);
    if(intent.kind!=='account'&&intent.profileId){tombstones.set(intent.profileId,{id:intent.profileId,user_id:null,revision:0,updated_at:tombstones.get(intent.profileId)?.updated_at??intent.createdAt,erased_at:intent.createdAt});epoch(intent.userId);}
  }
  const erased=musicErasures(legacyLedger);
  const knownKeys=new Set([...Object.keys(originalMembers),...identity.native_profiles!.map(row=>String(row.qq))]);
  for(const intent of unique.values())if('version' in intent&&intent.kind!=='account'){
    const ids=intent.version===2?intent.profiles.map(profile=>profile.id):[intent.profileId];
    for(const key of knownKeys)if(ids.includes(profileId(key)))erased.set(key,intent.createdAt);
  }
  for(const key of erased.keys())if(!tombstones.has(profileId(key)))tombstones.set(profileId(key),{id:profileId(key),user_id:null,revision:0,updated_at:stamp,erased_at:stamp});
  const resetEntries=new Set<string>();let reset=false,action=0;
  for(const intent of unique.values())if('version' in intent&&intent.version===2){
    for(const profile of intent.profiles){
      tombstones.set(profile.id,{id:profile.id,user_id:null,revision:0,updated_at:tombstones.get(profile.id)?.updated_at??intent.createdAt,erased_at:intent.createdAt});epoch(profile.userId??undefined);
    }
    if(intent.command==='reset_music'){reset=true;for(const id of intent.entries)resetEntries.add(id);}
    const actor=intent.actorRef.startsWith('account:')?intent.actorRef.slice(8):'';
    add('music_catalog_actions',{id:++action,actor_id:users.has(actor)?actor:null,actor_ref:intent.actorRef,command:intent.command,entry_id:intent.command==='delete_profile'?intent.profiles[0]!.id:'',target_id:'',affected_profiles:intent.profiles.length,created_at:intent.createdAt});
  }
  const members=new Map<string,ObjectValue>(),sourceMembers=new Map<string,{value:Json;source:string}>();
  for(const [key,value] of Object.entries(originalMembers))if(!erased.has(key)){members.set(key,structuredClone(obj(value)));sourceMembers.set(key,{value,source:'json'});}
  for(const row of identity.native_profiles!)if(!erased.has(String(row.qq))&&!members.has(String(row.qq))){const value=parseJson(text(row.payload));members.set(String(row.qq),structuredClone(obj(value)));sourceMembers.set(String(row.qq),{value,source:'native'});}
  const filtered=Object.fromEntries(Object.entries(identity).map(([table,rows])=>[table,rows.filter(row=>!erased.has(String(row.qq??'')))]));
  for(const row of filtered.profile_contacts!)if(members.has(String(row.qq)))members.get(String(row.qq))!.contactQQ=row.number!;
  for(const table of ['link_overrides','prelinks','links'])for(const row of filtered[table]!)if(members.has(String(row.qq)))members.get(String(row.qq))!.boardUserId=row.user_id!;
  const closedKeys=new Set([...filtered.links!,...filtered.prelinks!].filter(row=>closed.has(String(row.user_id))).map(row=>String(row.qq)));
  const changedIdentity=new Set<string>(),changedDocuments=new Set<number>();
  const profileRows=new Map<string,Row>(tombstones);
  const originalProfile=(key:string)=>Object.hasOwn(originalMembers,key)?originalMembers[key]:identity.native_profiles!.find(row=>row.qq===key)?.payload;
  const erasedIds=new Set(tombstones.keys());
  let entrySourcePosition=0;
  for(const [id,value] of Object.entries(originalEntries)){
    const original=obj(value),entry=structuredClone(original);
    if(erased.has(String(entry.createdBy??''))||erasedIds.has(String(entry.createdBy??'')))entry.createdBy='';
    map('music','entry',id,id,digest(encode(value)),resetEntries.has(id)?'deleted':encode(entry)===encode(value)?'preserved':'erasure_redacted');
    const sourcePosition=entrySourcePosition++;if(resetEntries.has(id))continue;
    add('music_documents',{kind:'entry_source',position:sourcePosition,payload_json:encode({entryId:id,entry})});
    add('music_entries',{id,name:text(entry.text),kind:entry.kind==='main'||entry.kind==='sub'?entry.kind:entry.category==='领域'?'main':'sub'});
    add('music_entry_details',{entry_id:id,category:entry.category===undefined?'其他':text(entry.category),aliases_json:encode(array(entry.aliases)),created_by:text(entry.createdBy),created_at_json:encode(entry.createdAt??0),updated_at_json:encode(entry.updatedAt??null)});
  }
  let position=0;
  for(const key of Object.keys(Object.fromEntries(members))){
    const member=members.get(key)!;
    const id=profileId(key),source=sourceMembers.get(key)!,sourceValue=structuredClone(obj(source.value));
    const references=[...filtered.links!,...filtered.prelinks!].filter(row=>row.qq===key),owner=references[0]?text(references[0].user_id):'';
    const isClosed=closed.has(owner),contact=/^[0-9]{4,12}$/.test(key)?key:text(member.contactQQ);
    profileRows.set(id,{id,user_id:owner&&!isClosed?owner:null,revision:0,updated_at:stamp,erased_at:null});
    add('music_legacy_profiles',{profile_id:id,legacy_key:key,name:text(member.name),consent:Number(member.consent??false),pin_hash:text(member.pinHash),contact_qq:contact,
      fields_json:encode(Object.fromEntries(Object.entries(member).filter(([field])=>!['qq','name','consent','selection','created','pinHash','boardUserId','contactQQ'].includes(field)))),created_entries_json:encode(array(member.created)),
      ownership_source:isClosed?'closed_account':filtered.links!.some(row=>row.qq===key)?'oauth':filtered.prelinks!.some(row=>row.qq===key)?'prelinked':'unlinked'});
    add('music_profile_contacts',{profile_id:id,contact_qq:contact,source:/^[0-9]{4,12}$/.test(key)?'legacy':'self_reported',revision:0,updated_at:stamp});
    add('music_profile_fields',{profile_id:id,name:text(member.name),note:member.note==null?'':text(member.note),note_at:member.noteAt??0,gender:member.gender==null?'':text(member.gender),gender_public:Number(member.genderPublic??false),revision:0,updated_at:stamp});
    let n=0;const seen=new Set<string>();
    for(const item of array(member.selection)){
      let entryId:string,level=3;
      if(item&&typeof item==='object'&&!Array.isArray(item)){
        entryId=String(item.id||item.entryId||'');const value=item.level;
        if(value){if(typeof value==='boolean')level=1;else if(typeof value==='number')level=Math.trunc(value);else if(typeof value==='string'&&/^[+-]?\d+$/.test(value.trim()))level=Number(value);}
        level=Math.max(1,Math.min(4,level));
      }else entryId=text(item);
      if(!entryId||seen.has(entryId))continue;seen.add(entryId);
      if(!resetEntries.has(entryId))add('music_selections',{profile_id:id,entry_id:entryId,level,position:n});n++;
    }
    const redactSource=closed.has(String(sourceValue.boardUserId??''));if(redactSource){sourceValue.boardUserId='';changedDocuments.add(position);}
    add('music_documents',{kind:'profile_source',position:position++,payload_json:encode({profileId:id,legacyKey:key,source:source.source,member:sourceValue})});
    map('music','profile',key,id,digest(encode(source.value)),closedKeys.has(key)||redactSource?'erasure_redacted':'preserved');
  }
  for(const [key,time] of erased){
    add('music_legacy_erasures',{legacy_key:key,erased_at_json:encode(time)});
    const rawSource=originalProfile(key),value=Object.hasOwn(originalMembers,key)?rawSource:typeof rawSource==='string'?parseJson(rawSource):undefined;
    map('music','profile',key,profileId(key),value===undefined?'':digest(encode(value)),'erased');
  }
  expected.music_profiles=[...profileRows.values()];
  for(const [table,rows] of Object.entries(identity))rows.forEach((original,index)=>{
    const key=String(original.qq??''),row=structuredClone(original);let removed=erased.has(key),redacted=false;
    if(closedKeys.has(key)&&['links','prelinks','sessions','entry_intents'].includes(table)||table==='entry_intents'&&closed.has(String(row.target_user_id)))removed=true;
    if(!removed&&table==='native_profiles'){
      const payload=obj(parseJson(text(row.payload)));
      if(closed.has(String(payload.boardUserId??''))){payload.boardUserId='';row.payload=encode(payload);redacted=true;changedIdentity.add(table+':'+index);}
    }
    const orphan=row.qq!==undefined&&!members.has(key);
    map('music-identity',table,String(index),table+':'+index,digest(encode(original)),removed?'erased':redacted?'erasure_redacted':orphan?'requires_legacy_review':['sessions','entry_intents'].includes(table)?'requires_legacy_adapter':'preserved');
    if(!removed)add('music_legacy_identity',{table_name:table,row_number:index,payload_json:encode(row)});
    if(!removed&&table==='login_attempts')add('music_claim_attempts',{bucket:row.bucket,created:row.created});
  });
  let ordinal=0;
  const documents: {kind:string;position:number;payload:ObjectValue;profile_id:string|null}[]=[];
  for(const kind of ['settings','shouts','shoutHistory','trend']){
    const values=kind==='settings'?[data.settings??{}]:array(data[kind]);
    values.forEach((value,index)=>{
      const payload=obj(value),author=String(payload.qq??''),profile=profileRows.get(profileId(author))??profileRows.get(author);
      const removed=(kind==='shouts'||kind==='shoutHistory')&&(erased.has(author)||!!profile?.erased_at);
      map('music',kind,String(index),kind+':'+index,digest(encode(value)),reset&&kind!=='settings'?'deleted':removed?'erased':kind==='settings'?'inactive_legacy_credential':'preserved');
      if(removed||reset&&kind!=='settings')return;
      add('music_documents',{kind,position:index,payload_json:encode(payload)});
      if(kind==='shouts'||kind==='shoutHistory')documents.push({kind,position:index,payload,profile_id:profile?String(profile.id):null});
    });
  }
  const time=(value:Json|undefined)=>value==null||value===''?0:Number(value);
  for(const doc of documents.sort((a,b)=>(a.kind==='shoutHistory'?0:1)-(b.kind==='shoutHistory'?0:1)||a.position-b.position)){
    const s=doc.payload;add('music_shouts',{id:s.id,profile_id:doc.profile_id,legacy_key:s.qq,name:s.name||'群友',body:s.text,created_at:time(s.createdAt),archived_at:doc.kind==='shoutHistory'?time(s.archivedAt):null,ordinal:ordinal++});
  }
  for(const [user_id,value] of epochs)add('music_account_epochs',{user_id,epoch:value});
  // Compare the complete initial candidate, including tables that must remain
  // empty: source credentials must never become native sessions or receipts.
  const reports:Record<string,{rows:number;digest:string}>={};
  for(const table of tables){
    const actual=candidate.prepare(`SELECT * FROM ${quoted(table)}`).all() as Row[];
    const normalized=(row:Row)=>{
      if(table==='music_legacy_identity'&&changedIdentity.has(String(row.table_name)+':'+String(row.row_number))){const payload=JSON.parse(String(row.payload_json)) as Row;payload.payload=jsonValue(JSON.parse(String(payload.payload)));return {...row,payload_json:jsonValue(payload)};}
      if(table==='music_documents'&&row.kind==='profile_source'&&changedDocuments.has(Number(row.position)))return {...row,payload_json:jsonValue(JSON.parse(String(row.payload_json)))};
      return row;
    };
    const sorted=(rows:Row[])=>rows.map(normalized).map(encode).sort();equal(sorted(actual),sorted(expected[table]!));
    reports[table]={rows:actual.length,digest:digest(encode(sorted(actual)))};
  }
  const actualMaps=candidate.prepare("SELECT * FROM migration_map WHERE source IN ('music','music-identity')").all() as Row[];
  equal(actualMaps.map(encode).sort(),mappings.map(encode).sort());
  return {version:1,verified:true,sourceEntries:Object.keys(originalEntries).length,sourceMembers:Object.keys(originalMembers).length,sourceIdentityRows:Object.values(identity).reduce((sum,rows)=>sum+rows.length,0),
    nativeRecovered:[...sourceMembers.values()].filter(row=>row.source==='native').length,archivedProfiles:expected.music_documents!.filter(row=>row.kind==='profile_source').length,
    sourceMappings:mappings.length,erasedKeys:erased.size,tableCount:tables.length,tables:reports,identitySource:identityReconciliation.report};
}
