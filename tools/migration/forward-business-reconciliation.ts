import Database from 'better-sqlite3';
import type {DB} from '@qgroup/database';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {boardTables,schemaObjects} from './board-reconciliation';
import {forwardRows,forwardRowReader,forwardEqual,forwardCanonical,forwardHash,assertForwardImage} from './forward-board-storage';
import {copyForwardMusicInput,openForwardMusicSources,musicCanonical,musicEqual,type ForwardMusicInput} from './forward-music-sources';
import {verifyForwardMusicMerge} from './forward-music-reconciliation';
import {normalizeForwardBusinessMusic,forwardBusinessTables} from './forward-business-model';
import {assertRollbackSource} from './rollback-source';
import {object,parseJson} from './music-codec';
import type {RollbackMusic} from './rollback-music';

function reject():never{throw Error('Forward business reconciliation failed; retain every original source');}
type Row=Record<string,unknown>;
const tableRows=(db:DB,table:string,key:string[])=>new Map([...forwardRows(db,table)].map(row=>[forwardCanonical(key.map(name=>row[name])),row]));
const different=(a:Row|undefined,b:Row|undefined,columns:string[])=>columns.some(column=>!forwardEqual(a?.[column],b?.[column]));
const rowHigh=(db:DB,table:string)=>[...forwardRows(db,table)].map(row=>row.__forward_rowid__).reduce((high,id)=>high>id?high:id,0n);
function deltaJson(original:unknown,before:unknown,after:unknown){const n=object(parseJson(String(original)),'native fields'),b=object(parseJson(String(before)),'base fields'),o=object(parseJson(String(after)),'old fields');for(const key of new Set([...Object.keys(b),...Object.keys(o)]))if(!musicEqual(b[key],o[key])){if(Object.hasOwn(o,key))Object.defineProperty(n,key,{value:o[key],enumerable:true,configurable:true,writable:true});else delete n[key];}return n;}
/** Independent materialized-row verifier. It does not call the reconstructor,
 * trust its change lists or use its migration report as authorization. */
export function reconcileForwardBusiness(input:ForwardMusicInput,candidate:DB,music:RollbackMusic,identityImage:Buffer,reconstructedAt:string,run:string){
  z.iso.datetime().parse(reconstructedAt);const expectedRun=forwardHash('qgroup:forward-business:v1:'+musicCanonical(Object.fromEntries(Object.entries(input).map(([key,item])=>[key,item.sha256]))));if(run!==expectedRun)reject();
  verifyForwardMusicMerge(input,music,identityImage);const s=openForwardMusicSources(input),models:DB[]=[];
  try{
    const identity=new Database(identityImage);models.push(identity);const base=normalizeForwardBusinessMusic(candidate,s.native,s.nativeIdentity);models.push(base);const next=normalizeForwardBusinessMusic(candidate,music,identity);models.push(next);
    candidate.transaction(()=>assertRollbackSource(candidate)).immediate();if(!forwardEqual(schemaObjects(candidate),schemaObjects(s.board.native)))reject();
    const hash=createHash('sha256'),counts:Record<string,number>={},changeCounts:Record<string,number>={},profiles=new Set<string>(),users=new Set<string>();
    const selectionOrders=new Set<string>();for(const row of next.prepare('SELECT id FROM music_profiles').all() as {id:string}[]){const ids=(db:DB)=>(db.prepare('SELECT entry_id FROM music_selections WHERE profile_id=? ORDER BY position').all(row.id) as {entry_id:string}[]).map(value=>value.entry_id);if(!musicEqual(ids(base),ids(next)))selectionOrders.add(row.id);}
    for(const name of ['user_version','application_id','encoding']){const b=s.board.baseline.pragma(name,{simple:true}),n=s.board.native.pragma(name,{simple:true}),o=s.board.old.pragma(name,{simple:true});if(o!==b&&n!==b&&n!==o)reject();if(candidate.pragma(name,{simple:true})!==(o===b?n:o))reject();}
    for(const table of boardTables){const dbs=[s.board.baseline,s.board.native,s.board.old,candidate],reads=dbs.map(db=>forwardRowReader(db,table)),ids=new Set(dbs.flatMap(db=>[...forwardRows(db,table)].map(row=>row.__forward_rowid__)));for(const id of ids){const [b,n,o,a]=reads.map(read=>read(id));const wanted=forwardEqual(o,b)?n:forwardEqual(n,b)||forwardEqual(n,o)?o:reject();if(!forwardEqual(wanted,a))reject();hash.update(forwardCanonical([table,a]));}}
    for(const table of schemaObjects(s.board.native).filter(row=>row.type==='table'&&!boardTables.includes(row.name)&&!forwardBusinessTables.includes(row.name)).map(row=>row.name)){
      const before=[...forwardRows(s.board.native,table)],after=[...forwardRows(candidate,table)];if(!forwardEqual(before,after))reject();hash.update(forwardCanonical([table,after]));counts[table]=after.length;
    }
    // Nothing may rewrite old native source documents, migration mappings or
    // history. Only independently checked trend suffixes and this run are new.
    if(!forwardEqual([...forwardRows(s.board.native,'migration_map')],[...forwardRows(candidate,'migration_map')]))reject();
    const oldDocs=tableRows(s.board.native,'music_documents',['kind','position']),docs=tableRows(candidate,'music_documents',['kind','position']);for(const [key,row] of oldDocs)if(!forwardEqual(row,docs.get(key)))reject();
    const oldTrend=s.native.data.trend as unknown[],newTrend=music.data.trend as unknown[];if(newTrend.length<oldTrend.length||oldTrend.some((row,i)=>!musicEqual(row,newTrend[i])))reject();
    const extras=[...docs].filter(([key])=>!oldDocs.has(key)).map(([,row])=>row);if(extras.length!==newTrend.length-oldTrend.length||extras.some(row=>row.kind!=='trend_sample'))reject();
    const orderedExtras=extras.sort((a,b)=>(a.position as bigint)<(b.position as bigint)?-1:1),sampleHigh=[...oldDocs.values()].filter(row=>row.kind==='trend_sample').map(row=>row.position as bigint).reduce<bigint|null>((high,value)=>high===null||high<value?value:high,null)??-1n,documentHigh=rowHigh(s.board.native,'music_documents');
    if(!musicEqual(orderedExtras.map(row=>parseJson(String(row.payload_json))),newTrend.slice(oldTrend.length)))reject();
    for(const [index,row] of orderedExtras.entries())if(row.position!==sampleHigh+BigInt(index)+1n||row.__forward_rowid__!==documentHigh+BigInt(index)+1n)reject();
    for(const [table,keys,columns] of [
      ['music_entries',['id'],['name','kind']],
      ['music_entry_details',['entry_id'],['category','aliases_json','created_by','created_at_json','updated_at_json']],
      ['music_selections',['profile_id','entry_id'],['level','position']],
      ['music_profile_fields',['profile_id'],['name','note','note_at','gender','gender_public']],
      ['music_profile_contacts',['profile_id'],['contact_qq','source']],
      ['music_legacy_profiles',['profile_id'],['legacy_key','name','consent','pin_hash','contact_qq','fields_json','created_entries_json','ownership_source']],
      ['music_shouts',['id'],['profile_id','legacy_key','name','body','created_at','archived_at']],
    ] as [string,string[],string[]][]){
      const a=tableRows(base,table,keys),b=tableRows(next,table,keys),original=tableRows(s.board.native,table,keys),actual=tableRows(candidate,table,keys),wantedKeys=new Set(original.keys()),maximum=[...original.values()].map(row=>row.__forward_rowid__).reduce((n,id)=>n>id?n:id,0n);
      for(const key of new Set([...a.keys(),...b.keys()])){const before=a.get(key),after=b.get(key),native=original.get(key),row=actual.get(key),positionChange=table==='music_selections'&&after&&selectionOrders.has(String(after.profile_id))&&!forwardEqual(native?.position,after.position),change=!before||!after||different(before,after,columns)||positionChange;
        if(!change)continue;changeCounts[table]=(changeCounts[table]??0)+1;if(table==='music_selections'||table==='music_profile_fields'||table==='music_profile_contacts'||table==='music_legacy_profiles')profiles.add(String((after??before)!.profile_id));
        if(!after){wantedKeys.delete(key);if(row)reject();continue;}wantedKeys.add(key);if(!row)reject();
        if(native){if(row.__forward_rowid__!==native.__forward_rowid__)reject();}else if(typeof row.__forward_rowid__!=='bigint'||row.__forward_rowid__<=maximum)reject();
        const names=(candidate.prepare(`PRAGMA table_xinfo("${table}")`).all() as {name:string}[]).map(row=>row.name);
        for(const name of names){
          if(name==='ordinal'&&table==='music_shouts')continue;
          let wanted=native?.[name]??after[name];if(columns.includes(name)&&(!native||!forwardEqual(before?.[name],after[name])))wanted=after[name];
          if(table==='music_selections'&&name==='position'&&selectionOrders.has(String(after.profile_id)))wanted=after[name];
          if(table==='music_legacy_profiles'&&name==='fields_json'&&native&&before&&different(before,after,['fields_json'])){if(!musicEqual(parseJson(String(row[name])),deltaJson(native[name],before[name],after[name])))reject();continue;}
          if((table==='music_profile_fields'||table==='music_profile_contacts')&&name==='revision')wanted=native?(native.revision as bigint)+1n:0n;
          if((table==='music_profile_fields'||table==='music_profile_contacts')&&name==='updated_at')wanted=reconstructedAt;
          if(!forwardEqual(row[name],wanted))reject();
        }
      }
      if(!musicEqual([...actual.keys()].sort(),[...wantedKeys].sort()))reject();
      for(const [key,native] of original){const before=a.get(key),after=b.get(key),positionChange=table==='music_selections'&&after&&selectionOrders.has(String(after.profile_id))&&!forwardEqual(native.position,after.position);if((!before&&!after)||(before&&after&&!different(before,after,columns)&&!positionChange)){
        const row=actual.get(key);if(table==='music_shouts'){const normalized={...row,ordinal:native.ordinal};if(!forwardEqual(normalized,native))reject();}else if(!forwardEqual(row,native))reject();
      }}counts[table]=actual.size;hash.update(forwardCanonical([table,[...actual]]));
    }
    const baseProfiles=tableRows(base,'music_profiles',['id']),nextProfiles=tableRows(next,'music_profiles',['id']),nativeProfiles=tableRows(s.board.native,'music_profiles',['id']),actualProfiles=tableRows(candidate,'music_profiles',['id']);
    for(const [key,after] of nextProfiles){const before=baseProfiles.get(key);if(!before||!forwardEqual(before.user_id,after.user_id)){profiles.add(String(after.id));for(const id of [before?.user_id,after.user_id])if(typeof id==='string'&&id)users.add(id);}}
    if(actualProfiles.size!==nativeProfiles.size+[...nextProfiles.keys()].filter(key=>!nativeProfiles.has(key)).length)reject();
    for(const [key,row] of actualProfiles){const native=nativeProfiles.get(key),after=nextProfiles.get(key);if(!after){if(!forwardEqual(row,native))reject();continue;}if(row.user_id!==after.user_id||row.erased_at!==null)reject();
      if(native){const expected:Row={...native,user_id:after.user_id,__forward_type_1:after.user_id===null?'null':'text'};if(profiles.has(String(row.id))){expected.revision=(native.revision as bigint)+1n;expected.updated_at=reconstructedAt;}if(!forwardEqual(row,expected))reject();}
      else if(row.revision!==0n||row.updated_at!==reconstructedAt||typeof row.__forward_rowid__!=='bigint'||row.__forward_rowid__<=rowHigh(s.board.native,'music_profiles'))reject();
    }
    const beforeEpochs=tableRows(s.board.native,'music_account_epochs',['user_id']),epochs=tableRows(candidate,'music_account_epochs',['user_id']);if(epochs.size!==beforeEpochs.size+[...users].filter(id=>!beforeEpochs.has(musicCanonical([id]))).length)reject();
    for(const [key,row] of epochs){const old=beforeEpochs.get(key);if(users.has(String(row.user_id))){if(row.epoch!==(old?.epoch as bigint|undefined??0n)+1n||old&&row.__forward_rowid__!==old.__forward_rowid__||!old&&(row.__forward_rowid__ as bigint)<=rowHigh(s.board.native,'music_account_epochs'))reject();}else if(!forwardEqual(row,old))reject();}
    const members=object(music.data.members,'verify merged members'),baseMembers=object(s.native.data.members,'verify base members');
    const authors=tableRows(candidate,'music_shout_authors',['profile_id']),oldAuthors=tableRows(s.board.native,'music_shout_authors',['profile_id']),authorChanges=new Map<string,number>();
    for(const key of music.keys){if(key.erased||key.retired)continue;const b=baseMembers[key.legacyKey]?object(baseMembers[key.legacyKey],'base member'):null,n=object(members[key.legacyKey],'merged member');if(!musicEqual(b?.lastShoutAt,n.lastShoutAt))authorChanges.set(key.profileId,Number(n.lastShoutAt??0));
      const picks=(candidate.prepare('SELECT entry_id,level FROM music_selections WHERE profile_id=? ORDER BY position').all(key.profileId) as {entry_id:string;level:number}[]).map(row=>[row.entry_id,row.level]),expected:unknown[][]=[],seen=new Set<string>();
      for(const raw of (n.selection??[]) as unknown[]){const value=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as {id?:unknown;entryId?:unknown;level?:unknown}:null,id=value?String(value.id||value.entryId||''):String(raw);let level=3;if(value?.level){const v=value.level;level=typeof v==='number'?Math.trunc(v):typeof v==='string'&&/^[+-]?\d+$/.test(v.trim())?Number(v):v===true?1:3;}level=Math.min(4,Math.max(1,level));if(id&&!seen.has(id)){seen.add(id);expected.push([id,level]);}}
      if(!musicEqual(picks,expected))reject();
    }
    if(authors.size!==oldAuthors.size+[...authorChanges.keys()].filter(id=>!oldAuthors.has(musicCanonical([id]))).length)reject();for(const [key,row] of authors){const old=oldAuthors.get(key),changed=authorChanges.get(String(row.profile_id));if(changed!==undefined){if(Number(row.last_post_at)!==changed||old&&row.__forward_rowid__!==old.__forward_rowid__||!old&&(row.__forward_rowid__ as bigint)<=rowHigh(s.board.native,'music_shout_authors'))reject();}else if(!forwardEqual(row,old))reject();}
    const creationBefore=[...forwardRows(s.board.native,'music_entry_creations')],expectedCreations=creationBefore.filter(row=>{
      if(!candidate.prepare('SELECT 1 FROM music_entries WHERE id=?').get(row.entry_id))return false;const key=music.keys.find(key=>key.profileId===row.profile_id);if(!key)return true;const n=members[key.legacyKey]?object(members[key.legacyKey],'member'):null,b=baseMembers[key.legacyKey]?object(baseMembers[key.legacyKey],'member'):null;return !n||musicEqual(b?.created??[],n.created??[])||(n.created as string[]).includes(String(row.entry_id));
    });if(!forwardEqual(expectedCreations,[...forwardRows(candidate,'music_entry_creations')]))reject();
    // Rate-limit rows are matched back to native rowids; the original old
    // identity rowids remain separately preserved in the pinned source image.
    const available=[...forwardRows(s.board.native,'music_claim_attempts')],binding=new Map<bigint,typeof available[number]>();for(const row of forwardRows(s.nativeIdentity,'login_attempts')){const i=available.findIndex(value=>value.bucket===row.bucket&&Number(value.created)===Number(row.created));if(i<0)reject();binding.set(row.__forward_rowid__,available.splice(i,1)[0]!);}if(available.length)reject();
    const wantedAttempts=new Map([...forwardRows(identity,'login_attempts')].map(row=>[row.__forward_rowid__,row])),actualAttempts=new Map([...forwardRows(candidate,'music_claim_attempts')].map(row=>[row.__forward_rowid__,row]));let retained=0;
    for(const [id,old] of binding){const after=wantedAttempts.get(id),row=actualAttempts.get(old.__forward_rowid__);if(!after){if(row)reject();continue;}const expected=old.bucket===after.bucket&&Number(old.created)===Number(after.created)?old:{...after,__forward_rowid__:old.__forward_rowid__};if(!forwardEqual(row,expected))reject();retained++;actualAttempts.delete(old.__forward_rowid__);}
    const originalHigh=rowHigh(s.board.native,'music_claim_attempts'),newAttempts=[...wantedAttempts].filter(([id])=>!binding.has(id)).map(([,row],index)=>({...row,__forward_rowid__:originalHigh+BigInt(index)+1n}));if(!forwardEqual([...actualAttempts.values()],newAttempts)||retained+actualAttempts.size!==wantedAttempts.size)reject();
    const oldShouts=tableRows(s.board.native,'music_shouts',['id']),allShouts=tableRows(candidate,'music_shouts',['id']),expectedOrdinals=new Map<string,bigint>();let ordinalHigh=[...oldShouts].filter(([key])=>allShouts.has(key)).map(([,row])=>row.ordinal as bigint).reduce((a,b)=>a>b?a:b,-1n);
    for(const key of tableRows(next,'music_shouts',['id']).keys())expectedOrdinals.set(key,oldShouts.has(key)?oldShouts.get(key)!.ordinal as bigint:++ordinalHigh);
    const ordered=[...allShouts].sort(([a,x],[b,y])=>{const left=expectedOrdinals.get(a)!,right=expectedOrdinals.get(b)!;return left<right?-1:left>right?1:x.__forward_rowid__<y.__forward_rowid__?-1:1;});let reordered=false;
    for(const kind of ['shouts','shoutHistory']){const expected=(music.data[kind] as {id:string}[]).map(row=>row.id),hypothetical=ordered.filter(([,row])=>(row.archived_at===null)===(kind==='shouts')).map(([,row])=>row.id),actual=(candidate.prepare(`SELECT id FROM music_shouts WHERE archived_at IS ${kind==='shouts'?'NULL':'NOT NULL'} ORDER BY ordinal,rowid`).all() as {id:string}[]).map(row=>row.id);if(!musicEqual(actual,expected))reject();if(!musicEqual(hypothetical,expected))reordered=true;}
    if(reordered){const list=[...(music.data.shoutHistory as {id:string}[]),...(music.data.shouts as {id:string}[])];for(const [index,row] of list.entries())expectedOrdinals.set(musicCanonical([row.id]),BigInt(index));}
    for(const [key,row] of allShouts)if(!forwardEqual(row.ordinal,expectedOrdinals.get(key)))reject();
    const runs=tableRows(candidate,'migration_runs',['source_digest']),oldRuns=tableRows(s.board.native,'migration_runs',['source_digest']);if(runs.size!==oldRuns.size+1)reject();for(const [key,row] of oldRuns)if(!forwardEqual(row,runs.get(key)))reject();
    const record=runs.get(musicCanonical([run]));if(!record||record.created_at!==reconstructedAt||record.__forward_rowid__!==rowHigh(s.board.native,'migration_runs')+1n)reject();const manifest=object(parseJson(String(record.manifest_json)),'forward manifest'),pins=Object.fromEntries(Object.entries(input).map(([key,item])=>[key,item.sha256]));
    if(!musicEqual(manifest,{version:1,kind:'forward_business',sourcePins:pins,mergedMusicSha256:forwardHash(musicCanonical(music)),mergedIdentitySha256:forwardHash(identityImage),reconstructedAt}))reject();
    if(!musicEqual(parseJson(String(record.report_json)),{tables:changeCounts,changedProfiles:profiles.size,ownershipEpochs:users.size,proofReconciliationRequired:true,sourceRebaseRequired:true,releaseEligible:false}))reject();
    const storage=[...forwardRows(candidate,'rebuild_storage')],originalStorage=[...forwardRows(s.board.native,'rebuild_storage')];if(storage.length!==1||storage[0]!.recovery_required!==1n||!forwardEqual({...storage[0],recovery_required:originalStorage[0]!.recovery_required},originalStorage[0]))reject();
    const sequence=(db:DB)=>[...forwardRows(db,'sqlite_sequence')].map(row=>[row.name,row.seq]);const expectedSequence=new Map(sequence(s.board.native) as [string,bigint][]);for(const [name,value] of sequence(s.board.old) as [string,bigint][])if(boardTables.includes(name))expectedSequence.set(name,(expectedSequence.get(name)??0n)>value?expectedSequence.get(name)!:value);if(!forwardEqual(sequence(candidate).sort(),[...expectedSequence].sort()))reject();
    return {version:1 as const,sourceGraphVerified:true as const,originalNativeHistoryAndReceiptsPreserved:true as const,changedProfiles:profiles.size,ownershipEpochs:users.size,checkedTables:counts,rowsDigest:hash.digest('hex'),recoveryRequired:true as const,releaseEligible:false as const};
  }finally{for(const db of models.reverse())db.close();s.close();}
}
export function verifyForwardBusiness(input:ForwardMusicInput,image:Buffer,music:RollbackMusic,identityImage:Buffer,reconstructedAt:string){
  const held=copyForwardMusicInput(input);assertForwardImage(image);const db=new Database(Buffer.from(image)),pins=Object.fromEntries(Object.entries(held).map(([key,item])=>[key,item.sha256])),run=forwardHash('qgroup:forward-business:v1:'+musicCanonical(pins));
  try{return reconcileForwardBusiness(held,db,music,identityImage,reconstructedAt,run);}finally{db.close();}
}
