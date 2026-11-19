import type {DB} from '@qgroup/database';
import {createPrivacy} from '../../apps/api/src/privacy';
import {exportMusic} from '../../apps/api/src/music-export';
import {exportLegacyMusic} from '../../apps/api/src/legacy-music-export';
import {digest,object,parseJson,type Json,type ObjectValue} from './music-codec';
import type {StoredIntent} from '../../apps/api/src/erasure-journal';
import type {RollbackMusic} from './rollback-music';
import {decodeHistory,openHistoryNative,type HistoryPins,type HistorySources} from './rollback-history-source';

export type HistoryProjection={id:string;source:'legacy_pair'|'legacy_json'|'native';sourceStamp:string;createdAt:string|null;schema:number|null;data:ObjectValue;keys:{profileId:string;legacyKey:string}[]};
const oldKey=/^(?:[0-9]{4,12}|m_[a-f0-9]{24})$/;
/** Replays latest intents only on a disposable native copy. Applied markers
 * preserve post-reset writes; JSON histories without markers replay all scopes. */
export function projectNativeHistory(current:DB,music:RollbackMusic,archive:HistorySources['native'][number],pins:HistoryPins,intents:StoredIntent[]):HistoryProjection{
  const opened=openHistoryNative(current,archive,pins,intents),copy=opened.db;
  try{
    createPrivacy(copy,{read:()=>structuredClone(intents),append(){throw Error('Read-only history export');}});
    const keys:{profileId:string;legacyKey:string}[]=[],byId=new Map(music.keys.map(row=>[row.profileId,row.legacyKey])),reserved=new Map(music.keys.map(row=>[row.legacyKey,row.profileId]));
    const rows=copy.prepare('SELECT p.id,l.legacy_key FROM music_profiles p LEFT JOIN music_legacy_profiles l ON l.profile_id=p.id ORDER BY p.rowid').all() as {id:string;legacy_key:string|null}[];
    for(const row of rows){
      if(!/^m_(?:[a-f0-9]{32}|[a-f0-9]{40})$/.test(row.id))throw Error('Invalid historical native profile ID');
      const key=byId.get(row.id)??row.legacy_key??'m_'+digest('qgroup:rollback-music-key:v1:'+row.id).slice(0,24);
      if(!oldKey.test(key)||row.legacy_key!==null&&row.legacy_key!==key||reserved.has(key)&&reserved.get(key)!==row.id)throw Error('Historical rollback profile key collision');
      reserved.set(key,row.id);byId.set(row.id,key);keys.push({profileId:row.id,legacyKey:key});
    }
    const data=object(parseJson(JSON.stringify(exportMusic(copy,current))),'native history export'),members=object(data.members,'native historical members'),active=object(music.data.members,'current rollback members');
    const renamed:ObjectValue={};
    for(const row of rows){const member=members[row.legacy_key??row.id];if(member===undefined)continue;const key=byId.get(row.id)!;if(Object.hasOwn(renamed,key))throw Error('Historical native member collision');
      const value=object(member,'native historical member'),latest=active[key]===undefined?undefined:object(active[key],'current member');
      value.qq=key;value.boardUserId=latest?.boardUserId??'';value.pinHash=latest?.pinHash??'';value.contactQQ=latest?.contactQQ??'';
      Object.defineProperty(renamed,key,{value,enumerable:true});
    }
    data.members=renamed;
    const translate=(value:Json|undefined)=>{if(typeof value!=='string')throw Error('Invalid historical creator');return byId.get(value)??value;};
    for(const value of Object.values(object(data.entries,'native historical entries'))){const entry=object(value,'native historical entry');entry.createdBy=translate(entry.createdBy);}
    for(const kind of ['shouts','shoutHistory']){if(!Array.isArray(data[kind]))throw Error('Invalid native history shouts');for(const raw of data[kind]){const value=object(raw,'native history shout');value.qq=translate(value.qq);if(typeof value.qq!=='string'||!oldKey.test(value.qq))throw Error('Unrepresentable native history shout author');}}
    // Validate every exported legacy field without replaying reset scopes or
    // using this helper's credential projection for generated native keys.
    exportLegacyMusic(data,current,[],new Set());
    return {id:'native-'+archive.id,source:'native',sourceStamp:archive.id,createdAt:opened.manifest.createdAt,schema:opened.manifest.schema,data,keys};
  }finally{copy.close();}
}
// The complete raw archives retain historical identity/session/media bytes.
// Only data.json is projected here; old timestamp-only directories cannot
// represent every namespace. No names/times are invented or files activated.
export function legacyHistoryData(files:Map<string,Buffer>,group:{source:string;sourceStamp:string}){
  const path=group.source==='legacy_pair'?'history/music/paired-backups/'+group.sourceStamp+'/data.json':'history/music/backups/data-'+group.sourceStamp+'.json';return parseJson(decodeHistory(files.get(path)!));
}
