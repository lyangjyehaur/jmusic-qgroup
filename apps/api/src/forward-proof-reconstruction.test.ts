import Database from 'better-sqlite3';
import {afterEach,it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {assertDatabaseUsable,type DB} from '@qgroup/database';
import {forwardProofFixture,proofPin,proofStamp,proofReconciledAt} from '../testsupport/forward-proof-fixture';
import {reconstructForwardProofs} from '../../../tools/migration/forward-proof-reconstruction';
import {verifyForwardProofs,verifyForwardProofBundle} from '../../../tools/migration/forward-proof-reconciliation';
import {forwardRows} from '../../../tools/migration/forward-board-storage';
import {object,profileId} from '../../../tools/migration/music-codec';
import {createMusicClaims} from './music-claim';
import {hash} from './security';

const cleanup:(()=>void)[]=[];afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
async function setup(stage:Parameters<typeof forwardProofFixture>[0]='pending'){const s=await forwardProofFixture(stage);cleanup.push(()=>s.close());return s;}
const open=(image:Buffer)=>{const db=new Database(image);cleanup.push(()=>db.close());return db;},rows=(db:DB,table:string)=>[...forwardRows(db,table)];
function oldMember(s:Awaited<ReturnType<typeof setup>>,key='10003'){return object(object(s.old.members,'members')[key],'member');}
function oldChanges(s:Awaited<ReturnType<typeof setup>>,key:string,targets:string[]){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'qgroup-forward-proofs-old-')));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));writeFileSync(join(root,'identity.sqlite3'),s.oldIdentity.serialize(),{mode:0o600});writeFileSync(join(root,'data.json'),JSON.stringify(s.old),{mode:0o600});
  execFileSync('python3',['-c',`import sys,json
from pathlib import Path
from music_site.identity_store import Store
from music_site import admin_links
root=Path(sys.argv[1]);key=sys.argv[2];data=json.loads((root/'data.json').read_text());store=Store(root/'identity.sqlite3')
for target in json.loads(sys.argv[3]):
 with store.connect() as db:revision=store.admin_state(db,key)['revision']
 admin_links.change(data,store,dict(qq=key,user_id=target,base_revision=revision),'synthetic-admin')
(root/'data.json').write_text(json.dumps(data))`,root,key,JSON.stringify(targets)],{timeout:10000,env:{PATH:process.env.PATH,PYTHONPATH:process.cwd()}});
  const changed=open(readFileSync(join(root,'identity.sqlite3')));s.oldIdentity.exec("DELETE FROM links;DELETE FROM prelinks;DELETE FROM link_overrides;DELETE FROM link_audit;DELETE FROM sqlite_sequence");
  for(const table of ['links','prelinks','link_overrides','link_audit']){const columns=(changed.prepare(`PRAGMA table_xinfo(${table})`).all() as {name:string}[]).map(row=>row.name);for(const row of rows(changed,table))s.oldIdentity.prepare(`INSERT INTO ${table}(rowid,${columns.join(',')}) VALUES(${Array(columns.length+1).fill('?').join(',')})`).run(row.__forward_rowid__,...columns.map(column=>row[column]));}
  s.oldIdentity.exec('DELETE FROM sqlite_sequence');for(const row of changed.prepare('SELECT name,seq FROM sqlite_sequence').safeIntegers(true).all() as {name:string;seq:bigint}[])s.oldIdentity.prepare('INSERT INTO sqlite_sequence VALUES(?,?)').run(row.name,row.seq);
  const data=JSON.parse(readFileSync(join(root,'data.json'),'utf8'));for(const name of Object.keys(s.old))s.old[name]=data[name];return root;
}

it.each(['pending','authorized','completed'] as const)('preserves a valid native %s claim with its original rowid, proof, session and consumed OAuth',async stage=>{
  const s=await setup(stage),input=s.proofInput(),result=reconstructForwardProofs(input),db=open(result.nativeImage);expect(result.report.claims).toMatchObject([{id:s.claimId,action:'retain',reasons:[]}]);for(const table of ['music_claim_intents','login_attempts','browser_sessions','request_results','music_account_epochs','music_profile_audit','account_audit','bot_outbox'])expect(rows(db,table)).toEqual(rows(open(input.businessImage.bytes),table));expect(createMusicClaims(db,()=>new Date(proofReconciledAt)).status(s.device,s.claimId).status).toBe(stage);expect(()=>assertDatabaseUsable(db)).toThrow('offline review');
});
it('retires an expired pending claim while preserving its exact original evidence component and source pair',async()=>{
  const s=await setup(),input=s.proofInput();input.reconciledAt='2026-11-20T01:20:00.000Z';const result=reconstructForwardProofs(input),db=open(result.nativeImage);expect(result.report.claims[0]).toMatchObject({action:'retire_pending',reasons:['claim_expired']});expect(createMusicClaims(db,()=>new Date(input.reconciledAt)).status(s.device,s.claimId)).toEqual({status:'none'});expect(result.retainedBusinessImage).toEqual(input.businessImage.bytes);expect(rows(open(result.retainedBusinessImage),'music_claim_intents')).toEqual(rows(s.db,'music_claim_intents'));expect(result.nativeJournal).toEqual(input.sources.nativeJournal.bytes);expect(result.musicSources).toEqual(input.musicSources.bytes);expect(result.identitySources).toEqual(input.identitySources.bytes);expect(result.report).toMatchObject({proofCandidateOnly:true,externalRetentionRequired:true,externalRetentionVerified:false,recoveryRequired:true,sourceRebaseRequired:true,latestErasureReplayRequired:true,releaseEligible:false,rollbackEligible:false});
});
it('retires a pending claim after a genuine old PIN change without replacing native PIN history or receipts',async()=>{
  const s=await setup();oldMember(s).pinHash=hash('jpm-pin|654321');const input=s.proofInput(),result=reconstructForwardProofs(input),db=open(result.nativeImage);expect(result.report.claims[0]?.reasons).toContain('pin_changed');expect(result.report.claims[0]?.action).toBe('retire_pending');expect(result.report.receiptRows).toEqual([]);expect(rows(db,'music_pin_history')).toEqual(rows(s.db,'music_pin_history'));expect(rows(db,'request_results')).toEqual(rows(s.db,'request_results'));expect(()=>createMusicClaims(db,()=>new Date(proofReconciledAt)).start(s.device,{requestId:'synthetic-new-request',legacyQQ:'10003',pin:'123456',consent:true})).toThrow('舊帳號或口令');
});
it('retires only a claim whose original profile revision changed and keeps ordinary account login',async()=>{
  const s=await setup();oldMember(s).note='舊站新留言';const input=s.proofInput(),result=reconstructForwardProofs(input),db=open(result.nativeImage);expect(result.report.claims[0]?.reasons).toEqual(['profile_revision_changed']);expect(rows(db,'browser_sessions')).toEqual(rows(s.db,'browser_sessions'));expect(rows(db,'music_field_history')).toEqual(rows(s.db,'music_field_history'));
});
it('retires a pending claim when the original browser switched account during old-site writes',async()=>{
  const s=await setup();s.oldBoard.prepare("UPDATE browser_sessions SET user_id='claimant2' WHERE token_hash=?").run(s.device.tokenHash);const input=s.proofInput(),result=reconstructForwardProofs(input),db=open(result.nativeImage);expect(result.report.claims[0]?.reasons).toEqual(['device_scope_changed']);expect(db.prepare('SELECT user_id FROM browser_sessions WHERE token_hash=?').get(s.device.tokenHash)).toEqual({user_id:'claimant2'});expect(rows(db,'browser_sessions')).toEqual(rows(s.oldBoard,'browser_sessions'));
});
it('fails only unconsumed OAuth attached to a retired claim and preserves its identity, dates and other attempts',async()=>{
  const s=await setup();for(const id of ['attached','unrelated'])s.db.prepare("INSERT INTO login_attempts(id,token_hash,user_id,provider,app_id,mode,status,expires_at,created_at,openid,union_id) VALUES(?,?,'claimant','qq','synthetic-app','bind','verified',?,?,'original-subject','original-union')").run(id,s.device.tokenHash,'2026-11-20T01:10:00.000Z',proofStamp);s.db.prepare("UPDATE music_claim_intents SET attempt_id='attached' WHERE id=?").run(s.claimId);oldMember(s).pinHash=hash('jpm-pin|654321');const input=s.proofInput(),result=reconstructForwardProofs(input),db=open(result.nativeImage);expect(result.report.failedAttempts).toEqual(['attached']);const original=rows(s.db,'login_attempts').find(row=>row.id==='attached')!;expect(rows(db,'login_attempts').find(row=>row.id==='attached')).toEqual({...original,status:'failed',union_id:''});expect(rows(db,'login_attempts').find(row=>row.id==='unrelated')).toEqual(rows(s.db,'login_attempts').find(row=>row.id==='unrelated'));
});
it('preserves consumed OAuth even when its authorized claim becomes unavailable',async()=>{
  const s=await setup('authorized');oldMember(s).pinHash=hash('jpm-pin|654321');const input=s.proofInput(),result=reconstructForwardProofs(input),db=open(result.nativeImage);expect(result.report.failedAttempts).toEqual([]);expect(result.report.claims[0]?.action).toBe('retire_pending');expect(rows(db,'login_attempts')).toEqual(rows(s.db,'login_attempts'));expect(rows(open(result.identitySources),'used_oauth')).toEqual(rows(s.oldIdentity,'used_oauth'));
});
it('detaches obsolete completed proof access without deleting native proof evidence or replaying the original operation',async()=>{
  const s=await setup('completed');oldChanges(s,'10003',['claimant2']);const input=s.proofInput(),result=reconstructForwardProofs(input),db=open(result.nativeImage),claim=rows(s.db,'music_claim_intents')[0]!;expect(result.report.claims[0]?.action).toBe('detach_completed');expect(rows(db,'music_claim_intents')[0]).toEqual({...claim,current_token_hash:result.report.claims[0]!.detachedTokenHash});expect(createMusicClaims(db,()=>new Date(proofReconciledAt)).status(s.device,s.claimId)).toEqual({status:'none'});expect(()=>db.transaction(()=>createMusicClaims(db,()=>new Date(proofReconciledAt)).finish(s.device,s.claimId)).immediate()).toThrow('找回請求已失效');for(const table of ['login_attempts','music_profile_audit','account_audit','music_ownership_history','music_pin_history','music_profile_receipts','bot_outbox'])expect(rows(db,table)).toEqual(rows(s.db,table));expect(db.prepare("SELECT response_status FROM request_results WHERE user_id='claimant'").get()).toEqual({response_status:410});expect(result.report.epochRows).toEqual([]);
});
it('does not revive completed proof or private receipts through a real Python unlink and relink to the same owner',async()=>{
  const s=await setup('completed');const root=oldChanges(s,'10003',['','claimant']),input=s.proofInput(),result=reconstructForwardProofs(input),db=open(result.nativeImage);expect(result.report.claims[0]?.action).toBe('detach_completed');expect(db.prepare("SELECT epoch FROM music_account_epochs WHERE user_id='claimant'").get()).toEqual({epoch:2});expect(db.prepare("SELECT response_status FROM request_results WHERE user_id='claimant'").get()).toEqual({response_status:410});expect(rows(db,'music_profile_audit')).toEqual(rows(s.db,'music_profile_audit'));expect(rows(open(result.identitySources),'link_audit')).toEqual(rows(s.oldIdentity,'link_audit'));expect(rows(s.oldIdentity,'link_audit')).toHaveLength(rows(open(s.base.identityImage),'link_audit').length+2);
  writeFileSync(join(root,'business.sqlite3'),input.businessImage.bytes,{mode:0o600});writeFileSync(join(root,'proof-candidate.sqlite3'),result.nativeImage,{mode:0o600});writeFileSync(join(root,'retained.sqlite3'),result.retainedBusinessImage,{mode:0o600});const oracle=JSON.parse(execFileSync('python3',['-c',`import sys,json,sqlite3
from pathlib import Path
from contextlib import ExitStack,closing
root=Path(sys.argv[1]);changed={'music_profiles','music_account_epochs','music_claim_intents','request_results','migration_runs'}
with ExitStack() as stack:
 dbs={name:stack.enter_context(closing(sqlite3.connect((root/(name+'.sqlite3')).as_uri()+'?mode=ro',uri=True))) for name in ('business','proof-candidate','retained')}
 def rows(db,table):
  columns=[r[1] for r in db.execute('PRAGMA table_xinfo("'+table+'")')]
  return list(db.execute('SELECT rowid,*,'+','.join('typeof("'+name+'")' for name in columns)+' FROM "'+table+'" ORDER BY rowid'))
 tables=[r[0] for r in dbs['business'].execute("SELECT name FROM sqlite_master WHERE type='table'")]
 for table in tables:
  assert rows(dbs['business'],table)==rows(dbs['retained'],table),table
  if table not in changed:assert rows(dbs['business'],table)==rows(dbs['proof-candidate'],table),table
 assert dbs['proof-candidate'].execute("SELECT epoch FROM music_account_epochs WHERE user_id='claimant'").fetchone()==(2,)
 assert dbs['proof-candidate'].execute("SELECT stage,attempt_id FROM music_claim_intents").fetchone()==('completed','synthetic-completed-attempt')
 before=dbs['business'].execute('SELECT * FROM music_claim_intents').fetchone();after=dbs['proof-candidate'].execute('SELECT * FROM music_claim_intents').fetchone();assert before[:1]+before[2:]==after[:1]+after[2:] and before[1]!=after[1]
 assert dbs['proof-candidate'].execute("SELECT response_status FROM request_results WHERE user_id='claimant'").fetchone()==(410,)
 assert dbs['retained'].execute("SELECT response_status FROM request_results WHERE user_id='claimant'").fetchone()==(200,)
 assert dbs['proof-candidate'].execute("SELECT status FROM login_attempts WHERE id='synthetic-completed-attempt'").fetchone()==('used',)
 assert dbs['proof-candidate'].execute('PRAGMA integrity_check').fetchone()==('ok',) and not dbs['proof-candidate'].execute('PRAGMA foreign_key_check').fetchall()
 print(json.dumps(dict(tables=len(tables),originalEvidenceExact=True,completedProofRetained=True,consumedPreserved=True)))`,root],{encoding:'utf8',timeout:10000}));expect(oracle).toMatchObject({originalEvidenceExact:true,completedProofRetained:true,consumedPreserved:true});expect(oracle.tables).toBeGreaterThan(90);
});
it('bumps the original profile and account scope after prelink ABA even when all final business fields match',async()=>{
  const s=await setup();oldChanges(s,'10001',['','alice']);const input=s.proofInput(),business=open(input.businessImage.bytes);expect(business.prepare('SELECT revision FROM music_profiles WHERE id=?').get(profileId('10001'))).toEqual({revision:0});const result=reconstructForwardProofs(input),db=open(result.nativeImage);expect(db.prepare('SELECT revision,updated_at FROM music_profiles WHERE id=?').get(profileId('10001'))).toEqual({revision:1,updated_at:proofReconciledAt});expect(db.prepare("SELECT epoch FROM music_account_epochs WHERE user_id='alice'").get()).toEqual({epoch:1});expect(result.report.claims[0]?.action).toBe('retain');expect(result.report.receiptRows).toHaveLength(1);expect(db.prepare("SELECT response_status FROM request_results WHERE user_id='bob'").get()).toEqual({response_status:200});
});
it('revokes a pending claim for an account that temporarily acquired and then lost another profile',async()=>{
  const s=await setup();oldChanges(s,'10001',['claimant','alice']);const input=s.proofInput(),result=reconstructForwardProofs(input),db=open(result.nativeImage);expect(db.prepare("SELECT epoch FROM music_account_epochs WHERE user_id='claimant'").get()).toEqual({epoch:1});expect(result.report.claims[0]?.reasons).toContain('target_authority_changed');expect(result.report.claims[0]?.action).toBe('retire_pending');
});
it('preserves old sessions and intents as private source evidence without treating them as native authentication',async()=>{
  const s=await setup();s.oldIdentity.prepare('INSERT INTO sessions VALUES(?,?,9999999999,?,0)').run('old-private-token','10003','original-device');s.oldIdentity.prepare('INSERT INTO entry_intents VALUES(?,?,?,?,?,9999999999)').run('old-intent','10003','original-device','claimant','{"original":true}');const input=s.proofInput(),result=reconstructForwardProofs(input);expect(result.identitySources).toEqual(input.identitySources.bytes);expect(rows(open(result.identitySources),'sessions')).toHaveLength(1);expect(rows(open(result.nativeImage),'browser_sessions')).toEqual(rows(s.db,'browser_sessions'));expect(rows(open(result.nativeImage),'music_legacy_identity')).toEqual(rows(s.db,'music_legacy_identity'));
});
it('reconstructs fixed proof inputs deterministically and rejects the proof output as an unreconciled business input',async()=>{
  const s=await setup();oldMember(s).pinHash=hash('jpm-pin|654321');const input=s.proofInput(),a=reconstructForwardProofs(input),b=reconstructForwardProofs(input);expect(a.nativeImage).toEqual(b.nativeImage);expect(a.report).toEqual(b.report);expect(()=>reconstructForwardProofs({...input,businessImage:proofPin(a.nativeImage)})).toThrow('business reconciliation');
});
it.each(['nativeJournal','retainedBusinessImage','musicSources','identitySources'] as const)('requires exact retained %s bytes alongside the verified proof candidate',async key=>{
  const s=await setup(),input=s.proofInput(),result=reconstructForwardProofs(input);expect(verifyForwardProofBundle(input,result)).toMatchObject({retainedBusinessImageVerified:true,pairedSourceBytesVerified:true});const altered=Buffer.from(result[key].length?result[key]:Buffer.from([0]));altered[0]=altered[0]!^1;expect(()=>verifyForwardProofBundle(input,{...result,[key]:altered})).toThrow('proof reconciliation');
});
it.each([true,false])('keeps valid visitor proof only while the original visitor session is live: %s',async live=>{
  const s=await setup('none'),token=hash('synthetic-visitor-proof'),device={kind:'visitor' as const,tokenHash:token,scope:hash('kanban-visitor-v1:'+token)};s.db.prepare('INSERT INTO visitor_sessions VALUES(?,?,?)').run(token,live?'2026-11-20T01:10:00.000Z':proofStamp,proofStamp);createMusicClaims(s.db,()=>new Date(proofStamp)).start(device,{requestId:'synthetic-visitor-claim',legacyQQ:'10003',pin:'123456',consent:true});const input=s.proofInput(),result=reconstructForwardProofs(input),db=open(result.nativeImage);expect(result.report.claims[0]?.action).toBe(live?'retain':'retire_pending');expect(createMusicClaims(db,()=>new Date(proofReconciledAt)).status(device,'synthetic-visitor-claim').status).toBe(live?'pending':'none');expect(rows(db,'visitor_sessions')).toEqual(rows(s.db,'visitor_sessions'));
});
it('retires authorized proof when the old-site account lost its QQ identity while preserving the consumed attempt',async()=>{
  const s=await setup('authorized');s.oldBoard.prepare("DELETE FROM external_identities WHERE user_id='claimant'").run();const input=s.proofInput(),result=reconstructForwardProofs(input),db=open(result.nativeImage);expect(result.report.claims[0]?.reasons).toContain('authorization_unverifiable');expect(result.report.failedAttempts).toEqual([]);expect(rows(db,'login_attempts')).toEqual(rows(s.db,'login_attempts'));expect(rows(db,'external_identities')).toEqual(rows(s.oldBoard,'external_identities'));
});
it.each(['revision','epoch','rowid'] as const)('rejects ABA rebase %s capacity exhaustion before returning a candidate',async kind=>{
  const s=await setup();if(kind==='revision')s.db.prepare('UPDATE music_profiles SET revision=? WHERE id=?').run(Number.MAX_SAFE_INTEGER,profileId('10001'));if(kind==='epoch')s.db.prepare('INSERT INTO music_account_epochs VALUES(?,?)').run('alice',Number.MAX_SAFE_INTEGER);if(kind==='rowid')s.db.prepare('INSERT INTO music_account_epochs(rowid,user_id,epoch) VALUES(?,?,6)').run(9223372036854775807n,'bob');oldChanges(s,'10001',['','alice']);const input=s.proofInput();expect(()=>reconstructForwardProofs(input)).toThrow('capacity exhausted');expect(rows(open(input.businessImage.bytes),'music_claim_intents')).toEqual(rows(s.db,'music_claim_intents'));
});
it.each(['pending-revival','completed-access','consumed-oauth','receipt','epoch','profile-revision','history','source','run','recovery','metadata','sequence','extra-row'] as const)('rejects independent proof candidate %s tampering',async kind=>{
  const s=await setup('completed');oldChanges(s,'10003',['','claimant']);const input=s.proofInput(),result=reconstructForwardProofs(input),db=open(result.nativeImage);
  if(kind==='pending-revival')db.prepare("UPDATE music_claim_intents SET stage='pending' WHERE id=?").run(s.claimId);
  if(kind==='completed-access')db.prepare('UPDATE music_claim_intents SET current_token_hash=? WHERE id=?').run(s.device.tokenHash,s.claimId);
  if(kind==='consumed-oauth')db.prepare("UPDATE login_attempts SET status='failed' WHERE id='synthetic-completed-attempt'").run();
  if(kind==='receipt')db.prepare("UPDATE request_results SET response_status=200 WHERE user_id='claimant'").run();
  if(kind==='epoch')db.prepare("UPDATE music_account_epochs SET epoch=1 WHERE user_id='claimant'").run();
  if(kind==='profile-revision')db.prepare('UPDATE music_profiles SET revision=99 WHERE id=?').run(s.id);
  if(kind==='history'){const sql=(db.prepare("SELECT sql FROM sqlite_master WHERE name='music_audit_no_update'").get() as {sql:string}).sql;db.exec('DROP TRIGGER music_audit_no_update');db.prepare("UPDATE music_profile_audit SET after_json='{}'").run();db.exec(sql);}
  if(kind==='source')db.prepare("UPDATE music_documents SET payload_json='{}' WHERE kind='settings'").run();
  if(kind==='run')db.prepare("UPDATE migration_runs SET report_json='{}' WHERE source_digest=?").run(result.report.sourceDigest);
  if(kind==='recovery'){const sql=(db.prepare("SELECT sql FROM sqlite_master WHERE name='rebuild_storage_no_update'").get() as {sql:string}).sql;db.exec('DROP TRIGGER rebuild_storage_no_update');db.prepare('UPDATE rebuild_storage SET recovery_required=0').run();db.exec(sql);}
  if(kind==='metadata')db.pragma('application_id=999');if(kind==='sequence')db.prepare("UPDATE sqlite_sequence SET seq=99 WHERE name='music_profile_audit'").run();if(kind==='extra-row')db.prepare("INSERT INTO music_account_epochs VALUES('claimant2',44)").run();
  expect(()=>verifyForwardProofs(input,db.serialize())).toThrow();
});
it('rejects changed source pins, operation dates and late or asynchronous boundaries without output',async()=>{
  const s=await setup(),input=s.proofInput();for(const key of ['businessImage','musicSources','identitySources'] as const)expect(()=>reconstructForwardProofs({...input,[key]:{...input[key],sha256:'0'.repeat(64)}})).toThrow('pin differs');expect(()=>reconstructForwardProofs({...input,reconciledAt:proofStamp})).toThrow('predates');expect(()=>reconstructForwardProofs(input,(()=>Promise.resolve()) as unknown as ()=>void)).toThrow('synchronous');let calls=0;expect(()=>reconstructForwardProofs(input,()=>{if(++calls===2)input.identitySources.bytes[0]=32;})).toThrow('source changed');expect(calls).toBe(2);
});
