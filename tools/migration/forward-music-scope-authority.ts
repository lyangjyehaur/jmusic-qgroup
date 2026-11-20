import Database from 'better-sqlite3';
import {readMusicRetirements,type DB} from '@qgroup/database';
import {join} from 'node:path';
import {z} from 'zod';
import {decodeErasureJournal,erasureRequestId,readVerifiedErasureJournal,type ErasureJournal,type StoredIntent} from '../../apps/api/src/erasure-journal';
import {privateFile,readRollbackErasureAuthority} from '../../apps/api/src/erasure-authority-protocol';
import {digest,parseJson,type Json} from '../../packages/runtime/src/strict-json';
import {profileId} from '../../packages/database/src/legacy-music-codec';
import {readSourceRebaseEvidence,sourceRebaseDigest} from './source-rebase-evidence';
import {assertRollbackSource} from './rollback-source';
import {forwardCanonical,forwardEqual} from './forward-board-storage';
import type {MusicRepairContext} from './forward-music-repair-reconciliation';

export type ForwardMusicScopeAuthority={authorityRoot:string;manifestSha256:string;checkpoint:Buffer};
function reject():never{throw Error('Forward music scope authority differs; retain all original images');}
const oldKey=/^(?:[0-9]{4,12}|m_[a-f0-9]{24})$/;
const profile=/^m_(?:[a-f0-9]{32}|[a-f0-9]{40})$/;
const decode=(bytes:Buffer)=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
const ledger=(bytes:Buffer)=>decode(bytes).split('\n').filter(line=>line.trim()).map(line=>parseJson(line) as {qq:string;erased_at:Json});
const originalTime=(intent:Exclude<StoredIntent,{user_id:string}>)=>intent.version===3?intent.originalErasedAtJson:JSON.stringify(intent.createdAt);
const ids=(intent:StoredIntent)=>'user_id' in intent?[]:intent.version===2?intent.profiles.map(row=>row.id):intent.version===1&&intent.kind==='account'||!intent.profileId?[]:[intent.profileId];

/** Separate read-only key derivation. Neither rollback projection nor the
 * service writer supplies these bindings. Rebase/retirement readers verify
 * local bindings; external generation ancestry is still a separate gate. */
export function readForwardMusicScopeKeys(db:DB,intents:StoredIntent[]){
  const bindings=new Map(readSourceRebaseEvidence(db,intents)?.bindings.map(row=>[row.profileId,row]));
  const retirements=new Map(readMusicRetirements(db).map(row=>[row.profileId,row.legacyKey]));
  const aliases=new Map<string,Set<string>>(),reserved=new Set<string>();
  for(const row of db.prepare("SELECT profile_id AS id,legacy_key AS key FROM music_legacy_profiles UNION SELECT target_id AS id,source_id AS key FROM migration_map WHERE source='music' AND entity_type='profile'").all() as {id:string;key:string}[]){
    if(!profile.test(row.id)||!oldKey.test(row.key))reject();
    const names=aliases.get(row.id)??new Set<string>();names.add(row.key);aliases.set(row.id,names);reserved.add(row.key);
  }
  for(const row of db.prepare('SELECT legacy_key FROM music_legacy_erasures').all() as {legacy_key:string}[]){if(!oldKey.test(row.legacy_key))reject();reserved.add(row.legacy_key);}
  const keys=new Set<string>();
  return (db.prepare('SELECT id,erased_at FROM music_profiles ORDER BY rowid').all() as {id:string;erased_at:string|null}[]).map(row=>{
    if(!profile.test(row.id))reject();const names=aliases.get(row.id),binding=bindings.get(row.id);
    if(names&&names.size!==1||binding&&names&&[...names].some(key=>key!==binding.legacyKey))reject();
    const mode=binding?.mode??(names?'preserved':'generated'),key=binding?.legacyKey??(names?[...names][0]!:('m_'+digest('qgroup:rollback-music-key:v1:'+row.id).slice(0,24)));
    if(keys.has(key)||mode==='generated'&&!binding&&reserved.has(key)||retirements.has(row.id)&&retirements.get(row.id)!==key||row.erased_at===null&&db.prepare('SELECT 1 FROM music_legacy_erasures WHERE legacy_key=?').get(key))reject();
    keys.add(key);return {legacyKey:key,profileId:row.id,erased:row.erased_at!==null};
  });
}

/** Derive scopes from a second immutable authority read and the original
 * checkpoint, never candidate tombstone/time values or a repair report. The
 * journal is verified against the committed pre-repair memory image. */
export function deriveForwardMusicRepairContext(source:DB,journal:ErasureJournal,input:ForwardMusicScopeAuthority):MusicRepairContext{
  if(source.name!==':memory:'||source.inTransaction||!Buffer.isBuffer(input.checkpoint))reject();
  const authority=readRollbackErasureAuthority(input.authorityRoot,input.manifestSha256);
  const checkpointBytes=Buffer.from(input.checkpoint);
  if(digest(checkpointBytes)!==authority.manifest.checkpointSha256)reject();
  const baseline=Object.fromEntries(authority.manifest.baseline.map(row=>{
    const file=privateFile(join(input.authorityRoot,row.path),64*1024*1024);if(!file.bytes||file.sha256!==row.sha256||file.bytes.length!==row.size)reject();file.assertUnchanged();return [row.domain,file.bytes];
  })) as Record<'music'|'unified',Buffer>;
  const fixed=new Database(checkpointBytes);
  try{
    fixed.pragma('foreign_keys = ON');fixed.transaction(()=>assertRollbackSource(fixed)).immediate();source.transaction(()=>assertRollbackSource(source)).immediate();
    if(!forwardEqual(fixed.prepare('SELECT lineage_id FROM rebuild_storage WHERE id=1').get(),source.prepare('SELECT lineage_id FROM rebuild_storage WHERE id=1').get()))reject();
    const baselineIntents=readVerifiedErasureJournal(fixed,{read:()=>decodeErasureJournal(decode(baseline.unified)),append(){reject();}});
    if(digest(JSON.stringify(baselineIntents))!==authority.manifest.journalSha256)reject();
    const intents=readVerifiedErasureJournal(source,journal),original=decodeErasureJournal(decode(authority.ledgers.unified));
    if(!forwardEqual(intents.slice(0,original.length),original))reject();
    const checkpointKeys=readForwardMusicScopeKeys(fixed,baselineIntents),sourceKeys=readForwardMusicScopeKeys(source,intents),checkpointByKey=new Map(checkpointKeys.map(row=>[row.legacyKey,row])),baselineRequests=new Set(baselineIntents.map(erasureRequestId));
    const byKey=new Map<string,string>(),byId=new Map<string,string>();
    for(const binding of [...checkpointKeys,...sourceKeys]){
      if(byKey.has(binding.legacyKey)&&byKey.get(binding.legacyKey)!==binding.profileId||byId.has(binding.profileId)&&byId.get(binding.profileId)!==binding.legacyKey)reject();
      byKey.set(binding.legacyKey,binding.profileId);byId.set(binding.profileId,binding.legacyKey);
    }
    const latest=new Map<string,Exclude<StoredIntent,{user_id:string}>>(),baselineLatest=new Map<string,Exclude<StoredIntent,{user_id:string}>>(),knownStamps=new Map<string,Set<string>>(),knownTimes=new Map<string,Set<string>>();
    const remember=(map:Map<string,Set<string>>,key:string,value:string)=>{const values=map.get(key)??new Set<string>();values.add(value);map.set(key,values);};
    for(const intent of intents)if(!('user_id' in intent))for(const id of ids(intent)){latest.set(id,intent);remember(knownStamps,id,intent.createdAt);const key=byId.get(id);if(key)remember(knownTimes,key,originalTime(intent));}
    for(const intent of baselineIntents)if(!('user_id' in intent))for(const id of ids(intent))baselineLatest.set(id,intent);
    const scopes=new Map<string,MusicRepairContext['legacyScopes'][number]>(),baselineRows=ledger(baseline.music);
    if(new Set(baselineRows.map(row=>row.qq)).size!==baselineRows.length)reject();
    for(const row of baselineRows){
      const key=checkpointByKey.get(row.qq);if(!key?.erased)reject();
      const marker=fixed.prepare('SELECT erased_at FROM music_profiles WHERE id=?').get(key.profileId) as {erased_at:string};
      if(!z.iso.datetime().safeParse(marker.erased_at).success)reject();
      const saved=fixed.prepare('SELECT erased_at_json FROM music_legacy_erasures WHERE legacy_key=?').get(row.qq) as {erased_at_json:string}|undefined;
      const time=saved?.erased_at_json??JSON.stringify(marker.erased_at);
      if(!forwardEqual(parseJson(time),row.erased_at))reject();
      const baselineIntent=baselineLatest.get(key.profileId);
      if(baselineIntent&&(marker.erased_at!==baselineIntent.createdAt||!forwardEqual(parseJson(time),parseJson(originalTime(baselineIntent)))))reject();
      remember(knownStamps,key.profileId,marker.erased_at);remember(knownTimes,row.qq,time);
      const intent=latest.get(key.profileId),baselineRequest=intent&&baselineRequests.has(erasureRequestId(intent));
      scopes.set(row.qq,{legacyKey:row.qq,profileId:key.profileId,stamp:intent?.createdAt??marker.erased_at,originalTimeJson:intent&&!baselineRequest?originalTime(intent):time});
    }
    if(checkpointKeys.some(key=>key.erased&&!scopes.has(key.legacyKey)))reject();
    const old=new Map<string,{stamp:string;raw:string;origin:Record<string,unknown>}>();let oldPhase=false;
    const rebased=readSourceRebaseEvidence(source,intents);
    for(const [index,record] of authority.records.entries()){
      if(record.domain==='unified'&&oldPhase)reject();if(record.domain!=='unified')oldPhase=true;
      if(record.domain!=='music')continue;const suffix=Buffer.from(record.suffixBase64,'base64');
      for(const [rowIndex,row] of ledger(suffix).entries()){
        const raw=JSON.stringify(row.erased_at),stamp=typeof row.erased_at==='string'&&z.iso.datetime().safeParse(row.erased_at).success?row.erased_at:typeof row.erased_at==='number'&&row.erased_at>=0&&row.erased_at*1000<253402300800000?new Date(row.erased_at*1000).toISOString():null;
        if(!stamp)reject();
        old.set(row.qq,{stamp,raw,origin:{authoritySha256:input.manifestSha256,checkpointSha256:authority.manifest.checkpointSha256,recordSequence:record.sequence,recordSha256:authority.recordPins[index],suffixSha256:digest(suffix),rowIndex,sourceRebaseSha256:rebased?sourceRebaseDigest(rebased):null}});
        const id=byKey.get(row.qq)??profileId(row.qq);remember(knownStamps,id,stamp);remember(knownTimes,row.qq,raw);
      }
    }
    const imported=new Set<string>(),importsByKey=new Map<string,Extract<StoredIntent,{version:3}>[]>();
    for(const intent of intents)if('version' in intent&&intent.version===3){const rows=importsByKey.get(intent.legacyKey)??[];rows.push(intent);importsByKey.set(intent.legacyKey,rows);}
    for(const [key,value] of old){
      const id=byKey.get(key)??profileId(key);if(byId.has(id)&&byId.get(id)!==key)reject();
      const matches=(importsByKey.get(key)??[]).filter(intent=>intent.profileId===id&&intent.createdAt===value.stamp&&intent.originalErasedAtJson===value.raw&&forwardEqual(intent.origin,value.origin));
      if(matches.length!==1)reject();imported.add(erasureRequestId(matches[0]!));
      scopes.set(key,{legacyKey:key,profileId:id,stamp:value.stamp,originalTimeJson:value.raw});
    }
    const closures=new Set(decodeErasureJournal(decode(authority.ledgers.board)).map(forwardCanonical));
    for(const intent of intents.slice(original.length))if(!imported.has(erasureRequestId(intent))&&!closures.has(forwardCanonical(intent)))reject();
    // Unknown metadata is not an authorization to preserve a purported newer
    // deletion. Known older markers may be repaired; ordering is journal order.
    for(const [id,times] of knownStamps){const row=source.prepare('SELECT erased_at FROM music_profiles WHERE id=?').get(id) as {erased_at:string|null}|undefined;if(row?.erased_at!==undefined&&row.erased_at!==null&&!times.has(row.erased_at))reject();}
    for(const [key,times] of knownTimes){const row=source.prepare('SELECT erased_at_json FROM music_legacy_erasures WHERE legacy_key=?').get(key) as {erased_at_json:string}|undefined;if(row&&!times.has(row.erased_at_json))reject();}
    authority.assertUnchanged();if(!input.checkpoint.equals(checkpointBytes))reject();
    return {authoritySha256:input.manifestSha256,headRecordSha256:authority.head.recordSha256,legacyScopes:[...scopes.values()]};
  }finally{fixed.close();}
}

export function assertForwardMusicRepairContext(source:DB,journal:ErasureJournal,input:ForwardMusicScopeAuthority,context:MusicRepairContext){
  if(forwardCanonical(deriveForwardMusicRepairContext(source,journal,input))!==forwardCanonical(context))reject();
}
