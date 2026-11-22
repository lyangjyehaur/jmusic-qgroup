import type {DB} from '@qgroup/database';
import {createPrivacy} from '../../apps/api/src/privacy';
import {exportMusic} from '../../apps/api/src/music-export';
import {exportLegacyMusic} from '../../apps/api/src/legacy-music-export';
import {digest,object,parseJson,jsonObjectKeys,jsonObjectFromEntries} from './music-codec';
import type {RollbackState} from './rollback-state';
import type {RollbackHistory} from './rollback-history';
import {verifyRollbackState} from './rollback-state-reconciliation';
import {decodeHistory,openHistoryNative,validateHistoryCapture,type HistoryPins,type HistorySources} from './rollback-history-source';
const reject=():never=>{throw Error('Rollback history reconciliation failed; retain pinned original histories');};
const canonical=(value:unknown)=>JSON.stringify(value,(_key,item:unknown)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item);
const same=(a:unknown,b:unknown)=>{if(canonical(a)!==canonical(b))reject();};
function files(actual:HistorySources['captureFiles'],expected:HistorySources['captureFiles']){
  if(actual.length!==expected.length)reject();const reference=new Map(expected.map(row=>[row.path,row.bytes]));const seen=new Set<string>();for(const row of actual){if(JSON.stringify(Object.keys(row).sort())!==JSON.stringify(['bytes','path'])||!Buffer.isBuffer(row.bytes)||seen.has(row.path)||!reference.get(row.path)?.equals(row.bytes))reject();seen.add(row.path);}
}
/** Independent comparison against separately retained raw sources and pins.
 * No history projector or live source file is read; reports are never trusted. */
export function verifyRollbackHistory(fixed:DB,state:RollbackState,result:RollbackHistory,expected:HistorySources,pins:HistoryPins){
  verifyRollbackState(fixed,state,state.journal);
  if(result.version!==1||JSON.stringify(Object.keys(result).filter(key=>key!=='report').sort())!==JSON.stringify(['version','checkpointDigest','journalDigest','sources','projections'].sort())||result.checkpointDigest!==digest(state.checkpointImage)||result.journalDigest!==digest(JSON.stringify(state.journal)))reject();
  if(JSON.stringify(Object.keys(result.sources).sort())!==JSON.stringify(['captureManifest','captureFiles','native'].sort())||!Buffer.isBuffer(result.sources.captureManifest)||!result.sources.captureManifest.equals(expected.captureManifest))reject();
  files(result.sources.captureFiles,expected.captureFiles);
  if(result.sources.native.length!==expected.native.length||result.sources.native.length!==pins.native.length||new Set(result.sources.native.map(row=>row.id)).size!==result.sources.native.length||new Set(pins.native.map(row=>row.id)).size!==pins.native.length)reject();
  for(const archive of result.sources.native){const original=expected.native.find(row=>row.id===archive.id);if(!original)reject();if(JSON.stringify(Object.keys(archive).sort())!==JSON.stringify(['id','manifest','files'].sort())||!Buffer.isBuffer(archive.manifest)||!archive.manifest.equals(original!.manifest))reject();files(archive.files,original!.files);}
  const catalog=validateHistoryCapture(fixed,result.sources,pins,state.journal),ids=[...catalog.groups.map(group=>group.id),...result.sources.native.map(row=>'native-'+row.id)].sort();
  same(result.projections.map(row=>row.id).sort(),ids);
  for(const group of catalog.groups){const path=group.source==='legacy_pair'?'history/music/paired-backups/'+group.sourceStamp+'/data.json':'history/music/backups/data-'+group.sourceStamp+'.json';const projected=result.projections.find(row=>row.id===group.id)!;
    const data=exportLegacyMusic(parseJson(decodeHistory(catalog.files.get(path)!)),fixed,state.journal,catalog.erased);
    same(projected,{id:group.id,source:group.source,sourceStamp:group.sourceStamp,createdAt:null,schema:null,keys:[],data});
    for(const kind of ['entries','members'])same(jsonObjectKeys(object(projected.data[kind],'history order')),jsonObjectKeys(object(data[kind],'source order')));
  }
  for(const archive of result.sources.native){const opened=openHistoryNative(fixed,archive,pins,state.journal);try{
    createPrivacy(opened.db,{read:()=>state.journal,append(){throw Error('Read-only history verification');}});
    const data=exportMusic(opened.db,fixed),actual=result.projections.find(row=>row.id==='native-'+archive.id)!;
    const profiles=opened.db.prepare('SELECT p.id,l.legacy_key FROM music_profiles p LEFT JOIN music_legacy_profiles l ON l.profile_id=p.id ORDER BY p.rowid').all() as {id:string;legacy_key:string|null}[];
    const keys=profiles.map(row=>({profileId:row.id,legacyKey:state.music.keys.find(key=>key.profileId===row.id)?.legacyKey??row.legacy_key??'m_'+digest('qgroup:rollback-music-key:v1:'+row.id).slice(0,24)}));
    const reserved=new Map(state.music.keys.map(row=>[row.legacyKey,row.profileId]));for(const key of keys){if(!/^(?:[0-9]{4,12}|m_[a-f0-9]{24})$/.test(key.legacyKey)||reserved.has(key.legacyKey)&&reserved.get(key.legacyKey)!==key.profileId)reject();reserved.set(key.legacyKey,key.profileId);}
    for(const row of profiles)if(row.legacy_key!==null&&keys.find(key=>key.profileId===row.id)?.legacyKey!==row.legacy_key)reject();
    const byId=new Map([...state.music.keys.map(row=>[row.profileId,row.legacyKey] as const),...keys.map(row=>[row.profileId,row.legacyKey] as const)]),current=object(state.music.data.members,'latest members');
    const sourceMembers=jsonObjectKeys(data.members),memberPositions=new Map(sourceMembers.map((key,index)=>[key,index]));
    const orderedProfiles=[...profiles].sort((a,b)=>(memberPositions.get(a.legacy_key??a.id)??Number.MAX_SAFE_INTEGER)-(memberPositions.get(b.legacy_key??b.id)??Number.MAX_SAFE_INTEGER));
    const members=jsonObjectFromEntries(orderedProfiles.flatMap(row=>{const original=data.members[row.legacy_key??row.id];if(!original)return [];const key=byId.get(row.id)!,live=current[key]===undefined?undefined:object(current[key],'latest member');return [[key,{...original,qq:key,boardUserId:live?.boardUserId??'',pinHash:live?.pinHash??'',contactQQ:live?.contactQQ??''}]] as [string,typeof original][];}));
    for(const entry of Object.values(data.entries))entry.createdBy=byId.get(String(entry.createdBy))??entry.createdBy;
    for(const shout of [...data.shouts,...data.shoutHistory])shout.qq=byId.get(String(shout.qq))??shout.qq;
    exportLegacyMusic(parseJson(JSON.stringify({...data,members})),fixed,[],new Set());
    same(actual,{id:'native-'+archive.id,source:'native',sourceStamp:archive.id,createdAt:opened.manifest.createdAt,schema:opened.manifest.schema,keys,data:{...data,members}});
    same(jsonObjectKeys(object(actual.data.members,'native history members')),jsonObjectKeys(members));
    same(jsonObjectKeys(object(actual.data.entries,'native history entries')),jsonObjectKeys(data.entries));
  }finally{opened.db.close();}}
  const privateBytes=result.sources.captureManifest.length+result.sources.captureFiles.reduce((n,file)=>n+file.bytes.length,0)+result.sources.native.reduce((n,archive)=>n+archive.manifest.length+archive.files.reduce((n,file)=>n+file.bytes.length,0),0);
  if(!Number.isSafeInteger(privateBytes))reject();
  return {version:1 as const,sourcePolicy:'private_original_histories_latest_erasure_projection' as const,legacyPairs:catalog.groups.filter(row=>row.source==='legacy_pair').length,legacyJson:catalog.groups.filter(row=>row.source==='legacy_json').length,nativeBackups:result.sources.native.length,privateBytes,projectionDigest:digest(canonical(result.projections)),rollbackEligible:false as const,
    remaining:['private_package_manifest_fsync','old_history_namespace_adapter','board_history_restore_latest_erasure_rehearsal','browser_requests_proof_recovery','fixed_old_web_music_bot_rehearsal','forward_restore_mapping']};
}
