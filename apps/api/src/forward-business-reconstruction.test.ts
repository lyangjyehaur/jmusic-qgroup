import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {afterEach,it,expect} from 'vitest';
import {assertDatabaseUsable,type DB} from '@qgroup/database';
import {legacyHistoryFixture} from '../testsupport/legacy-history-fixture';
import {saveProfile,getProfile} from './repositories';
import {hash} from './security';
import {erasureJournal} from './erasure-journal';
import {projectRollbackState} from '../../../tools/migration/rollback-state';
import {captureRollbackCheckpoint} from '../../../tools/migration/rollback-checkpoint';
import {reconstructForwardBusiness} from '../../../tools/migration/forward-business-reconstruction';
import {verifyForwardBusiness} from '../../../tools/migration/forward-business-reconciliation';
import {forwardRows,forwardHash} from '../../../tools/migration/forward-board-storage';
import {object,profileId,type ObjectValue} from '../../../tools/migration/music-codec';
import type {ForwardMusicInput} from '../../../tools/migration/forward-music-sources';

const cleanup:(()=>void)[]=[];afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});const stamp=new Date('2026-11-20T01:00:00Z'),restored='2026-11-20T02:00:00.000Z',pin=(bytes:Buffer)=>({bytes:Buffer.from(bytes),sha256:forwardHash(bytes)});
async function setup(trendPosition?:bigint){const f=await legacyHistoryFixture();cleanup.push(()=>f.close());const db=f.db;
  for(const id of ['fresh-native','fresh-old'])db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(id,hash('fixture-'+id),id,stamp.toISOString());
  const alice=saveProfile(db,'alice',{profileId:profileId('10001'),revision:0,musicEpoch:0,selections:[{entryId:'e',level:4}]},stamp),native=saveProfile(db,'fresh-native',{profileId:null,revision:0,musicEpoch:0,selections:[{entryId:'e',level:2}]},stamp);db.prepare("INSERT INTO request_results VALUES('alice','original-receipt','original-signature','{\"original\":true}',200,'original-time')").run();db.prepare("INSERT INTO music_profile_receipts VALUES('alice','original-receipt',?)").run(alice.id);
  db.prepare('INSERT INTO music_pin_history(profile_id,revision,user_id,actor_ref,reason,created_at) VALUES(?,8,?, ?,?,?)').run(alice.id,'alice','account:alice','合成原 PIN 歷史',stamp.toISOString());
  if(trendPosition!==undefined)db.prepare("INSERT INTO music_documents VALUES('trend_sample',?,?)").run(trendPosition,JSON.stringify({t:'original-sample',counts:{e:8}}));
  const journal=erasureJournal(db),base=projectRollbackState(db,journal),oldBoard=new Database(base.boardImage),oldIdentity=new Database(base.identityImage);cleanup.push(()=>oldBoard.close(),()=>oldIdentity.close());const old=structuredClone(base.music.data);
  const input=():ForwardMusicInput=>({checkpoint:pin(base.checkpointImage),baselineBoard:pin(base.boardImage),baselineJournal:pin(Buffer.from(base.journal.map(row=>JSON.stringify(row)+'\n').join(''))),nativeImage:pin(captureRollbackCheckpoint(db,journal).image),nativeJournal:pin(Buffer.from(journal.read().map(row=>JSON.stringify(row)+'\n').join(''))),oldBoard:pin(oldBoard.serialize()),baselineMusic:pin(Buffer.from(JSON.stringify({...base.music,identityAuditMappings:base.identityAuditMappings}))),baselineIdentity:pin(base.identityImage),oldMusic:pin(Buffer.from(JSON.stringify(old))),oldIdentity:pin(oldIdentity.serialize())});
  return {db,base,alice,native,oldBoard,oldIdentity,old,input};}
function member(data:ObjectValue,key:string){return object(object(data.members,'members')[key],'member');}
function open(image:Buffer){const db=new Database(image);cleanup.push(()=>db.close());return db;}
const read=(db:DB,table:string)=>[...forwardRows(db,table)];

it('materializes old selections and fields into the original native IDs while retaining every native history, receipt and original private document',async()=>{
  const s=await setup();member(s.old,'10002').selection=[{entryId:'e',level:'2'},{id:'e',level:true}];member(s.old,'10002').note='舊站修改留言';member(s.old,'10002').pinHash='ORIGINAL-OLD-NEW-PIN';const input=s.input(),result=reconstructForwardBusiness(input,restored),db=open(result.nativeImage);
  expect(getProfile(db,'bob')).toMatchObject({id:profileId('10002'),revision:1,selections:[{entryId:'e',level:2}],updatedAt:restored});expect(db.prepare('SELECT note,revision FROM music_profile_fields WHERE profile_id=?').get(profileId('10002'))).toEqual({note:'舊站修改留言',revision:1});expect(db.prepare('SELECT pin_hash FROM music_legacy_profiles WHERE profile_id=?').get(profileId('10002'))).toEqual({pin_hash:'ORIGINAL-OLD-NEW-PIN'});
  for(const table of ['music_profile_audit','music_pin_history','music_contact_history','music_field_history','music_ownership_history','music_profile_receipts','request_results','privacy_receipts','erasure_applied','music_profile_creation','music_documents','migration_map','bot_outbox'])expect(read(db,table),table).toEqual(read(s.db,table));
  expect(getProfile(db,'fresh-native')).toEqual(getProfile(s.db,'fresh-native'));expect(member(result.musicSources.data,'10002').selection).toEqual(member(s.old,'10002').selection);expect(()=>assertDatabaseUsable(db)).toThrow('offline review');expect(result.report).toMatchObject({businessCandidateOnly:true,proofReconciliationRequired:true,sourceRebaseRequired:true,recoveryRequired:true,releaseEligible:false,rollbackEligible:false});expect(verifyForwardBusiness(input,result.nativeImage,result.musicSources,result.identitySources,restored).changedProfiles).toBe(1);
});
it('keeps native-only music updates and preserves stale original legacy metadata when another old field changes',async()=>{
  const s=await setup();s.db.prepare("UPDATE music_profile_fields SET name='新版稱呼',note='新版留言',revision=3 WHERE profile_id=?").run(s.alice.id);member(s.old,'10002').gender='自訂';member(s.old,'10002').genderPublic=true;const result=reconstructForwardBusiness(s.input(),restored),db=open(result.nativeImage);expect(db.prepare('SELECT name,note,revision FROM music_profile_fields WHERE profile_id=?').get(s.alice.id)).toEqual({name:'新版稱呼',note:'新版留言',revision:3});expect(read(db,'music_legacy_profiles').find(row=>row.profile_id===s.alice.id)).toEqual(read(s.db,'music_legacy_profiles').find(row=>row.profile_id===s.alice.id));expect(db.prepare('SELECT gender,gender_public FROM music_profile_fields WHERE profile_id=?').get(profileId('10002'))).toEqual({gender:'自訂',gender_public:1});
});
it('preserves a generated native profile ID and its original creation provenance after an old edit',async()=>{
  const s=await setup(),key=s.base.music.keys.find(row=>row.profileId===s.native.id)!.legacyKey;member(s.old,key).note='舊站修改 native 成分';const result=reconstructForwardBusiness(s.input(),restored),db=open(result.nativeImage);expect(getProfile(db,'fresh-native')?.id).toBe(s.native.id);expect(read(db,'music_profile_creation')).toEqual(read(s.db,'music_profile_creation'));expect(db.prepare('SELECT note FROM music_profile_fields WHERE profile_id=?').get(s.native.id)).toEqual({note:'舊站修改 native 成分'});expect(result.musicSources.keys.find(row=>row.profileId===s.native.id)).toEqual(s.base.music.keys.find(row=>row.profileId===s.native.id));
});
it('copies old catalog additions and exact source times, updates created lists, and preserves native term metadata and order',async()=>{
  const s=await setup();object(s.old.entries,'entries').new={id:'new',text:'舊站新增詞條',kind:'sub',category:'歌手',aliases:['原別名'],createdBy:'10002',createdAt:'unknown-zone',updatedAt:false};member(s.old,'10002').created=['e','new'];member(s.old,'10002').selection=['new','e'];const result=reconstructForwardBusiness(s.input(),restored),db=open(result.nativeImage);expect(db.prepare("SELECT * FROM music_entries WHERE id='new'").get()).toEqual({id:'new',name:'舊站新增詞條',kind:'sub'});expect(db.prepare("SELECT created_at_json,updated_at_json,created_by FROM music_entry_details WHERE entry_id='new'").get()).toEqual({created_at_json:'"unknown-zone"',updated_at_json:'false',created_by:profileId('10002')});expect(getProfile(db,'bob')?.selections).toEqual([{entryId:'new',level:3},{entryId:'e',level:3}]);expect(read(db,'music_entry_details').find(row=>row.entry_id==='e')).toEqual(read(s.db,'music_entry_details').find(row=>row.entry_id==='e'));
});
it('rebuilds source-authorized catalog removal without rewriting frozen history or native financial rows',async()=>{
  const s=await setup();object(s.old.entries,'entries').new={id:'new',text:'保留詞條',kind:'sub'};delete object(s.old.entries,'entries').e;for(const value of Object.values(object(s.old.members,'members'))){const m=object(value,'member');m.selection=[];m.created=[];}s.db.prepare("INSERT INTO music_entry_creations VALUES(?, 'e',0)").run(s.alice.id);const result=reconstructForwardBusiness(s.input(),restored),db=open(result.nativeImage);expect(db.prepare("SELECT 1 FROM music_entries WHERE id='e'").get()).toBeUndefined();expect(db.prepare("SELECT 1 FROM music_entry_creations WHERE entry_id='e'").get()).toBeUndefined();expect(read(db,'music_profile_audit')).toEqual(read(s.db,'music_profile_audit'));
});
it('keeps original native rowids through old-only selection reordering and contact/ownership swaps',async()=>{
  const s=await setup();s.oldIdentity.prepare("UPDATE prelinks SET user_id='temporary' WHERE qq='10001'").run();s.oldIdentity.prepare("UPDATE prelinks SET user_id='alice' WHERE qq='10002'").run();s.oldIdentity.prepare("UPDATE prelinks SET user_id='bob' WHERE qq='10001'").run();member(s.old,'10001').boardUserId='bob';member(s.old,'10002').boardUserId='alice';const result=reconstructForwardBusiness(s.input(),restored),db=open(result.nativeImage);expect(getProfile(db,'alice')?.id).toBe(profileId('10002'));expect(getProfile(db,'bob')?.id).toBe(s.alice.id);expect(db.prepare("SELECT epoch FROM music_account_epochs WHERE user_id='alice'").get()).toEqual({epoch:1});expect(db.prepare("SELECT epoch FROM music_account_epochs WHERE user_id='bob'").get()).toEqual({epoch:1});expect(read(db,'music_profile_audit')).toEqual(read(s.db,'music_profile_audit'));expect(read(db,'music_profile_receipts')).toEqual(read(s.db,'music_profile_receipts'));
});
it('retains existing native trend rows and appends genuine old samples with original times',async()=>{
  const s=await setup();(s.old.trend as ObjectValue[]).push({t:'opaque-new-time',counts:{e:19}});const result=reconstructForwardBusiness(s.input(),restored),db=open(result.nativeImage);for(const row of read(s.db,'music_documents'))expect(read(db,'music_documents').find(after=>after.kind===row.kind&&after.position===row.position)).toEqual(row);expect(db.prepare("SELECT payload_json FROM music_documents WHERE kind='trend_sample'").get()).toEqual({payload_json:JSON.stringify({t:'opaque-new-time',counts:{e:19}})});
});
it('preserves a trend position beyond JavaScript safe integers without rounding its successor',async()=>{
  const s=await setup(9007199254740993n);(s.old.trend as ObjectValue[]).push({t:'next-sample',counts:{e:9}});const result=reconstructForwardBusiness(s.input(),restored),db=open(result.nativeImage);expect(db.prepare("SELECT position FROM music_documents WHERE kind='trend_sample' ORDER BY position").safeIntegers(true).all()).toEqual([{position:9007199254740993n},{position:9007199254740994n}]);
});
it('rejects exhausted signed SQLite trend positions instead of rounding or wrapping',async()=>{
  const s=await setup(9223372036854775807n);(s.old.trend as ObjectValue[]).push({t:'unrepresentable-next',counts:{e:9}});expect(()=>reconstructForwardBusiness(s.input(),restored)).toThrow('trend position capacity');
});
it.each(['position','rowid'] as const)('rejects a changed appended trend %s even when its visible order and values match',async column=>{
  const s=await setup();(s.old.trend as ObjectValue[]).push({t:'next-sample',counts:{e:9}});const input=s.input(),result=reconstructForwardBusiness(input,restored),db=open(result.nativeImage);db.prepare(`UPDATE music_documents SET ${column}=${column}+100 WHERE kind='trend_sample'`).run();expect(()=>verifyForwardBusiness(input,db.serialize(),result.musicSources,result.identitySources,restored)).toThrow('reconciliation');
});
it.each(['music_documents','migration_runs','music_profiles'] as const)('rejects exhausted native %s rowids instead of allocating a random historical ID',async table=>{
  const s=await setup();s.db.prepare(`UPDATE ${table} SET rowid=? WHERE rowid=(SELECT max(rowid) FROM ${table})`).run(9223372036854775807n);
  if(table==='music_documents')(s.old.trend as ObjectValue[]).push({t:'next-sample',counts:{e:9}});
  if(table==='music_profiles')object(s.old.members,'members')['99993']={qq:'99993',name:'合成新增',consent:true,selection:[],boardUserId:''};
  expect(()=>reconstructForwardBusiness(s.input(),restored)).toThrow('rowid capacity');
});
it('rejects an old attempt assigned a different native rowid after reconstruction',async()=>{
  const s=await setup();s.oldIdentity.prepare('INSERT INTO login_attempts(rowid,bucket,created) VALUES(20,?,222.5)').run('qq:'+'b'.repeat(64));const input=s.input(),result=reconstructForwardBusiness(input,restored),db=open(result.nativeImage);db.prepare('UPDATE music_claim_attempts SET rowid=rowid+100').run();expect(()=>verifyForwardBusiness(input,db.serialize(),result.musicSources,result.identitySources,restored)).toThrow('reconciliation');
});
it('matches duplicate rate buckets back to original native rowids and appends old attempts without turning source sessions into active authentication',async()=>{
  const s=await setup(),bucket='ip:'+'a'.repeat(64);s.db.prepare('INSERT INTO music_claim_attempts(rowid,bucket,created) VALUES(-9,?,111.25)').run(bucket);s.oldIdentity.prepare('INSERT INTO login_attempts(rowid,bucket,created) VALUES(20,?,222.5)').run('qq:'+'b'.repeat(64));s.oldIdentity.prepare("INSERT INTO sessions VALUES('private-source-token','10002',9999999999,'original-device',0)").run();const result=reconstructForwardBusiness(s.input(),restored),db=open(result.nativeImage);expect(read(db,'music_claim_attempts').find(row=>row.__forward_rowid__===-9n)).toEqual(read(s.db,'music_claim_attempts')[0]);expect(db.prepare('SELECT bucket,created FROM music_claim_attempts WHERE rowid>0').get()).toEqual({bucket:'qq:'+'b'.repeat(64),created:222.5});expect(read(db,'music_legacy_identity')).toEqual(read(s.db,'music_legacy_identity'));expect(open(result.identitySources).prepare('SELECT source_session FROM sessions').get()).toEqual({source_session:'original-device'});
});
it('preserves gapped native positions for level changes and rebases them when old selection order gains an entry',async()=>{
  const s=await setup();s.db.prepare('UPDATE music_selections SET position=100 WHERE profile_id=?').run(profileId('10002'));member(s.old,'10002').selection=[{id:'e',level:2}];const level=reconstructForwardBusiness(s.input(),restored),first=open(level.nativeImage);expect(first.prepare('SELECT position FROM music_selections WHERE profile_id=?').get(profileId('10002'))).toEqual({position:100});object(s.old.entries,'entries').added={id:'added',text:'新增',kind:'sub'};member(s.old,'10002').selection=[{id:'e',level:2},{id:'added',level:3}];const reordered=reconstructForwardBusiness(s.input(),restored),db=open(reordered.nativeImage);expect(getProfile(db,'bob')?.selections).toEqual([{entryId:'e',level:2},{entryId:'added',level:3}]);expect(db.prepare('SELECT position FROM music_selections WHERE profile_id=? ORDER BY position').all(profileId('10002'))).toEqual([{position:0},{position:1}]);
});
it('moves an old self-reported contact alias between profiles while retaining native IDs and creation rows',async()=>{
  const s=await setup(),legacy='m_'+'a'.repeat(24),nativeKey=s.base.music.keys.find(row=>row.profileId===s.native.id)!.legacyKey;s.oldIdentity.prepare('UPDATE profile_contacts SET number=? WHERE qq=?').run('',legacy);s.oldIdentity.prepare('INSERT INTO profile_contacts VALUES(?,?,123.25)').run(nativeKey,'12345');const result=reconstructForwardBusiness(s.input(),restored),db=open(result.nativeImage);expect(db.prepare('SELECT contact_qq FROM music_profile_contacts WHERE profile_id=?').get(profileId(legacy))).toEqual({contact_qq:''});expect(db.prepare('SELECT contact_qq FROM music_profile_contacts WHERE profile_id=?').get(s.native.id)).toEqual({contact_qq:'12345'});expect(read(db,'music_profile_creation')).toEqual(read(s.db,'music_profile_creation'));expect(read(db,'music_contact_history')).toEqual(read(s.db,'music_contact_history'));
});
it('reconstructs the same pinned inputs twice without duplicate business rows or migration receipts',async()=>{
  const s=await setup();member(s.old,'10002').note='原來源';const input=s.input(),a=reconstructForwardBusiness(input,restored),b=reconstructForwardBusiness(input,restored);expect(a.nativeImage).toEqual(b.nativeImage);expect(read(open(a.nativeImage),'migration_runs').length).toBe(read(s.db,'migration_runs').length+1);expect(a.nativeJournal).toEqual(input.nativeJournal.bytes);
});
it('rejects immutable native ordinal tampering even when the resulting shout order stays the same',async()=>{
  const s=await setup(),input=s.input(),result=reconstructForwardBusiness(input,restored),db=open(result.nativeImage);db.prepare("UPDATE music_shouts SET ordinal=100 WHERE id='old'").run();expect(()=>verifyForwardBusiness(input,db.serialize(),result.musicSources,result.identitySources,restored)).toThrow('reconciliation');
});
it('reorders old shouts without changing their IDs, original times, native receipt or author histories',async()=>{
  const s=await setup();(s.old.shouts as ObjectValue[]).unshift({id:'old-added',qq:'99997',name:'原作者',text:'原新增',createdAt:321.25});const result=reconstructForwardBusiness(s.input(),restored),db=open(result.nativeImage);expect(db.prepare('SELECT id FROM music_shouts WHERE archived_at IS NULL ORDER BY ordinal').all()).toEqual([{id:'old-added'},{id:'old'}]);expect(db.prepare("SELECT created_at FROM music_shouts WHERE id='old'").get()).toEqual(s.db.prepare("SELECT created_at FROM music_shouts WHERE id='old'").get());expect(read(db,'music_profile_receipts')).toEqual(read(s.db,'music_profile_receipts'));
});
it('rejects invented migration time formats and asynchronous boundaries without output',async()=>{
  const s=await setup(),input=s.input();expect(()=>reconstructForwardBusiness(input,'unknown-time')).toThrow();expect(()=>reconstructForwardBusiness(input,restored,(()=>Promise.resolve()) as unknown as ()=>void)).toThrow('synchronous');
});
it('rejects revision capacity exhaustion and native receipt or source-run tampering',async()=>{
  const s=await setup();s.db.prepare('UPDATE music_profiles SET revision=? WHERE id=?').run(Number.MAX_SAFE_INTEGER,profileId('10002'));member(s.old,'10002').note='舊更新';expect(()=>reconstructForwardBusiness(s.input(),restored)).toThrow('revision capacity');const other=await setup(),input=other.input(),result=reconstructForwardBusiness(input,restored),db=open(result.nativeImage);db.prepare("UPDATE migration_runs SET report_json='{}' WHERE source_digest=?").run(result.report.sourceDigest);expect(()=>verifyForwardBusiness(input,db.serialize(),result.musicSources,result.identitySources,restored)).toThrow('reconciliation');
});
it.each(['history','receipt','source-document','migration-map','profile-id','selection','profile-revision','field-revision','recovery','metadata','sequence','extra-row'] as const)('independently rejects materialized %s tampering',async kind=>{
  const s=await setup();member(s.old,'10002').note='舊站留言';const input=s.input(),result=reconstructForwardBusiness(input,restored),db=open(result.nativeImage);db.pragma('foreign_keys=OFF');if(kind==='history'){const sql=(db.prepare("SELECT sql FROM sqlite_master WHERE name='music_audit_no_update'").get() as {sql:string}).sql;db.exec('DROP TRIGGER music_audit_no_update');db.prepare("UPDATE music_profile_audit SET after_json='{}'").run();db.exec(sql);}if(kind==='receipt')db.prepare("UPDATE request_results SET response_json='forged'").run();if(kind==='source-document')db.prepare("UPDATE music_documents SET payload_json='{}' WHERE kind='settings'").run();if(kind==='migration-map')db.prepare("UPDATE migration_map SET status='forged'").run();if(kind==='profile-id')db.prepare("UPDATE music_profiles SET id='m_ffffffffffffffffffffffffffffffff' WHERE user_id='bob'").run();if(kind==='selection')db.prepare('UPDATE music_selections SET level=1 WHERE profile_id=?').run(profileId('10002'));if(kind==='profile-revision')db.prepare('UPDATE music_profiles SET revision=99 WHERE id=?').run(profileId('10002'));if(kind==='field-revision')db.prepare('UPDATE music_profile_fields SET revision=99 WHERE profile_id=?').run(profileId('10002'));if(kind==='recovery'){const sql=(db.prepare("SELECT sql FROM sqlite_master WHERE name='rebuild_storage_no_update'").get() as {sql:string}).sql;db.exec('DROP TRIGGER rebuild_storage_no_update');db.prepare('UPDATE rebuild_storage SET recovery_required=0').run();db.exec(sql);}if(kind==='metadata')db.pragma('application_id=444');if(kind==='sequence')db.prepare("UPDATE sqlite_sequence SET seq=999 WHERE name='music_profile_audit'").run();if(kind==='extra-row')db.prepare("INSERT INTO music_entry_details VALUES('unknown','其他','[]','','0','null')").run();expect(()=>verifyForwardBusiness(input,db.serialize(),result.musicSources,result.identitySources,restored)).toThrow();
});
it('rejects lost history/reset authority, missing ownership and changed source buffers before output',async()=>{
  const s=await setup();s.old.trend=[];expect(()=>reconstructForwardBusiness(s.input(),restored)).toThrow('structured reset authority');const other=await setup();member(other.old,'10002').boardUserId='unknown-account';other.oldIdentity.prepare("UPDATE prelinks SET user_id='unknown-account' WHERE qq='10002'").run();expect(()=>reconstructForwardBusiness(other.input(),restored)).toThrow();const input=(await setup()).input();let calls=0;expect(()=>reconstructForwardBusiness(input,restored,()=>{if(++calls===2)input.oldMusic.bytes[0]=32;})).toThrow('source changed');expect(calls).toBe(2);
});
it('materializes real old Python activity/profile/contact/shout writes and independently preserves the complete native-only inventory in readonly Python',async()=>{
  const s=await setup();s.db.prepare("UPDATE music_profile_fields SET note='native 私人新留言',revision=2 WHERE profile_id=?").run(s.alice.id);
  const folder=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'qgroup-forward-business-oracle-')));cleanup.push(()=>fs.rmSync(folder,{recursive:true,force:true}));fs.writeFileSync(join(folder,'data.json'),JSON.stringify(s.old),{mode:0o600});fs.writeFileSync(join(folder,'identity.sqlite3'),s.oldIdentity.serialize(),{mode:0o600});fs.writeFileSync(join(folder,'board.sqlite3'),s.oldBoard.serialize(),{mode:0o600});
  const generated=JSON.parse(execFileSync('python3',['-c',`import json,sys,sqlite3
from pathlib import Path
from music_site.identity_store import Store
from music_site import upstream,contacts
from qgroup_core import events
root=Path(sys.argv[1]);store=Store(root/'identity.sqlite3');upstream.DATA_FILE=str(root/'data.json');upstream.BACKUP_DIR=str(root/'backups');upstream.data=json.loads((root/'data.json').read_text())
key=store.create_profile(dict(user_id='fresh-old'),'舊站新增成分');store.recover_profiles(upstream.data);contacts.save(upstream.data,store,key,'98765')
class Fake:
 def send_json(self,value,status=200):
  assert status==200,(value,status)
  return value
upstream.Handler.api_selection(Fake(),dict(qq=key,selection=[dict(id='e',level=2)]));upstream.Handler.api_shout(Fake(),dict(qq=key,text='原 Python 喊話'));upstream.save()
with sqlite3.connect(root/'board.sqlite3') as db:
 db.row_factory=sqlite3.Row
 db.execute('UPDATE bot_settings SET config_json=?',(json.dumps(dict(enabled=True,groups=[dict(id='synthetic-group',name='合成群',replies=True,broadcast=True)])),))
 user=db.execute("SELECT * FROM users WHERE id='alice'").fetchone()
 event=events.create(db,user,dict(title='舊站新活動',category='约K',location='合成地點',starts_at='2099-12-12T06:00:00+00:00',deadline='2099-12-11T06:00:00+00:00',capacity=8,description='原內容',duration_hours=3,timezone='Asia/Taipei',visibility='public',bot_enabled=True,join_owner=True))
 assert db.execute('SELECT count(*) FROM bot_outbox WHERE event_id=?',(event,)).fetchone()[0]>0
print(json.dumps(dict(key=key,event=event)))`,folder],{encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH,PYTHONPATH:process.cwd(),JPM_DATA:join(folder,'data.json'),KANBAN_BOT_BASE_URL:'https://rebuild.example',KANBAN_BOT_ENABLED:'1'}}));
  const input=s.input();input.oldMusic=pin(fs.readFileSync(join(folder,'data.json')));input.oldIdentity=pin(fs.readFileSync(join(folder,'identity.sqlite3')));input.oldBoard=pin(fs.readFileSync(join(folder,'board.sqlite3')));const result=reconstructForwardBusiness(input,restored),db=open(result.nativeImage);expect(getProfile(db,'fresh-old')).toMatchObject({id:profileId(generated.key),selections:[{entryId:'e',level:2}]});expect(db.prepare('SELECT title FROM events WHERE id=?').get(generated.event)).toEqual({title:'舊站新活動'});
  for(const [name,bytes] of [['native',input.nativeImage.bytes],['candidate',result.nativeImage]] as const)fs.writeFileSync(join(folder,name+'.sqlite3'),bytes,{mode:0o600});fs.writeFileSync(join(folder,'mapping.json'),JSON.stringify(result.musicSources.keys),{mode:0o600});
  const report=JSON.parse(execFileSync('python3',['-c',`import json,sqlite3,sys
from pathlib import Path
from contextlib import ExitStack,closing
root=Path(sys.argv[1]);data=json.loads((root/'data.json').read_text());mapping=json.loads((root/'mapping.json').read_text());ids={row['legacyKey']:row['profileId'] for row in mapping}
with ExitStack() as stack:
 dbs={name:stack.enter_context(closing(sqlite3.connect((root/(name+'.sqlite3')).as_uri()+'?mode=ro',uri=True))) for name in ('native','candidate','board')}
 def tables(db):return {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
 def rows(db,table):
  columns=[r[1] for r in db.execute('PRAGMA table_xinfo("'+table+'")')]
  return list(db.execute('SELECT rowid,*,'+','.join('typeof("'+c+'")' for c in columns)+' FROM "'+table+'" ORDER BY rowid'))
 shared=tables(dbs['board']);assert len(shared)==59
 for table in shared:assert rows(dbs['candidate'],table)==rows(dbs['board'],table),table
 managed=set('music_entries music_entry_details music_profiles music_selections music_legacy_profiles music_profile_fields music_profile_contacts music_entry_creations music_shouts music_shout_authors music_claim_attempts music_account_epochs music_documents migration_map migration_runs rebuild_storage'.split())
 checked=0
 for table in tables(dbs['native'])-shared-managed:
  assert rows(dbs['candidate'],table)==rows(dbs['native'],table),table
  checked+=1
 assert dbs['candidate'].execute("SELECT note,revision FROM music_profile_fields WHERE profile_id=?",(ids['10001'],)).fetchone()==('native 私人新留言',2)
 old_key=next(key for key,value in data['members'].items() if value.get('boardUserId')=='fresh-old')
 assert dbs['candidate'].execute('SELECT id FROM music_profiles WHERE user_id=?',('fresh-old',)).fetchone()==(ids[old_key],)
 assert dbs['candidate'].execute('SELECT entry_id,level,position FROM music_selections WHERE profile_id=?',(ids[old_key],)).fetchall()==[('e',2,0)]
 assert dbs['candidate'].execute('SELECT contact_qq FROM music_profile_contacts WHERE profile_id=?',(ids[old_key],)).fetchone()==('98765',)
 assert dbs['candidate'].execute('SELECT body FROM music_shouts WHERE profile_id=?',(ids[old_key],)).fetchone()==('原 Python 喊話',)
 assert dbs['candidate'].execute('PRAGMA integrity_check').fetchone()==('ok',) and not dbs['candidate'].execute('PRAGMA foreign_key_check').fetchall()
 assert dbs['candidate'].execute('SELECT recovery_required FROM rebuild_storage').fetchone()==(1,)
 print(json.dumps(dict(shared=59,nativeOnlyTables=checked,profileId=True,realSourceWrites=True,recoveryBlocked=True)))`,folder],{encoding:'utf8',timeout:10000}));expect(report).toMatchObject({shared:59,profileId:true,realSourceWrites:true,recoveryBlocked:true});expect(report.nativeOnlyTables).toBeGreaterThan(20);
});
