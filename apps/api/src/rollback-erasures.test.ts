import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it} from 'vitest';
import Database from 'better-sqlite3';
import {legacyHistoryFixture} from '../testsupport/legacy-history-fixture';
import {erasureJournal,readVerifiedErasureJournal,type ErasureIntent,type StoredIntent} from './erasure-journal';
import {createPrivacy} from './privacy';
import {saveProfile} from './repositories';
import {hash} from './security';
import {profileId} from '../../../tools/migration/music-codec';
import {projectRollbackMusic} from '../../../tools/migration/rollback-music';
import {projectRollbackIdentity} from '../../../tools/migration/rollback-identity';
import {verifyRollbackIdentity} from '../../../tools/migration/rollback-identity-reconciliation';
import {projectRollbackBoard} from '../../../tools/migration/rollback-board';
import {verifyRollbackBoard} from '../../../tools/migration/rollback-board-reconciliation';
import {captureRollbackCheckpoint} from '../../../tools/migration/rollback-checkpoint';
import {projectRollbackErasures,type RollbackErasures} from '../../../tools/migration/rollback-erasures';
import {verifyRollbackErasures} from '../../../tools/migration/rollback-erasures-reconciliation';
const cleanup:(()=>void)[]=[];afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
async function setup(options:Parameters<typeof legacyHistoryFixture>[0]={}){const s=await legacyHistoryFixture(options);cleanup.push(()=>s.close());return {...s,journal:erasureJournal(s.db)};}
type Source=Awaited<ReturnType<typeof setup>>;
const rows=(text:string)=>text.trim()?text.trim().split('\n').map(line=>JSON.parse(line) as Record<string,unknown>):[];
function submit(s:Source,fields:Record<string,unknown>){const privacy=createPrivacy(s.db,s.journal),entry={...fields,requestId:randomUUID(),secretHash:hash('secret'),signature:hash('operation'),createdAt:'2026-11-19T02:00:00.000Z'} as ErasureIntent;s.db.transaction(()=>privacy.submit(entry)).immediate();privacy.guard();return entry;}
function project(s:Source){const music=projectRollbackMusic(s.db,s.journal);return {music,result:projectRollbackErasures(s.db,s.journal,music)};}
it.each(['music','account','both'] as const)('projects latest %s scope without mixing music erasures and account closures',async(kind)=>{
  const s=await setup(),entry=submit(s,{version:1,kind,userId:'bob',profileId:profileId('10002')}),before=s.db.serialize(),{music,result}=project(s);
  expect(rows(result.boardJournal)).toEqual(kind==='music'?[]:[{user_id:'bob',request_id:entry.requestId,created_at:entry.createdAt}]);
  expect(rows(result.musicJournal)).toEqual(kind==='account'?[]:[{qq:'10002',erased_at:entry.createdAt}]);
  expect(rows(result.unifiedJournal)).toEqual([entry]);expect(result.scopes).toEqual([{requestId:entry.requestId,kind,profileKeys:kind==='account'?[]:['10002'],entries:[],alreadyApplied:true}]);
  expect(result.report).toMatchObject({rollbackEligible:false,scopePolicy:'latest_projected_data_only',unifiedEntries:1,scopes:1});
  expect(Object.keys(result.report.digests).sort()).toEqual(['boardJournal','musicJournal','scopes','unifiedJournal']);
  expect(s.db.serialize()).toEqual(before);expect(s.db.transaction(()=>verifyRollbackErasures(s.db,result,music,[entry])).immediate()).toEqual(result.report);
});
it('retains original legacy closure ID and unknown original time without inventing a timestamp',async()=>{
  const closure={user_id:'bob',request_id:'original-closure',created_at:'original-unknown-zone'};
  const s=await setup({boardLedger:JSON.stringify(closure)+'\n'}),{result}=project(s);
  expect(rows(result.boardJournal)).toEqual([closure]);expect(rows(result.unifiedJournal)).toEqual([closure]);expect(result.scopes).toEqual([{requestId:closure.request_id,kind:'account',profileKeys:[],entries:[],alreadyApplied:true}]);
  expect(rows(result.musicJournal)).toEqual([]);
});
it('preserves imported closure markers absent from the journal, including earlier markers for a later duplicate closure',async()=>{
  const s=await setup(),first=submit(s,{version:1,kind:'account',userId:'bob',profileId:null});
  // The first durable marker survives an additional already-closed request.
  const later=submit(s,{version:1,kind:'account',userId:'bob',profileId:null});
  s.db.prepare('DELETE FROM erasure_applied WHERE request_id=?').run(first.requestId);
  const current={read:()=>[later],append(){throw Error('Read-only synthetic journal');}};
  const music=projectRollbackMusic(s.db,current),result=projectRollbackErasures(s.db,current,music);
  expect(rows(result.boardJournal)).toEqual([later,first].map(entry=>({user_id:'bob',request_id:entry.requestId,created_at:entry.createdAt})));
  expect(rows(result.unifiedJournal)).toEqual([later]);expect(result.scopes).toHaveLength(1);
});
it.each([null,false,123,'unknown-old-time',{original:'unclassified-time-representation'}])('retains legacy erased_at representation %j and a historical key with no surviving body',async(time)=>{
  const s=await setup({musicLedger:JSON.stringify({qq:'99999',erased_at:time})+'\n'}),{result}=project(s);
  expect(rows(result.musicJournal)).toEqual([{qq:'99999',erased_at:time}]);expect(result.boardJournal).toBe('');expect(result.unifiedJournal).toBe('');expect(result.scopes).toEqual([]);
});
it('retains duplicate durable entries exactly once in old ledgers and scopes',async()=>{
  const s=await setup(),entry=submit(s,{version:1,kind:'both',userId:'bob',profileId:profileId('10002')});s.journal.append(entry);
  const {result}=project(s);expect(rows(result.unifiedJournal)).toEqual([entry,entry]);expect(rows(result.boardJournal)).toHaveLength(1);expect(rows(result.musicJournal)).toHaveLength(1);expect(result.scopes).toHaveLength(1);expect(result.report.unifiedEntries).toBe(2);
});
it('maps erased newly created native profiles to deterministic old keys',async()=>{
  const s=await setup();s.db.prepare('UPDATE music_profiles SET user_id=NULL WHERE id=?').run(profileId('10002'));
  const native=saveProfile(s.db,'bob',{profileId:null,revision:0,musicEpoch:0,selections:[]},new Date('2026-11-19T01:00:00Z'));
  const entry=submit(s,{version:2,kind:'admin_music',command:'delete_profile',actorRef:'account:alice',profiles:[{id:native.id,userId:'bob'}],entries:[]}),{music,result}=project(s),key=music.keys.find(row=>row.profileId===native.id)!;
  expect(key).toMatchObject({mode:'generated',erased:true});expect(rows(result.musicJournal)).toEqual([{qq:key.legacyKey,erased_at:entry.createdAt}]);expect(result.scopes).toEqual([{requestId:entry.requestId,kind:'delete_profile',profileKeys:[key.legacyKey],entries:[],alreadyApplied:true}]);expect(result.boardJournal).toBe('');
});
it.each(['board missing','board user','board time','board extra','music missing','music key','music time','music extra','unified missing','unified duplicates','unified extra','scope missing','scope keys','scope entries','scope applied','scope command','extra root','missing newline','duplicate JSON keys','blank line'])('independently rejects changed %s instead of trusting attached reports',async(change)=>{
  const s=await setup(),entry=submit(s,{version:1,kind:'both',userId:'bob',profileId:profileId('10002')}),{music,result}=project(s),copy:RollbackErasures=structuredClone(result);
  const edit=(field:'boardJournal'|'musicJournal'|'unifiedJournal',value:Record<string,unknown>)=>{copy[field]=JSON.stringify(value)+'\n';};
  if(change==='board missing')copy.boardJournal='';if(change==='board user')edit('boardJournal',{...rows(copy.boardJournal)[0],user_id:'alice'});if(change==='board time')edit('boardJournal',{...rows(copy.boardJournal)[0],created_at:'wrong'});if(change==='board extra')edit('boardJournal',{...rows(copy.boardJournal)[0],extra:true});
  if(change==='music missing')copy.musicJournal='';if(change==='music key')edit('musicJournal',{...rows(copy.musicJournal)[0],qq:'10001'});if(change==='music time')edit('musicJournal',{...rows(copy.musicJournal)[0],erased_at:123});if(change==='music extra')edit('musicJournal',{...rows(copy.musicJournal)[0],extra:true});
  if(change==='unified missing')copy.unifiedJournal='';if(change==='unified duplicates')copy.unifiedJournal+=copy.unifiedJournal;if(change==='unified extra')edit('unifiedJournal',{...entry,extra:true});
  if(change==='scope missing')copy.scopes=[];if(change==='scope keys')copy.scopes[0]!.profileKeys=['10001'];if(change==='scope entries')copy.scopes[0]!.entries=['e'];if(change==='scope applied')Object.assign(copy.scopes[0]!,{alreadyApplied:false});if(change==='scope command')copy.scopes[0]!.kind='reset_music';
  if(change==='extra root')Object.assign(copy,{extra:true});if(change==='missing newline')copy.musicJournal=copy.musicJournal.trimEnd();if(change==='duplicate JSON keys')copy.unifiedJournal=copy.unifiedJournal.replace('"kind":"both"','"kind":"music","kind":"both"');if(change==='blank line')copy.unifiedJournal+='\n';
  expect(()=>s.db.transaction(()=>verifyRollbackErasures(s.db,copy,music,[entry])).immediate()).toThrow();
});
it.each(['missing journal','conflicting journal','receipt','scope tombstone','closure marker','closure user','closure time','closure ID','erasure time','unsafe old time'])('rejects inconsistent latest source %s while preserving the complete pre-change checkpoint',async(change)=>{
  const s=await setup(),entry=submit(s,{version:1,kind:'both',userId:'bob',profileId:profileId('10002')}),checkpoint=captureRollbackCheckpoint(s.db,s.journal),{music}=project(s);
  let journal=s.journal;
  if(change==='missing journal')journal={read:()=>[],append(){throw Error();}};
  if(change==='conflicting journal')journal={read:()=>[entry,{...entry,userId:'alice'} as StoredIntent],append(){throw Error();}};
  if(change==='receipt')s.db.prepare("UPDATE privacy_receipts SET signature=?").run(hash('wrong'));
  if(change==='scope tombstone')s.db.prepare('UPDATE music_profiles SET erased_at=NULL WHERE id=?').run(profileId('10002'));
  if(change==='closure marker')s.db.prepare("DELETE FROM privacy_requests WHERE user_id='bob'").run();
  if(change==='closure user')s.db.prepare("UPDATE privacy_requests SET user_id='alice' WHERE user_id='bob'").run();
  if(change==='closure time')s.db.prepare("UPDATE privacy_requests SET created_at='wrong' WHERE user_id='bob'").run();
  if(change==='closure ID')s.db.prepare("UPDATE privacy_requests SET id=? WHERE user_id='bob'").run(submit(s,{version:1,kind:'music',userId:'alice',profileId:profileId('10001')}).requestId);
  if(change==='erasure time')s.db.prepare("UPDATE music_profiles SET erased_at='unknown' WHERE id=?").run(profileId('10002'));
  if(change==='unsafe old time')s.db.prepare("INSERT INTO music_legacy_erasures VALUES('99999','1e100')").run();
  const before=s.db.serialize();expect(()=>projectRollbackErasures(s.db,journal,music)).toThrow();expect(s.db.serialize()).toEqual(before);
  const retained=new Database(checkpoint.image);try{expect(retained.prepare("SELECT user_id FROM privacy_requests").all()).toEqual([{user_id:'bob'}]);}finally{retained.close();}
});
it('rejects nested deferred transactions and verifier reads without the held source transaction',async()=>{
  const s=await setup(),{music,result}=project(s);s.db.transaction(()=>expect(()=>projectRollbackErasures(s.db,s.journal,music)).toThrow('standalone')).deferred();expect(()=>verifyRollbackErasures(s.db,result,music,[])).toThrow('held source transaction');
});
it.each(['close','reset'] as const)('replays original Python privacy and music maintenance twice on latest %s projections without changing data',async(command)=>{
  const s=await setup();
  if(command==='close')submit(s,{version:1,kind:'both',userId:'bob',profileId:profileId('10002')});
  else{
    submit(s,{version:2,kind:'admin_music',command:'reset_music',actorRef:'account:alice',profiles:s.db.prepare('SELECT id,user_id AS userId FROM music_profiles WHERE erased_at IS NULL ORDER BY rowid').all(),entries:['e']});
    // Reusing a deleted entry ID is still a new write: old ledgers must not
    // apply the administrative reset a second time to current projections.
    s.db.prepare("INSERT INTO music_entries VALUES('e','重設後的新詞條','sub')").run();
    const epoch=(s.db.prepare("SELECT epoch FROM music_account_epochs WHERE user_id='bob'").get() as {epoch:number}).epoch;
    const native=saveProfile(s.db,'bob',{profileId:null,revision:0,musicEpoch:epoch,selections:[{entryId:'e',level:4}]},new Date('2026-11-19T03:00:00Z'));
    s.db.prepare("INSERT INTO music_entry_details VALUES('e','歌手','[]',?,'123','null')").run(native.id);
    s.db.prepare("INSERT INTO music_shouts VALUES('after-reset',?,'','新作者','新喊話',456,NULL,0)").run(native.id);
  }
  const before=s.db.serialize(),{music,result}=project(s),board=projectRollbackBoard(s.db),identity=projectRollbackIdentity(s.db,s.journal,music),root=mkdtempSync(join(tmpdir(),'qgroup-rollback-erasures-python-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));cleanup.push(()=>board.db.close());cleanup.push(()=>identity.db.close());
  const boardPath=join(root,'board.sqlite3'),identityPath=join(root,'identity.sqlite3');
  for(const [name,bytes] of [['board.sqlite3',board.db.serialize()],['identity.sqlite3',identity.db.serialize()],['data.json',JSON.stringify(music.data)],['board.erasures.jsonl',result.boardJournal],['erasures.jsonl',result.musicJournal]] as const)writeFileSync(join(root,name),bytes,{mode:0o600});
  execFileSync('python3',['-c',`import sys
from pathlib import Path
from qgroup_core.privacy import recover
from music_site.maintenance import replay
from music_site.identity_store import Store
folder=Path(sys.argv[1]);store=Store(folder/'identity.sqlite3')
for _ in range(2):
    recover(folder/'board.sqlite3')
    replay(folder,store)
`,root],{encoding:'utf8'});
  expect(JSON.parse(readFileSync(join(root,'data.json'),'utf8'))).toEqual(music.data);
  const afterBoard=new Database(boardPath),afterIdentity=new Database(identityPath);try{
    s.db.transaction(()=>{
      expect(verifyRollbackBoard(s.db,afterBoard)).toEqual(board.report);
      expect(verifyRollbackIdentity(s.db,afterIdentity,music,readVerifiedErasureJournal(s.db,s.journal),identity.report.auditMappings)).toEqual(identity.report);
    }).immediate();
  }finally{afterBoard.close();afterIdentity.close();}
  expect(s.db.serialize()).toEqual(before);
  if(command==='reset'){expect(result.boardJournal).toBe('');expect(result.scopes[0]!.entries).toEqual(['e']);expect(music.data.entries).toHaveProperty('e.text','重設後的新詞條');expect(music.data.shouts).toHaveLength(1);expect(Object.keys(music.data.members as object)).toHaveLength(1);}
});
