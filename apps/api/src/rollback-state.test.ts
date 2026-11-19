import {randomUUID} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import Database from 'better-sqlite3';
import type {DB} from '@qgroup/database';
import {legacyHistoryFixture} from '../testsupport/legacy-history-fixture';
import {erasureJournal,readVerifiedErasureJournal,type ErasureIntent} from './erasure-journal';
import {createPrivacy} from './privacy';
import {hash} from './security';
import {saveProfile} from './repositories';
import {profileId} from '../../../tools/migration/music-codec';
import * as musicProjection from '../../../tools/migration/rollback-music';
import * as boardProjection from '../../../tools/migration/rollback-board';
import * as identityProjection from '../../../tools/migration/rollback-identity';
import {projectRollbackState,type RollbackState} from '../../../tools/migration/rollback-state';
import {verifyRollbackState} from '../../../tools/migration/rollback-state-reconciliation';
const cleanup:(()=>void)[]=[];afterEach(()=>{vi.restoreAllMocks();for(const close of cleanup.splice(0).reverse())close();});
async function setup(){const s=await legacyHistoryFixture();cleanup.push(()=>s.close());return {...s,journal:erasureJournal(s.db)};}
type Source=Awaited<ReturnType<typeof setup>>;
function submit(s:Source,fields:Record<string,unknown>){const privacy=createPrivacy(s.db,s.journal),entry={...fields,requestId:randomUUID(),secretHash:hash('secret'),signature:hash('operation'),createdAt:'2026-11-19T02:00:00.000Z'} as ErasureIntent;s.db.transaction(()=>privacy.submit(entry)).immediate();privacy.guard();return entry;}
function changeImage(image:Buffer,change:(db:DB)=>void){const db=new Database(image);try{change(db);return db.serialize();}finally{db.close();}}
it('assembles all domains from one full checkpoint, preserving source, raw bot work and new-only audit/receipts/consent',async()=>{
  const s=await setup();
  s.db.prepare("INSERT INTO bot_outbox(event_id,kind,dedupe_key,target,payload_json,status,claim_token,created_at) VALUES('listen','fixed','fixed','synthetic','{}','sending','reserved-claim','after')").run();
  s.db.prepare("INSERT INTO unified_privacy_consents VALUES('bob','new-policy','after','explicit')").run();
  s.db.prepare("INSERT INTO unified_privacy_receipts VALUES('bob','new-receipt','new-policy','synthetic-signature')").run();
  s.db.prepare("INSERT INTO admin_audit VALUES(?,?,-2,3,'after')").run(9007199254740993n,'new-audit');
  s.db.prepare("INSERT INTO music_ownership_history(profile_id,revision,actor_ref,before_user_id,after_user_id,reason,created_at) VALUES(?,1,'account:alice','alice','alice','kept','2026-11-19T01:00:00Z')").run(profileId('10001'));
  const before=s.db.serialize(),result=projectRollbackState(s.db,s.journal),fixed=new Database(result.checkpointImage),board=new Database(result.boardImage),identity=new Database(result.identityImage);
  try{
    expect(result.report.rollbackEligible).toBe(false);expect(result.report.remaining).toContain('fixed_old_web_music_bot_rehearsal');
    expect(Object.keys(result.report.digests)).toHaveLength(7);
    expect(board.prepare('SELECT * FROM bot_outbox').all()).toEqual(s.db.prepare('SELECT * FROM bot_outbox').all());
    expect(fixed.prepare('SELECT * FROM unified_privacy_consents').all()).toEqual(s.db.prepare('SELECT * FROM unified_privacy_consents').all());
    expect(fixed.prepare('SELECT * FROM unified_privacy_receipts').all()).toEqual(s.db.prepare('SELECT * FROM unified_privacy_receipts').all());
    expect(fixed.prepare('SELECT * FROM music_ownership_history').all()).toEqual(s.db.prepare('SELECT * FROM music_ownership_history').all());
    expect(fixed.prepare('SELECT id FROM admin_audit').safeIntegers(true).get()).toEqual({id:9007199254740993n});
    expect(identity.prepare('SELECT actor,qq,before_user_id,after_user_id FROM link_audit').all()).toEqual([{actor:'account:alice',qq:'10001',before_user_id:'alice',after_user_id:'alice'}]);
    expect(result.identityAuditMappings).toEqual([{source:'ownership',sourceId:'1',legacyId:'1'}]);
    expect(result.music.data.entries).toEqual(s.data.entries);expect(result.erasures).toEqual({boardJournal:'',musicJournal:'',unifiedJournal:'',scopes:[]});
    expect(fixed.transaction(()=>verifyRollbackState(fixed,result,result.journal)).immediate()).toEqual(result.report);
    expect(projectRollbackState(s.db,s.journal).report.digests).toEqual(result.report.digests);
    expect(s.db.serialize()).toEqual(before);
  }finally{identity.close();board.close();fixed.close();}
});
it('reads the live durable journal once and keeps every domain fixed when the live source changes mid-assembly',async()=>{
  const s=await setup();let reads=0;const original=musicProjection.projectRollbackMusic;
  vi.spyOn(musicProjection,'projectRollbackMusic').mockImplementationOnce((db,journal)=>{
    expect(db).not.toBe(s.db);expect(s.db.inTransaction).toBe(false);
    s.db.prepare("UPDATE events SET title='live changed' WHERE id='listen'").run();
    s.db.prepare("UPDATE music_entries SET name='live changed' WHERE id='e'").run();
    submit(s,{version:1,kind:'both',userId:'bob',profileId:profileId('10002')});
    return original(db,journal);
  });
  const result=projectRollbackState(s.db,{read:()=>{reads++;return s.journal.read();},append(){throw Error();}}),fixed=new Database(result.checkpointImage),board=new Database(result.boardImage),identity=new Database(result.identityImage);
  try{
    expect(reads).toBe(1);expect(result.journal).toEqual([]);expect(result.erasures.boardJournal).toBe('');expect(result.erasures.musicJournal).toBe('');
    expect(board.prepare("SELECT title FROM events WHERE id='listen'").get()).not.toEqual({title:'live changed'});
    expect(result.music.data.entries).toHaveProperty('e.text','歷史詞條');expect(result.music.data.members).toHaveProperty('10002.boardUserId','bob');
    expect(identity.prepare("SELECT user_id FROM prelinks WHERE qq='10002'").get()).toEqual({user_id:'bob'});
    expect(fixed.transaction(()=>verifyRollbackState(fixed,result,[])).immediate()).toEqual(result.report);
    expect(()=>s.db.transaction(()=>verifyRollbackState(s.db,result,readVerifiedErasureJournal(s.db,s.journal))).immediate()).toThrow();
  }finally{identity.close();board.close();fixed.close();}
});
it('combines reset scopes, post-reset new writes and latest receipts without exposing an old reset as a new operation',async()=>{
  const s=await setup(),entry=submit(s,{version:2,kind:'admin_music',command:'reset_music',actorRef:'account:alice',profiles:s.db.prepare('SELECT id,user_id AS userId FROM music_profiles WHERE erased_at IS NULL ORDER BY rowid').all(),entries:['e']});
  s.db.prepare("INSERT INTO music_entries VALUES('after','新詞條','sub')").run();const epoch=(s.db.prepare("SELECT epoch FROM music_account_epochs WHERE user_id='bob'").get() as {epoch:number}).epoch;
  const native=saveProfile(s.db,'bob',{profileId:null,revision:0,musicEpoch:epoch,selections:[{entryId:'after',level:4}]},new Date('2026-11-19T03:00:00Z'));
  const result=projectRollbackState(s.db,s.journal),fixed=new Database(result.checkpointImage),identity=new Database(result.identityImage);try{
    const key=result.music.keys.find(row=>row.profileId===native.id)!.legacyKey;
    expect(result.erasures.boardJournal).toBe('');expect(result.erasures.scopes[0]).toMatchObject({requestId:entry.requestId,entries:['e'],kind:'reset_music',alreadyApplied:true});
    expect(result.music.data.entries).toHaveProperty('after.text','新詞條');expect(Object.keys(result.music.data.members as object)).toEqual([key]);
    expect(identity.prepare('SELECT qq,user_id FROM prelinks').all()).toEqual([{qq:key,user_id:'bob'}]);
    expect(fixed.prepare('SELECT * FROM privacy_receipts').all()).toEqual(s.db.prepare('SELECT * FROM privacy_receipts').all());
    expect(fixed.transaction(()=>verifyRollbackState(fixed,result,result.journal)).immediate()).toEqual(result.report);
  }finally{identity.close();fixed.close();}
});
it.each(['checkpoint rows','checkpoint omitted table','board bot claim','music selection','identity ownership','identity audit map','erasure ledger','erasure scope','journal','version','extra component','truncated image','WAL header'])('independently rejects changed %s in an assembled state',async(change)=>{
  const s=await setup();submit(s,{version:1,kind:'both',userId:'bob',profileId:profileId('10002')});
  s.db.prepare("INSERT INTO bot_outbox(event_id,kind,dedupe_key,target,payload_json,status,claim_token,created_at) VALUES('listen','fixed','fixed','synthetic','{}','sending','reserved-claim','after')").run();
  const result=projectRollbackState(s.db,s.journal),fixed=new Database(result.checkpointImage);
  const copy:RollbackState={...result,checkpointImage:Buffer.from(result.checkpointImage),boardImage:Buffer.from(result.boardImage),identityImage:Buffer.from(result.identityImage),music:structuredClone(result.music),erasures:structuredClone(result.erasures),journal:structuredClone(result.journal),identityAuditMappings:structuredClone(result.identityAuditMappings)};
  if(change==='checkpoint rows')copy.checkpointImage=changeImage(copy.checkpointImage,db=>db.prepare("UPDATE users SET nickname='wrong' WHERE id='alice'").run());
  if(change==='checkpoint omitted table')copy.checkpointImage=changeImage(copy.checkpointImage,db=>db.exec('DROP TABLE unified_privacy_receipts'));
  if(change==='board bot claim')copy.boardImage=changeImage(copy.boardImage,db=>db.prepare("UPDATE bot_outbox SET claim_token='wrong'").run());
  if(change==='music selection')(copy.music.data.members as Record<string,Record<string,unknown>>)['10001']!.selection=[];
  if(change==='identity ownership')copy.identityImage=changeImage(copy.identityImage,db=>db.prepare("UPDATE prelinks SET user_id='bob' WHERE qq='10001'").run());
  if(change==='identity audit map')copy.identityAuditMappings.push({source:'ownership',sourceId:'missing',legacyId:'1'});
  if(change==='erasure ledger')copy.erasures.musicJournal='';if(change==='erasure scope')copy.erasures.scopes=[];if(change==='journal')copy.journal=[];
  if(change==='version')Object.assign(copy,{version:2});if(change==='extra component')Object.assign(copy,{activate:true});if(change==='truncated image')copy.identityImage=copy.identityImage.subarray(0,50);if(change==='WAL header')copy.checkpointImage[18]=2;
  try{expect(()=>fixed.transaction(()=>verifyRollbackState(fixed,copy,result.journal)).immediate()).toThrow();expect(fixed.transaction(()=>verifyRollbackState(fixed,result,result.journal)).immediate()).toEqual(result.report);}finally{fixed.close();}
});
it('requires standalone capture, rejects corrupt source journals and does not mutate source on a downstream projection failure',async()=>{
  const s=await setup();s.db.transaction(()=>expect(()=>projectRollbackState(s.db,s.journal)).toThrow('standalone')).deferred();
  submit(s,{version:1,kind:'music',userId:'bob',profileId:profileId('10002')});
  expect(()=>projectRollbackState(s.db,{read:()=>[],append(){throw Error();}})).toThrow('markers differ');
  s.db.prepare("UPDATE music_profile_contacts SET contact_qq='' WHERE profile_id=?").run(profileId('10001'));
  const before=s.db.serialize();expect(()=>projectRollbackState(s.db,s.journal)).toThrow('contact');expect(s.db.serialize()).toEqual(before);expect(s.db.inTransaction).toBe(false);
  s.db.prepare('UPDATE music_profile_contacts SET contact_qq=? WHERE profile_id=?').run('10001',profileId('10001'));expect(projectRollbackState(s.db,s.journal).report.rollbackEligible).toBe(false);
});
it('closes all temporary database projections on a late erasure failure and succeeds after source repair',async()=>{
  const s=await setup(),entry=submit(s,{version:1,kind:'both',userId:'bob',profileId:profileId('10002')}),originalBoard=boardProjection.projectRollbackBoard,originalIdentity=identityProjection.projectRollbackIdentity,opened:DB[]=[];
  vi.spyOn(boardProjection,'projectRollbackBoard').mockImplementation(db=>{const result=originalBoard(db);opened.push(result.db);return result;});
  vi.spyOn(identityProjection,'projectRollbackIdentity').mockImplementation((db,journal,music)=>{const result=originalIdentity(db,journal,music);opened.push(result.db);return result;});
  const marker=s.db.prepare("SELECT * FROM privacy_requests WHERE user_id='bob'").get() as {id:string;user_id:string;status:string;created_at:string;updated_at:string;note:string};
  s.db.prepare('DELETE FROM privacy_requests WHERE id=?').run(entry.requestId);
  const before=s.db.serialize();expect(()=>projectRollbackState(s.db,s.journal)).toThrow('erasure reconciliation');expect(opened).toHaveLength(2);expect(opened.every(db=>!db.open)).toBe(true);expect(s.db.serialize()).toEqual(before);
  s.db.prepare('INSERT INTO privacy_requests(id,user_id,status,created_at,updated_at,note) VALUES(?,?,?,?,?,?)').run(marker.id,marker.user_id,marker.status,marker.created_at,marker.updated_at,marker.note);
  expect(projectRollbackState(s.db,s.journal).report.rollbackEligible).toBe(false);expect(opened).toHaveLength(4);expect(opened.every(db=>!db.open)).toBe(true);
});
it('rejects accidental writes to the private fixed source during projection without altering the live source',async()=>{
  const s=await setup(),original=musicProjection.projectRollbackMusic;
  s.db.prepare("INSERT INTO unified_privacy_consents VALUES('bob','new-policy','after','explicit')").run();
  s.db.prepare("INSERT INTO unified_privacy_receipts VALUES('bob','new-receipt','new-policy','synthetic-signature')").run();
  vi.spyOn(musicProjection,'projectRollbackMusic').mockImplementationOnce((fixed,journal)=>{const result=original(fixed,journal);fixed.prepare('DELETE FROM unified_privacy_receipts').run();return result;});
  const before=s.db.serialize();expect(()=>projectRollbackState(s.db,s.journal)).toThrow('checkpoint reconciliation');expect(s.db.serialize()).toEqual(before);expect(s.db.inTransaction).toBe(false);
});
