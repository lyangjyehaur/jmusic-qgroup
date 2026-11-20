import Database from 'better-sqlite3';
import {z} from 'zod';
import type {DB} from '@qgroup/database';
import {copyForwardMusicInput,openForwardMusicSources,musicBytes,musicRecord,musicCanonical,type ForwardMusicInput} from './forward-music-sources';
import {forwardHash,forwardRows,forwardEqual,assertForwardImage,type PinnedForwardBytes} from './forward-board-storage';
import {mergeForwardMusicRows} from './forward-music-rows';
import {reconcileForwardMusicRows} from './forward-music-reconciliation';
import {cleanupForwardAccountMusic,verifyForwardAccountMusic} from './forward-account-music-sources';
import {openForwardBoardAccountAuthority,guardForwardBoardAccountInput} from './forward-board-account-source';
import {mergeForwardBoardAccountClosures} from './forward-board-account-merge';
import {verifyForwardBoardAccountClosures} from './forward-board-account-reconciliation';
import {projectRollbackStateFromCheckpoint} from './rollback-state';
import {verifyRollbackBoard} from './rollback-board-reconciliation';
import {verifyRollbackMusic} from './rollback-music-reconciliation';
import {verifyRollbackIdentity} from './rollback-identity-reconciliation';
import {assertRollbackSource} from './rollback-source';
import {schemaObjects} from './board-reconciliation';
import {object,keys} from './music-codec';
import type {RollbackMusic} from './rollback-music';

export type ForwardAccountEpochInput={sources:ForwardMusicInput;authorityRoot:string;manifestSha256:string;preparedAt:string};
export type ForwardAccountEpoch={sources:ForwardMusicInput;accountBase:PinnedForwardBytes;rawMusic:PinnedForwardBytes;rawIdentity:PinnedForwardBytes;cleanMusic:PinnedForwardBytes;cleanIdentity:PinnedForwardBytes};
export const accountPin=(bytes:Buffer):PinnedForwardBytes=>({bytes:Buffer.from(bytes),sha256:forwardHash(bytes)});
function pinned(row:PinnedForwardBytes,json=false){if(!row||!Buffer.isBuffer(row.bytes)||forwardHash(row.bytes)!==row.sha256)throw Error('Account epoch evidence pin differs');if(json){if(row.bytes.length>64*1024*1024)throw Error('Account epoch JSON exceeds limit');}else assertForwardImage(row.bytes);return row;}
function music(row:PinnedForwardBytes){const value=object(musicBytes(pinned(row,true).bytes),'account epoch music');keys(value,['data','keys'],'account epoch music');if(!Array.isArray(value.keys))throw Error('Incomplete account music mapping');return value as unknown as RollbackMusic;}
function manifest(input:ForwardAccountEpochInput,e:ForwardAccountEpoch,sequence:number,head:string|null){return {version:1,kind:'forward_account_epoch',sourcePins:Object.fromEntries(Object.entries(input.sources).map(([key,row])=>[key,row.sha256])),authoritySha256:input.manifestSha256,authorityHeadSequence:sequence,authorityHeadSha256:head,accountBaseSha256:e.accountBase.sha256,rawMusicSha256:e.rawMusic.sha256,rawIdentitySha256:e.rawIdentity.sha256,cleanMusicSha256:e.cleanMusic.sha256,cleanIdentitySha256:e.cleanIdentity.sha256,preparedAt:input.preparedAt};}
function guard(input:ForwardAccountEpochInput,held:ForwardMusicInput,a:ReturnType<typeof openForwardBoardAccountAuthority>,root:string,pin:string,stamp:string,boundary?:()=>void){
  guardForwardBoardAccountInput(input,held,a,root,pin,boundary);
  if(input.preparedAt!==stamp)throw Error('Account epoch preparation time changed');
  for(const key of Object.keys(held) as (keyof ForwardMusicInput)[])if(input.sources[key].sha256!==held[key].sha256||!input.sources[key].bytes.equals(held[key].bytes))throw Error('Account epoch original source changed');
}
/** The derived reconstruction input is created only after original three-way
 * choices and account authority checks. It is not a normalized replacement for
 * any original source; the binding preserves every original pin and raw pair. */
export function prepareForwardAccountEpoch(input:ForwardAccountEpochInput,boundary?:()=>void){
  z.iso.datetime().parse(input.preparedAt);const held=copyForwardMusicInput(input.sources),root=input.authorityRoot,pin=input.manifestSha256,stamp=input.preparedAt,s=openForwardMusicSources(held),opened:DB[]=[];
  const open=(bytes:Buffer)=>{const db=new Database(bytes);opened.push(db);return db;};
  try{
    const a=openForwardBoardAccountAuthority(input,held,s.board);guard(input,held,a,root,pin,stamp,boundary);
    const raw=mergeForwardMusicRows(s);opened.push(raw.identity);reconcileForwardMusicRows(s,raw.music,raw.identity);
    const board=mergeForwardBoardAccountClosures({sources:held,authorityRoot:root,manifestSha256:pin}),base=open(board.nativeImage),clean=cleanupForwardAccountMusic(s,base,raw.music,raw.identity,a.closed);opened.push(clean.identity);
    verifyForwardAccountMusic(s,base,raw.music,raw.identity,a.closed,clean.music,clean.identity);
    const e={sources:{} as ForwardMusicInput,accountBase:accountPin(board.nativeImage),rawMusic:accountPin(Buffer.from(JSON.stringify(raw.music))),rawIdentity:accountPin(raw.identity.serialize()),cleanMusic:accountPin(Buffer.from(JSON.stringify(clean.music))),cleanIdentity:accountPin(clean.identity.serialize())};
    const bound=open(board.nativeImage),record=manifest({...input,sources:held},e,a.authority.head.sequence,a.authority.head.recordSha256),run=forwardHash('qgroup:forward-account-epoch:v1:'+musicCanonical(record));
    bound.transaction(()=>{
      const high=[...forwardRows(bound,'migration_runs')].reduce((high,row)=>high>row.__forward_rowid__?high:row.__forward_rowid__,0n);if(high===9223372036854775807n)throw Error('Account epoch run rowid exceeds capacity');
      bound.prepare('INSERT INTO migration_runs(rowid,source_digest,manifest_json,report_json,created_at) VALUES(?,?,?,?,?)').run(high+1n,run,JSON.stringify(record),JSON.stringify({originalSourcesRetained:true,accountAuthorityVerified:true,rawThreeWayRelationVerified:true,derivedInputOnly:true,externalRetentionVerified:false,releaseEligible:false}),stamp);
    }).immediate();
    const state=projectRollbackStateFromCheckpoint(bound.serialize(),a.journalReader.read()),journal=accountPin(a.journal);
    e.sources={checkpoint:accountPin(state.checkpointImage),baselineBoard:accountPin(state.boardImage),baselineJournal:journal,nativeImage:accountPin(state.checkpointImage),nativeJournal:accountPin(a.journal),oldBoard:accountPin(state.boardImage),baselineMusic:accountPin(Buffer.from(JSON.stringify({...state.music,identityAuditMappings:state.identityAuditMappings}))),baselineIdentity:accountPin(state.identityImage),oldMusic:accountPin(Buffer.from(JSON.stringify(clean.music.data))),oldIdentity:accountPin(e.cleanIdentity.bytes)};
    const verification=verifyForwardAccountEpoch({...input,sources:held},e);guard(input,held,a,root,pin,stamp,boundary);
    return {...e,report:verification};
  }finally{for(const db of opened.reverse())db.close();s.close();}
}
/** Reads original sources, the authority, every pre/post-cleanup row and the
 * derived checkpoint. No preparation writer or migration report is trusted. */
export function verifyForwardAccountEpoch(input:ForwardAccountEpochInput,epoch:ForwardAccountEpoch){
  z.iso.datetime().parse(input.preparedAt);const held=copyForwardMusicInput(input.sources),root=input.authorityRoot,pin=input.manifestSha256,stamp=input.preparedAt,s=openForwardMusicSources(held),opened:DB[]=[];
  const open=(bytes:Buffer)=>{const db=new Database(bytes);opened.push(db);return db;};
  try{
    const a=openForwardBoardAccountAuthority(input,held,s.board);guard(input,held,a,root,pin,stamp);
    const e={...epoch,sources:copyForwardMusicInput(epoch.sources)};for(const key of ['accountBase','rawIdentity','cleanIdentity'] as const)pinned(e[key]);
    const raw=music(e.rawMusic),clean=music(e.cleanMusic),rawIdentity=open(e.rawIdentity.bytes),identity=open(e.cleanIdentity.bytes),base=open(e.accountBase.bytes);
    const board=verifyForwardBoardAccountClosures({sources:held,authorityRoot:root,manifestSha256:pin},e.accountBase.bytes),rows=reconcileForwardMusicRows(s,raw,rawIdentity),cleanup=verifyForwardAccountMusic(s,base,raw,rawIdentity,a.closed,clean,identity);
    if(!e.sources.checkpoint.bytes.equals(e.sources.nativeImage.bytes)||!e.sources.baselineBoard.bytes.equals(e.sources.oldBoard.bytes)||!e.sources.nativeJournal.bytes.equals(a.journal)||!e.sources.baselineJournal.bytes.equals(a.journal)||!e.sources.oldIdentity.bytes.equals(e.cleanIdentity.bytes)||!e.sources.oldMusic.bytes.equals(Buffer.from(JSON.stringify(clean.data))))throw Error('Derived account source pair differs');
    const db=open(e.sources.checkpoint.bytes);db.transaction(()=>assertRollbackSource(db)).immediate();base.transaction(()=>assertRollbackSource(base)).immediate();
    if(!forwardEqual(schemaObjects(base),schemaObjects(db)))throw Error('Account epoch schema differs');for(const name of ['user_version','application_id','encoding'])if(base.pragma(name,{simple:true})!==db.pragma(name,{simple:true}))throw Error('Account epoch metadata differs');
    const record=manifest({...input,sources:held},e,a.authority.head.sequence,a.authority.head.recordSha256),run=forwardHash('qgroup:forward-account-epoch:v1:'+musicCanonical(record));
    const originalRuns=[...forwardRows(base,'migration_runs')],high=originalRuns.reduce((high,row)=>high>row.__forward_rowid__?high:row.__forward_rowid__,0n),expected={__forward_rowid__:high+1n,source_digest:run,manifest_json:JSON.stringify(record),report_json:JSON.stringify({originalSourcesRetained:true,accountAuthorityVerified:true,rawThreeWayRelationVerified:true,derivedInputOnly:true,externalRetentionVerified:false,releaseEligible:false}),created_at:stamp,__forward_type_0:'text',__forward_type_1:'text',__forward_type_2:'text',__forward_type_3:'text'};
    for(const table of [...schemaObjects(base).filter(row=>row.type==='table').map(row=>row.name),'sqlite_sequence']){
      const wanted=[...forwardRows(base,table)];if(table==='migration_runs')wanted.push(expected);if(!forwardEqual(wanted,[...forwardRows(db,table)]))throw Error('Account epoch checkpoint row differs in '+table);
    }
    const baseline=musicRecord(musicBytes(e.sources.baselineMusic.bytes)),baselineIdentity=open(e.sources.baselineIdentity.bytes),baselineBoard=open(e.sources.baselineBoard.bytes),intents=a.journalReader.read();
    verifyRollbackBoard(db,baselineBoard);db.transaction(()=>{verifyRollbackMusic(db,baseline,intents);verifyRollbackIdentity(db,baselineIdentity,baseline,intents,baseline.identityAuditMappings);}).immediate();
    guard(input,held,a,root,pin,stamp);
    return {version:1 as const,sourceDigest:run,originalSourcePins:Object.fromEntries(Object.entries(held).map(([key,row])=>[key,row.sha256])),authoritySha256:pin,authorityHeadSequence:a.authority.head.sequence,authorityHeadSha256:a.authority.head.recordSha256,board,rawRows:rows,cleanup,allDerivedSourcesVerified:true as const,externalRetentionVerified:false as const,recoveryRequired:true as const,releaseEligible:false as const};
  }finally{for(const db of opened.reverse())db.close();s.close();}
}
