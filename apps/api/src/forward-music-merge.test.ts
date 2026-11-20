import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {afterEach,it,expect} from 'vitest';
import {legacyHistoryFixture} from '../testsupport/legacy-history-fixture';
import {erasureJournal} from './erasure-journal';
import {saveProfile} from './repositories';
import {hash} from './security';
import {createPrivacy} from './privacy';
import {randomUUID} from 'node:crypto';
import {projectRollbackState} from '../../../tools/migration/rollback-state';
import {captureRollbackCheckpoint} from '../../../tools/migration/rollback-checkpoint';
import {mergeForwardMusic} from '../../../tools/migration/forward-music-merge';
import {verifyForwardMusicMerge} from '../../../tools/migration/forward-music-reconciliation';
import {forwardHash,forwardRows} from '../../../tools/migration/forward-board-storage';
import {musicEqual,type ForwardMusicInput} from '../../../tools/migration/forward-music-sources';
import {object,profileId,type ObjectValue} from '../../../tools/migration/music-codec';
import type {RollbackMusic} from '../../../tools/migration/rollback-music';

const cleanup:(()=>void)[]=[];afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
const stamp=new Date('2026-11-20T01:00:00Z'),pin=(bytes:Buffer)=>({bytes:Buffer.from(bytes),sha256:forwardHash(bytes)});
async function setup(options:{historyPair?:boolean;consumed?:boolean;highWater?:boolean}={}){
  const f=await legacyHistoryFixture();cleanup.push(()=>f.close());const db=f.db;
  for(const id of ['fresh-native','fresh-old','later-native'])db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(id,hash('fixture-'+id),id,stamp.toISOString());
  if(options.historyPair){db.prepare("INSERT INTO music_shouts VALUES('second',NULL,'99998','原名字','second',11,12,2)").run();db.prepare("INSERT INTO music_shouts VALUES('third',NULL,'99997','原名字','third',13,14,3)").run();}
  if(options.consumed)db.prepare("INSERT INTO login_attempts(id,token_hash,user_id,provider,app_id,mode,status,expires_at,created_at) VALUES('baseline-used','synthetic',NULL,'qq','synthetic','login','used','expired',?)").run(stamp.toISOString());
  if(options.highWater){const row=db.prepare("SELECT payload_json FROM music_documents WHERE kind='identity_source'").get() as {payload_json:string},value=JSON.parse(row.payload_json);value.sqliteSequence=[{name:'link_audit',seq:'800'}];db.prepare("UPDATE music_documents SET payload_json=? WHERE kind='identity_source'").run(JSON.stringify(value));}
  const generated=saveProfile(db,'fresh-native',{profileId:null,revision:0,musicEpoch:0,selections:[{entryId:'e',level:1}]},stamp),journal=erasureJournal(db),base=projectRollbackState(db,journal);
  const oldIdentity=new Database(base.identityImage),oldBoard=new Database(base.boardImage);cleanup.push(()=>oldIdentity.close(),()=>oldBoard.close());let old=structuredClone(base.music.data);
  const baselineMusic=pin(Buffer.from(JSON.stringify({...base.music,identityAuditMappings:base.identityAuditMappings}))),baselineJournal=pin(Buffer.from(base.journal.map(row=>JSON.stringify(row)+'\n').join('')));
  const input=():ForwardMusicInput=>({checkpoint:pin(base.checkpointImage),baselineBoard:pin(base.boardImage),baselineJournal,nativeImage:pin(captureRollbackCheckpoint(db,journal).image),nativeJournal:pin(Buffer.from(journal.read().map(row=>JSON.stringify(row)+'\n').join(''))),oldBoard:pin(oldBoard.serialize()),baselineMusic,baselineIdentity:pin(base.identityImage),oldMusic:pin(Buffer.from(JSON.stringify(old))),oldIdentity:pin(oldIdentity.serialize())});
  return {db,base,journal,generated,oldIdentity,oldBoard,input,get old(){return old;},set old(value:ObjectValue){old=value;}};
}
function open(bytes:Buffer){const db=new Database(bytes);cleanup.push(()=>db.close());return db;}
function members(data:ObjectValue){return object(data.members,'test members');}
function member(data:ObjectValue,key:string){return object(members(data)[key],'test member');}
function alter(input:ForwardMusicInput,name:'oldIdentity'|'baselineIdentity'|'nativeImage'|'checkpoint',change:(db:Database.Database)=>void){const db=new Database(input[name].bytes);try{change(db);input[name]=pin(db.serialize());}finally{db.close();}}
function changeMusic(input:ForwardMusicInput,name:'baselineMusic'|'oldMusic',change:(data:ObjectValue)=>void){const data=object(JSON.parse(input[name].bytes.toString()),'test source');change(data);input[name]=pin(Buffer.from(JSON.stringify(data)));}

it('merges real Python profile creation, contact, selection, shout, pending proof and unlink writes without losing native changes or original generated profile IDs',async()=>{
  const s=await setup();s.db.prepare("UPDATE music_profile_fields SET note='新版私人留言',note_at=17.25,revision=1 WHERE profile_id=?").run(profileId('10001'));
  const folder=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'qgroup-forward-music-')));cleanup.push(()=>fs.rmSync(folder,{recursive:true,force:true}));fs.writeFileSync(join(folder,'data.json'),JSON.stringify(s.old),{mode:0o600});fs.writeFileSync(join(folder,'identity.sqlite3'),s.oldIdentity.serialize(),{mode:0o600});
  const result=JSON.parse(execFileSync('python3',['-c',`import json,sys
from pathlib import Path
from music_site.identity_store import Store
from music_site import upstream,contacts,admin_links
root=Path(sys.argv[1]);store=Store(root/'identity.sqlite3')
upstream.DATA_FILE=str(root/'data.json');upstream.BACKUP_DIR=str(root/'backups');upstream.data=json.loads((root/'data.json').read_text())
key=store.create_profile(dict(user_id='fresh-old'), '舊站新增成分')
store.recover_profiles(upstream.data);contacts.save(upstream.data,store,key,'98765')
class Fake:
 def send_json(self,value,status=200):
  assert status==200,(value,status)
  return value
upstream.Handler.api_selection(Fake(),dict(qq=key,selection=[dict(id='e',level=2)]))
upstream.Handler.api_shout(Fake(),dict(qq=key,text='舊站新增喊話'))
with store.connect() as db:rev=store.admin_state(db,'10002')['revision']
admin_links.change(upstream.data,store,dict(qq='10002',user_id='',base_revision=rev),'admin:synthetic')
entry=store.entry_start(dict(session='original-device',user_id='fresh-old'),dict(selection=[dict(id='e',level=2)]),key)
session=store.new_session('10002');store.login_allowed('10002','192.0.2.1')
upstream.save()
print(json.dumps(dict(key=key,entry=Store.digest(entry),session=Store.digest(session))))`,folder],{encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH,PYTHONPATH:process.cwd(),JPM_DATA:join(folder,'data.json')}}));
  const input=s.input();input.oldMusic=pin(fs.readFileSync(join(folder,'data.json')));input.oldIdentity=pin(fs.readFileSync(join(folder,'identity.sqlite3')));const originalNative=Buffer.from(input.nativeImage.bytes),merged=mergeForwardMusic(input),identity=open(merged.identityImage);
  expect(member(merged.music.data,'10001').note).toBe('新版私人留言');expect(member(merged.music.data,result.key)).toMatchObject({name:'舊站新增成分',contactQQ:'98765',boardUserId:'fresh-old',selection:[{id:'e',level:2}]});expect(member(merged.music.data,'10002').boardUserId).toBe('');
  expect(merged.music.keys.find(row=>row.profileId===s.generated.id)).toEqual(s.base.music.keys.find(row=>row.profileId===s.generated.id));expect(merged.music.keys.find(row=>row.legacyKey===result.key)?.profileId).toBe(profileId(result.key));
  expect(identity.prepare('SELECT * FROM entry_intents WHERE token_hash=?').get(result.entry)).toMatchObject({source_session:'original-device',target_user_id:'fresh-old'});expect(identity.prepare('SELECT qq FROM sessions WHERE token_hash=?').get(result.session)).toEqual({qq:'10002'});
  expect(identity.prepare('SELECT * FROM link_audit ORDER BY id DESC LIMIT 1').get()).toMatchObject({qq:'10002',actor:'admin:synthetic',before_user_id:'bob',after_user_id:''});
  expect((merged.music.data.shouts as ObjectValue[]).some(row=>row.text==='舊站新增喊話')).toBe(true);expect(merged.report).toMatchObject({sourceOnly:true,nativeReconstructionRequired:true,authenticationActive:false,recoveryRequired:true,releaseEligible:false,rollbackEligible:false});expect(input.nativeImage.bytes).toEqual(originalNative);expect(verifyForwardMusicMerge(input,merged.music,merged.identityImage).sourceDigest).toBe(merged.report.reconciliation.sourceDigest);
});
it('preserves exact legacy choice representations, opaque timestamps, PIN hashes, creators, aliases and shout/trend history when unchanged',async()=>{
  const s=await setup(),input=s.input(),merged=mergeForwardMusic(input);expect(musicEqual(merged.music,s.base.music)).toBe(true);expect(member(merged.music.data,'10001').selection).toEqual([{id:'e',level:4},{id:'e',level:'2'}]);expect(member(merged.music.data,'10001').pinHash).toBe('CURRENT-PIN');expect(merged.music.data.trend).toEqual(s.base.music.data.trend);expect([...forwardRows(open(merged.identityImage),'prelinks')]).toEqual([...forwardRows(s.oldIdentity,'prelinks')]);
});
it('coalesces identical concurrent updates, accepts old catalog additions and retains exact JSON key and ordered choice changes',async()=>{
  const s=await setup();s.db.prepare("UPDATE music_profile_fields SET note='共同修改' WHERE profile_id=?").run(profileId('10001'));member(s.old,'10001').note='共同修改';object(s.old.entries,'entries').new={id:'new',text:'新詞條',kind:'sub',aliases:['別名'],createdAt:'opaque-time',updatedAt:false,createdBy:'10002'};member(s.old,'10002').selection=[{id:'new',level:'4'},{entryId:'e',level:true}];member(s.old,'10002').created=['e','new'];const merged=mergeForwardMusic(s.input());expect(member(merged.music.data,'10001').note).toBe('共同修改');expect(member(merged.music.data,'10002').selection).toEqual(member(s.old,'10002').selection);expect(object(merged.music.data.entries,'entries').new).toEqual(object(s.old.entries,'entries').new);
});
it('merges independent new shouts and preserves each origin order without inferring temporal order',async()=>{
  const s=await setup();s.db.prepare("INSERT INTO music_shouts VALUES('native-new',NULL,'99998','原名字','native',321.25,NULL,20)").run();(s.old.shouts as JsonLike[]).push({id:'old-new',qq:'99997',name:'舊名字',text:'old',createdAt:'322'});const merged=mergeForwardMusic(s.input());expect((merged.music.data.shouts as ObjectValue[]).map(row=>row.id)).toEqual(['old','native-new','old-new']);expect((merged.music.data.shouts as ObjectValue[]).at(-1)?.createdAt).toBe('322');
});
type JsonLike=ObjectValue;
it('keeps signed identity rowids, REAL times, source tables and high-water without renumbering',async()=>{
  const s=await setup();s.oldIdentity.prepare("INSERT INTO login_attempts(rowid,bucket,created) VALUES(-9,?,123.25)").run('ip:'+'a'.repeat(64));s.oldIdentity.prepare("INSERT INTO used_oauth(rowid,attempt,created) VALUES(-3,'old-consumed',456.5)").run();s.oldIdentity.prepare("INSERT INTO sqlite_sequence VALUES('link_audit',700)").run();const merged=mergeForwardMusic(s.input()),db=open(merged.identityImage);expect([...forwardRows(db,'login_attempts')]).toEqual([...forwardRows(s.oldIdentity,'login_attempts')]);expect(db.prepare('SELECT seq FROM sqlite_sequence').get()).toEqual({seq:700});
});
it('preserves a legitimate old-only reorder and rejects contradictory concurrent shout orders',async()=>{
  const s=await setup({historyPair:true});s.old.shoutHistory=[...(s.old.shoutHistory as ObjectValue[])].reverse();const first=mergeForwardMusic(s.input());expect(first.music.data.shoutHistory).toEqual(s.old.shoutHistory);
  s.db.prepare("UPDATE music_shouts SET ordinal=-9 WHERE id='second'").run();expect(()=>mergeForwardMusic(s.input())).toThrow('order conflict');
});
it.each(['checkpoint','baselineBoard','baselineJournal','nativeImage','nativeJournal','oldBoard','baselineMusic','baselineIdentity','oldMusic','oldIdentity'] as const)('rejects a changed %s source pin',async name=>{const input=(await setup()).input();input[name].sha256='e'.repeat(64);expect(()=>mergeForwardMusic(input)).toThrow('source pin differs');});
it.each(['duplicate-json','unknown-root','unknown-member','unknown-entry','unknown-settings','unknown-shout','unknown-trend','missing-choice','missing-created','duplicate-shout'] as const)('rejects unsupported or unresolved old source %s',async kind=>{
  const s=await setup(),input=s.input();if(kind==='duplicate-json')input.oldMusic=pin(Buffer.from('{"entries":{},"entries":{},"members":{}}'));
  else changeMusic(input,'oldMusic',data=>{if(kind==='unknown-root')data.extra=true;if(kind==='unknown-member')member(data,'10002').extra=true;if(kind==='unknown-entry')object(object(data.entries,'entries').e,'e').extra=true;if(kind==='unknown-settings')object(data.settings,'settings').extra=true;if(kind==='unknown-shout')object((data.shouts as ObjectValue[])[0],'shout').extra=true;if(kind==='unknown-trend')object((data.trend as ObjectValue[])[0],'trend').extra=true;if(kind==='missing-choice')member(data,'10002').selection=['missing'];if(kind==='missing-created')member(data,'10002').created=['missing'];if(kind==='duplicate-shout')(data.shoutHistory as ObjectValue[]).push(structuredClone((data.shouts as ObjectValue[])[0]!));});
  expect(()=>mergeForwardMusic(input)).toThrow();
});
it.each(['member','entry','trend','identity-row','identity-pk','ownership','contact','orphan-contact'] as const)('blocks conflicting %s changes without modifying any input',async kind=>{
  const s=await setup();if(kind==='member'){s.db.prepare("UPDATE music_profile_fields SET note='native' WHERE profile_id=?").run(profileId('10002'));member(s.old,'10002').note='old';}
  if(kind==='entry'){s.db.prepare("UPDATE music_entries SET name='native' WHERE id='e'").run();object(object(s.old.entries,'entries').e,'e').text='old';}
  if(kind==='trend'){s.db.prepare("INSERT INTO music_documents VALUES('trend_sample',0,'{\"t\":555,\"counts\":{}}')").run();(s.old.trend as ObjectValue[])[0]!.counts={e:666};}
  if(kind==='identity-row'){s.db.prepare("INSERT INTO music_claim_attempts VALUES(?,111)").run('ip:'+'a'.repeat(64));s.oldIdentity.prepare('INSERT INTO login_attempts VALUES(?,222)').run('ip:'+'b'.repeat(64));}
  if(kind==='identity-pk'){const profile=saveProfile(s.db,'later-native',{profileId:null,revision:0,musicEpoch:0,selections:[]},stamp),current=projectRollbackState(s.db,s.journal),key=current.music.keys.find(row=>row.profileId===profile.id)!.legacyKey,identity=open(current.identityImage),row=identity.prepare('SELECT * FROM prelinks WHERE qq=?').get(key) as {qq:string;user_id:string;created:number};members(s.old)[key]=structuredClone(member(current.music.data,key));s.oldIdentity.prepare('INSERT INTO prelinks(rowid,qq,user_id,created) VALUES(77,?,?,?)').run(row.qq,row.user_id,row.created);}
  if(kind==='ownership')s.oldIdentity.prepare("INSERT INTO links VALUES('10001','synthetic','subject','bob',123,'original')").run();
  if(kind==='contact'){const key=s.base.music.keys.find(row=>row.profileId===s.generated.id)!.legacyKey;s.oldIdentity.prepare('INSERT INTO profile_contacts VALUES(?,?,123)').run(key,'10002');}
  if(kind==='orphan-contact')s.oldIdentity.prepare("INSERT INTO profile_contacts VALUES('99998','10002',123)").run();
  const input=s.input(),before=Object.fromEntries(Object.entries(input).map(([key,value])=>[key,Buffer.from(value.bytes)]));expect(()=>mergeForwardMusic(input)).toThrow();for(const [key,value] of Object.entries(input))expect(value.bytes).toEqual(before[key]);
});
it.each(['independent','shared-prefix','repeated-value','numeric-object-keys'] as const)('preserves concurrent trend appends and independently checks their order: %s',async kind=>{
  const s=await setup(),shared={t:101,counts:{}},nativeOnly={t:102,counts:{}},legacyOnly={t:103,counts:{}},before=structuredClone(s.old.trend as ObjectValue[]);
  const nativeTail=kind==='shared-prefix'?[shared,nativeOnly]:[nativeOnly],legacyTail=kind==='shared-prefix'?[shared,legacyOnly]:kind==='repeated-value'?[legacyOnly,nativeOnly]:[legacyOnly];
  for(const [position,point] of nativeTail.entries())s.db.prepare("INSERT INTO music_documents VALUES('trend_sample',?,?)").run(position,JSON.stringify(point));
  (s.old.trend as ObjectValue[]).push(...legacyTail);
  if(kind==='numeric-object-keys'){
    // Array-index object keys sort ahead of generated string keys; 2^32-1 and
    // leading-zero keys remain strings. The array shout order stays independent.
    for(const id of ['4294967295','01','12','2'])object(s.old.entries,'entries')[id]={id,text:id,kind:'sub'};
    s.db.prepare("INSERT INTO music_entries VALUES('native-string','native','sub')").run();
  }
  const input=s.input(),merged=mergeForwardMusic(input),expected=[...before,...nativeTail,...legacyTail.slice(kind==='shared-prefix'?1:0)];
  expect(merged.music.data.trend).toEqual(expected);expect(verifyForwardMusicMerge(input,merged.music,merged.identityImage).releaseEligible).toBe(false);
  if(kind==='numeric-object-keys')expect(Object.keys(object(merged.music.data.entries,'entries'))).toEqual(['2','12','e','native-string','4294967295','01']);
  for(const change of [(music:RollbackMusic)=>{(music.data.trend as ObjectValue[]).reverse();},(music:RollbackMusic)=>{(music.data.trend as ObjectValue[]).pop();},(music:RollbackMusic)=>{(music.data.trend as ObjectValue[]).at(-1)!.t=999;}]){
    const altered=structuredClone(merged.music);change(altered);expect(()=>verifyForwardMusicMerge(input,altered,merged.identityImage)).toThrow('reconciliation');
  }
});
it('rejects an unproved member disappearance, identity schema/storage changes and an unverified checkpoint projection',async()=>{
  const s=await setup(),missing=s.input();changeMusic(missing,'oldMusic',data=>{delete members(data)['10002'];});expect(()=>mergeForwardMusic(missing)).toThrow('member disappearance');const schema=s.input();alter(schema,'oldIdentity',db=>db.exec('CREATE TABLE unknown(value)'));expect(()=>mergeForwardMusic(schema)).toThrow('identity schema');const storage=s.input();alter(storage,'oldIdentity',db=>db.prepare("UPDATE prelinks SET user_id=? WHERE qq='10001'").run(Buffer.from('alice')));expect(()=>mergeForwardMusic(storage)).toThrow('storage class');const baseline=s.input();changeMusic(baseline,'baselineMusic',data=>{member(object(data.data,'data'),'10001').name='forged';});expect(()=>mergeForwardMusic(baseline)).toThrow('reconciliation');
});
it('blocks reviving an erased profile from a pre-erasure old source while preserving every original input',async()=>{
  const s=await setup(),privacy=createPrivacy(s.db,s.journal);s.db.transaction(()=>privacy.submit({version:1,kind:'music',userId:'bob',profileId:profileId('10002'),requestId:randomUUID(),createdAt:stamp.toISOString(),secretHash:hash('synthetic-secret'),signature:hash('synthetic-signature')})).immediate();privacy.guard();const input=s.input(),before=Buffer.from(input.oldMusic.bytes);expect(()=>mergeForwardMusic(input)).toThrow('authority-backed cleanup');expect(input.oldMusic.bytes).toEqual(before);
});
it('accepts an old source sanitized by the real Python erasure replay against the latest verified native deletion',async()=>{
  const s=await setup(),privacy=createPrivacy(s.db,s.journal);s.db.transaction(()=>privacy.submit({version:1,kind:'music',userId:'bob',profileId:profileId('10002'),requestId:randomUUID(),createdAt:stamp.toISOString(),secretHash:hash('synthetic-secret'),signature:hash('synthetic-signature')})).immediate();privacy.guard();
  const folder=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'qgroup-forward-erased-music-')));cleanup.push(()=>fs.rmSync(folder,{recursive:true,force:true}));fs.writeFileSync(join(folder,'data.json'),JSON.stringify(s.old),{mode:0o600});fs.writeFileSync(join(folder,'identity.sqlite3'),s.oldIdentity.serialize(),{mode:0o600});fs.writeFileSync(join(folder,'erasures.jsonl'),JSON.stringify({qq:'10002',erased_at:stamp.getTime()/1000})+'\n',{mode:0o600});
  execFileSync('python3',['-c',`import sys
from music_site.identity_store import Store
from music_site.maintenance import replay
replay(sys.argv[1],Store(sys.argv[1]+'/identity.sqlite3'))`,folder],{timeout:10000,env:{PATH:process.env.PATH,PYTHONPATH:process.cwd()}});
  const input=s.input();input.oldMusic=pin(fs.readFileSync(join(folder,'data.json')));input.oldIdentity=pin(fs.readFileSync(join(folder,'identity.sqlite3')));const merged=mergeForwardMusic(input);expect(members(merged.music.data)['10002']).toBeUndefined();expect(merged.music.keys.find(row=>row.profileId===profileId('10002'))?.erased).toBe(true);expect(object(object(merged.music.data.entries,'entries').e,'e').createdBy).toBe('');expect((merged.music.data.shouts as ObjectValue[]).some(row=>row.qq==='10002')).toBe(false);expect(open(merged.identityImage).prepare("SELECT 1 FROM prelinks WHERE qq='10002'").get()).toBeUndefined();
});
it('rejects rewriting consumed OAuth history or rewinding original identity high-water',async()=>{
  const s=await setup({consumed:true});s.oldIdentity.prepare("DELETE FROM used_oauth WHERE attempt='baseline-used'").run();expect(()=>mergeForwardMusic(s.input())).toThrow('consumed OAuth history');const other=await setup({highWater:true});other.oldIdentity.prepare("UPDATE sqlite_sequence SET seq=0 WHERE name='link_audit'").run();expect(()=>mergeForwardMusic(other.input())).toThrow('high-water rewound');
});
it('checks original mapping, all output documents, identity rows and high-water independently even after output repinning',async()=>{
  const s=await setup(),input=s.input(),merged=mergeForwardMusic(input);
  for(const change of [(music:RollbackMusic)=>{music.keys[0]!.profileId='m_'+'f'.repeat(40);},(music:RollbackMusic)=>{member(music.data,'10001').pinHash='forged';},(music:RollbackMusic)=>{(music.data.trend as ObjectValue[]).push({t:0,counts:{}});},(music:RollbackMusic)=>{music.data.extra='forged';}]){const music=structuredClone(merged.music);change(music);expect(()=>verifyForwardMusicMerge(input,music,merged.identityImage)).toThrow();}
  const db=open(merged.identityImage);db.prepare("UPDATE prelinks SET created=99 WHERE qq='10001'").run();expect(()=>verifyForwardMusicMerge(input,merged.music,db.serialize())).toThrow('reconciliation');
});
it('rechecks source buffers and pins at the final boundary and rejects asynchronous boundaries',async()=>{
  const s=await setup(),input=s.input();let calls=0;expect(()=>mergeForwardMusic(input,()=>{if(++calls===2)input.oldMusic.bytes[0]=32;})).toThrow('source changed');expect(calls).toBe(2);const other=s.input();expect(()=>mergeForwardMusic(other,(()=>Promise.resolve()) as unknown as ()=>void)).toThrow('synchronous');
});
it('independently reconciles all 10 identity tables and private music values with a Python readonly oracle',async()=>{
  const s=await setup();member(s.old,'10002').note='舊站更新';s.oldIdentity.prepare("INSERT INTO used_oauth VALUES('original-used',321.25)").run();const input=s.input(),merged=mergeForwardMusic(input),folder=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'qgroup-music-oracle-')));cleanup.push(()=>fs.rmSync(folder,{recursive:true,force:true}));
  for(const [name,bytes] of [['base',input.baselineIdentity.bytes],['old',input.oldIdentity.bytes],['candidate',merged.identityImage]] as const)fs.writeFileSync(join(folder,name+'.sqlite3'),bytes,{mode:0o600});for(const [name,data] of [['base',s.base.music.data],['old',s.old],['candidate',merged.music.data]] as const)fs.writeFileSync(join(folder,name+'.json'),JSON.stringify(data),{mode:0o600});
  const report=JSON.parse(execFileSync('python3',['-c',`import json,sqlite3,sys
from pathlib import Path
from contextlib import ExitStack,closing
root=Path(sys.argv[1])
with ExitStack() as stack:
 dbs={name:stack.enter_context(closing(sqlite3.connect((root/(name+'.sqlite3')).as_uri()+'?mode=ro',uri=True))) for name in ('base','old','candidate')}
 tables=[r[0] for r in dbs['base'].execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")];assert len(tables)==10
 for table in tables:
  columns=[r[1] for r in dbs['base'].execute('PRAGMA table_xinfo("'+table+'")')]
  query='SELECT rowid,*,'+','.join('typeof("'+column+'")' for column in columns)+' FROM "'+table+'" ORDER BY rowid'
  assert list(dbs['old'].execute(query))==list(dbs['candidate'].execute(query)),table
 assert list(dbs['old'].execute('SELECT * FROM sqlite_sequence'))==list(dbs['candidate'].execute('SELECT * FROM sqlite_sequence'))
 data={name:json.loads((root/(name+'.json')).read_text()) for name in ('base','old','candidate')}
 assert data['candidate']==data['old']
 assert data['candidate']['members']['10001']==data['base']['members']['10001']
 assert data['candidate']['members']['10002']['note']=='舊站更新'
 assert dbs['candidate'].execute('PRAGMA integrity_check').fetchone()==('ok',)
 print(json.dumps(dict(tables=10,musicValues=True,storageClasses=True,privateProofsRetained=True)))`,folder],{encoding:'utf8',timeout:10000}));expect(report).toEqual({tables:10,musicValues:true,storageClasses:true,privateProofsRetained:true});
});
