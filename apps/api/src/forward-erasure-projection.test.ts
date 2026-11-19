import * as fs from 'node:fs';
import {dirname,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import Database from 'better-sqlite3';
import {openDatabase} from '@qgroup/database';
import {afterEach,it,expect} from 'vitest';
import {legacyHistoryFixture} from '../testsupport/legacy-history-fixture';
import {createPrivacy} from './privacy';
import {hash} from './security';
import {saveProfile} from './repositories';
import {erasureJournal,erasureJournalPath,decodeErasureJournal,readVerifiedErasureJournal,type ErasureIntent} from './erasure-journal';
import {captureRollbackCheckpoint} from '../../../tools/migration/rollback-checkpoint';
import {captureRollbackMedia} from '../../../tools/migration/rollback-media';
import {projectRollbackStateFromCheckpoint} from '../../../tools/migration/rollback-state';
import {projectRollbackHistory} from '../../../tools/migration/rollback-history';
import {assembleRollbackPackage,pinRollbackPackageSource} from '../../../tools/migration/rollback-package-codec';
import {writeRollbackPackage} from '../../../tools/migration/rollback-package';
import {writeRollbackErasureAuthority,readRollbackErasureAuthority} from '../../../tools/migration/rollback-erasure-authority';
import {projectNativeForwardErasures,type ForwardErasureInput} from '../../../tools/migration/forward-erasure-projection';
import {profileId,digest} from '../../../tools/migration/music-codec';
import {exportLegacyMusic} from './legacy-music-export';
const cleanup:(()=>void)[]=[];afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
const stamp=new Date('2026-11-20T01:00:00Z');
async function setup(options:{opaque?:boolean;generated?:boolean;musicOnly?:boolean}={}){
 const s=await legacyHistoryFixture(options.opaque?{musicLedger:JSON.stringify({qq:'99999',erased_at:{original:'unknown-time'}})+'\n'}:{});cleanup.push(()=>s.close());
 s.db.prepare("INSERT INTO event_audit(event_id,version,actor_id,actor_name,action,before_json,after_json,reason,created_at) VALUES('listen',1,'alice','原名','event_updated','{}','{}','原原因','before')").run();
 s.db.prepare("INSERT INTO finance_entries(id,event_id,kind,payload_json,occurred_at,actor_id,actor_name,created_at) VALUES('frozen-money','listen','expense','{\"amount_cents\":-101}','unknown-zone','alice','原帳本名字','before')").run();
 s.db.prepare("INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,qr_image,updated_at,actor_id,actor_name,kind,changed_fields) VALUES('listen',1,-101,3,'原帳單',?,'unknown-zone','alice','原名','full','[]')").run(Buffer.from([0,1,255]));
 const journal=erasureJournal(s.db),earlier=captureRollbackCheckpoint(s.db,journal).image;
 let generated:string|undefined;if(options.generated){s.db.prepare("INSERT INTO users VALUES('native-member',?,'合成新會員','synthetic')").run(hash('fixture-native-member'));generated=saveProfile(s.db,'native-member',{profileId:null,revision:0,musicEpoch:0,selections:[]},stamp).id;}
 const baselineIntent:ErasureIntent={version:1,kind:'both',userId:'bob',profileId:profileId('10002'),requestId:randomUUID(),createdAt:stamp.toISOString(),secretHash:hash('private-fixture-secret'),signature:hash('synthetic-baseline-signature')},privacy=createPrivacy(s.db,journal);s.db.transaction(()=>privacy.submit(baselineIntent)).immediate();privacy.guard();
 let musicIntent:ErasureIntent|undefined;if(options.musicOnly){musicIntent={...baselineIntent,kind:'music',userId:'alice',profileId:profileId('10001'),requestId:randomUUID()};s.db.transaction(()=>privacy.submit(musicIntent!)).immediate();privacy.guard();}
 for(const [i,status] of ['pending','sending','sent','failed','skipped'].entries())s.db.prepare("INSERT INTO bot_outbox(event_id,kind,dedupe_key,target,payload_json,status,claim_token,retry_at,simulated_at,delivered_payload_json,created_at) VALUES('listen','forward',?,'synthetic','{}',?,?,?,?,?,'before')").run('forward-'+i,status,status==='sending'?'uncertain-fixture':'',status==='failed'?'retry-fixture':null,status==='skipped'?'simulation-fixture':null,status==='sent'?'sent-fixture':null);
 const media=captureRollbackMedia(s.db,journal),state=projectRollbackStateFromCheckpoint(media.checkpointImage,media.journal),history=projectRollbackHistory(state,{capture:s.config,native:{root:join(dirname(s.db.name),'paired-backups'),manifests:[]}}),pkg=assembleRollbackPackage(state,media,history,pinRollbackPackageSource(media,{captureManifestSha256:s.config.manifestSha256,native:[]})),packageRoot=join(s.root,'package'),packagePin=writeRollbackPackage(pkg,packageRoot,[s.capture,dirname(s.db.name)],stamp).manifestSha256,authorityRoot=join(s.root,'authority'),saved=writeRollbackErasureAuthority(packageRoot,packagePin,authorityRoot,stamp,undefined,{database:s.db.name,sha256:digest(fs.readFileSync(erasureJournalPath(s.db.name)))});
 const originalNative=fs.readFileSync(erasureJournalPath(s.db.name)),input:ForwardErasureInput={authorityRoot,manifestSha256:saved.manifestSha256,checkpoint:Buffer.from(media.checkpointImage),nativeImage:Buffer.from(media.checkpointImage),nativeImageSha256:digest(media.checkpointImage),nativeJournal:originalNative,nativeJournalSha256:digest(originalNative)};
 const folders=Object.fromEntries(['board','music','unified'].map(domain=>{const folder=join(s.root,'old-'+domain);fs.mkdirSync(folder,{mode:0o700});const path=join(folder,domain+'.erasures.jsonl');fs.writeFileSync(path,readRollbackErasureAuthority(authorityRoot,saved.manifestSha256).ledgers[domain as 'board'|'music'|'unified'],{mode:0o600});return [domain,path];}));
 function record(domain:string,rows:unknown[]){execFileSync('python3',['-c',"from tools.migration.rollback_erasure_authority import ErasureAuthority\nimport sys,json\nroot,pin,bindings,domain,rows=sys.argv[1:]\na=ErasureAuthority(root,pin,json.loads(bindings))\ntry:a.record(domain,(''.join(json.dumps(row,ensure_ascii=False)+'\\n' for row in json.loads(rows))).encode())\nfinally:a.close()",authorityRoot,saved.manifestSha256,JSON.stringify(folders),domain,JSON.stringify(rows)],{timeout:10000,stdio:'pipe'});}
 return {...s,input,earlier,state,record,generated,baselineIntent,musicIntent};
}
function open(result:ReturnType<typeof projectNativeForwardErasures>){const db=new Database(result.nativeImage);cleanup.push(()=>db.close());return db;}
function changeImage(input:ForwardErasureInput,change:(db:Database.Database)=>void){const db=new Database(input.nativeImage);try{db.pragma('foreign_keys = ON');change(db);input.nativeImage=db.serialize();input.nativeImageSha256=digest(input.nativeImage);}finally{db.close();}}
function data(db:Database.Database){return Object.fromEntries((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[]).map(row=>[row.name,db.prepare('SELECT rowid,* FROM "'+row.name+'" ORDER BY rowid').safeIntegers().all()]));}
it('projects actual Python old-service closure/music bytes without inventing receipts, preserves native prefixes and leaves the source/authority unchanged',async()=>{
 const s=await setup(),closure={user_id:'alice',request_id:'original-old-request',created_at:'original-unknown-zone'};s.record('board',[closure]);s.record('music',[{qq:'10001',erased_at:1001.25}]);const source=s.db.serialize(),head=fs.readFileSync(join(s.input.authorityRoot,'authority-head.json')),result=projectNativeForwardErasures(s.input),db=open(result);
 expect(result.nativeJournal.subarray(0,s.input.nativeJournal.length)).toEqual(s.input.nativeJournal);expect(decodeErasureJournal(result.nativeJournal.toString())).toEqual([s.baselineIntent,closure]);expect(result.boardJournal).toEqual(readRollbackErasureAuthority(s.input.authorityRoot,s.input.manifestSha256).ledgers.board);expect(result.musicJournal).toEqual(readRollbackErasureAuthority(s.input.authorityRoot,s.input.manifestSha256).ledgers.music);
 expect(db.prepare("SELECT nickname FROM users WHERE id='alice'").get()).toEqual({nickname:'已注销用户'});expect(db.prepare("SELECT id,created_at FROM privacy_requests WHERE user_id='alice'").get()).toEqual({id:closure.request_id,created_at:closure.created_at});expect(db.prepare('SELECT 1 FROM privacy_receipts WHERE request_id=?').get(closure.request_id)).toBeUndefined();expect(db.prepare('SELECT erased_at_json FROM music_legacy_erasures WHERE legacy_key=?').get('10001')).toEqual({erased_at_json:'1001.25'});expect(db.prepare('SELECT erased_at FROM music_profiles WHERE id=?').get(profileId('10001'))).toEqual({erased_at:'1970-01-01T00:16:41.250Z'});
 expect(db.prepare('SELECT * FROM bot_outbox ORDER BY id').all()).toEqual(s.db.prepare('SELECT * FROM bot_outbox ORDER BY id').all());expect(db.prepare('SELECT * FROM events').all()).toEqual(s.db.prepare('SELECT * FROM events').all());
 const before=data(s.db),after=data(db);for(const table of ['registrations','roster_parties','attendees','event_audit','attendee_consents','event_roles','management_invitations','settlement_history','finance_reports','finance_report_actions','finance_entries','attendee_claims','attendee_payment_origins','time_polls','time_poll_history','bot_settings','bot_settings_history','bot_runtime','privacy_receipts','music_entries'])expect(after[table],table).toEqual(before[table]);
 for(const table of ['external_profiles','external_identities','qq_accounts','qq_attempts','login_attempts','privacy_consents','user_payment_codes','notifications','request_results','device_links','admin_user_metadata','browser_accounts','browser_sessions','time_poll_votes','time_poll_ballots','event_access','unified_privacy_consents','unified_privacy_receipts'])expect(db.prepare('SELECT 1 FROM '+table+' WHERE user_id=\'alice\' LIMIT 1').get(),table).toBeUndefined();
 for(const table of ['music_legacy_profiles','music_selections','music_profile_contacts','music_contact_history','music_profile_fields','music_field_history','music_profile_audit','music_ownership_history','music_pin_history','music_profile_creation','music_claim_intents','music_shouts','music_shout_authors'])expect(db.prepare('SELECT 1 FROM '+table+' WHERE profile_id=? LIMIT 1').get(profileId('10001')),table).toBeUndefined();expect(db.prepare('SELECT recovery_required FROM rebuild_storage').get()).toEqual({recovery_required:1});expect(result.report).toMatchObject({erasureOnly:true,recoveryRequired:true,releaseEligible:false,rollbackEligible:false,addedBoardIntents:1,headSequence:2});readVerifiedErasureJournal(db,{read:()=>decodeErasureJournal(result.nativeJournal.toString()),append(){throw Error();}});expect(s.db.serialize()).toEqual(source);expect(fs.readFileSync(join(s.input.authorityRoot,'authority-head.json'))).toEqual(head);
});
it('replays into an older same-lineage native image missing the entire baseline erasure footprint, without claiming recovery eligibility',async()=>{
 const s=await setup(),result=projectNativeForwardErasures({...s.input,nativeImage:s.earlier,nativeImageSha256:digest(s.earlier),nativeJournal:Buffer.alloc(0),nativeJournalSha256:digest('')}),db=open(result);
 expect(db.prepare("SELECT nickname FROM users WHERE id='bob'").get()).toEqual({nickname:'已注销用户'});expect(db.prepare('SELECT user_id,erased_at FROM music_profiles WHERE id=?').get(profileId('10002'))).toEqual({user_id:null,erased_at:stamp.toISOString()});expect(db.prepare('SELECT 1 FROM music_legacy_profiles WHERE profile_id=?').get(profileId('10002'))).toBeUndefined();expect(result.report.erasureOnly).toBe(true);expect(result.report.remaining).toContain('complete_old_and_native_business_forward_merge');
});
it('preserves an opaque original baseline erasure time and a key without surviving profile content',async()=>{
 const s=await setup({opaque:true}),result=projectNativeForwardErasures(s.input),db=open(result);expect(db.prepare("SELECT erased_at_json FROM music_legacy_erasures WHERE legacy_key='99999'").get()).toEqual({erased_at_json:JSON.stringify({original:'unknown-time'})});expect(result.report.musicScopes.find(row=>row.legacyKey==='99999')?.originalTime).toEqual({original:'unknown-time'});
});
it('uses the frozen generated old key to delete its original native profile ID rather than inventing a second profile',async()=>{
 const s=await setup({generated:true}),key=s.state.music.keys.find(row=>row.profileId===s.generated)!;expect(key.mode).toBe('generated');s.record('music',[{qq:key.legacyKey,erased_at:2001}]);const db=open(projectNativeForwardErasures(s.input));expect(db.prepare('SELECT user_id,erased_at FROM music_profiles WHERE id=?').get(s.generated!)).toEqual({user_id:null,erased_at:'1970-01-01T00:33:21.000Z'});expect(db.prepare('SELECT 1 FROM music_profiles WHERE id=?').get(profileId(key.legacyKey))).toBeUndefined();expect(db.prepare("SELECT target_id,status FROM migration_map WHERE source='music' AND source_id=? AND entity_type='profile'").get(key.legacyKey)).toEqual({target_id:s.generated,status:'erased'});
});
it('retains new old-service keys as mapped tombstones and projects current and historical export before any future import',async()=>{
 const s=await setup();s.record('music',[{qq:'98888',erased_at:2001}]);const result=projectNativeForwardErasures(s.input),db=open(result);expect(db.prepare('SELECT erased_at FROM music_profiles WHERE id=?').get(profileId('98888'))).toEqual({erased_at:'1970-01-01T00:33:21.000Z'});
 const raw={entries:{x:{id:'x',text:'保留詞條',createdBy:'98888'}},members:{'98888':{qq:'98888',name:'已刪合成會員'}},settings:{},shouts:[{qq:'98888',text:'已刪合成喊話'}],shoutHistory:[],trend:[]};const projected=exportLegacyMusic(raw,db,decodeErasureJournal(result.nativeJournal.toString()),new Set());expect(projected.members).toEqual({});expect(projected.shouts).toEqual([]);expect((projected.entries as Record<string,{createdBy:string}>).x!.createdBy).toBe('');
});
it('replays a projected candidate twice without duplicate closures, receipts, mappings, delivery work or changed semantic rows',async()=>{
 const s=await setup();s.record('board',[{user_id:'alice',request_id:'original-old-request',created_at:'original-time'}]);s.record('music',[{qq:'10001',erased_at:2001},{qq:'10001',erased_at:2002}]);const first=projectNativeForwardErasures(s.input),second=projectNativeForwardErasures({...s.input,nativeImage:first.nativeImage,nativeImageSha256:digest(first.nativeImage)});expect(data(open(second))).toEqual(data(open(first)));expect(second.nativeJournal).toEqual(first.nativeJournal);
});
it.each(['image pin','journal pin','checkpoint','foreign lineage','unrecorded journal','conflicting board request','wrong mapped key','interleaved writes','late authority','late source','async boundary'])('rejects %s and does not mutate supplied native images or original authority',async change=>{
 const s=await setup({musicOnly:change==='conflicting board request'}),input:ForwardErasureInput={...s.input,nativeImage:Buffer.from(s.input.nativeImage),nativeJournal:Buffer.from(s.input.nativeJournal),checkpoint:Buffer.from(s.input.checkpoint)};let boundary:(()=>void)|undefined;
 if(change==='image pin')input.nativeImageSha256='f'.repeat(64);if(change==='journal pin')input.nativeJournalSha256='f'.repeat(64);if(change==='checkpoint')input.checkpoint[100]=input.checkpoint[100]!^1;
 if(change==='unrecorded journal'){input.nativeJournal=Buffer.concat([input.nativeJournal,Buffer.from(JSON.stringify({user_id:'alice',request_id:'foreign',created_at:'foreign'})+'\n')]);input.nativeJournalSha256=digest(input.nativeJournal);}
 if(change==='conflicting board request')s.record('board',[{user_id:'alice',request_id:s.musicIntent!.requestId,created_at:s.musicIntent!.createdAt}]);
 if(change==='foreign lineage'){const fresh=openDatabase(':memory:');try{input.nativeImage=captureRollbackCheckpoint(fresh,{read:()=>[],append(){throw Error();}}).image;input.nativeImageSha256=digest(input.nativeImage);}finally{fresh.close();}}
 if(['wrong mapped key'].includes(change)){const db=new Database(input.nativeImage);try{if(change==='wrong mapped key')db.prepare("UPDATE migration_map SET target_id=? WHERE source='music' AND entity_type='profile' AND source_id='10001'").run(profileId('10002'));input.nativeImage=db.serialize();input.nativeImageSha256=digest(input.nativeImage);}finally{db.close();}}
 if(change==='interleaved writes'){s.record('music',[{qq:'10001',erased_at:2001}]);s.record('unified',[{user_id:'alice',request_id:'later-native',created_at:'later'}]);}
 if(change==='late authority')boundary=()=>{s.record('music',[{qq:'10001',erased_at:2001}]);};if(change==='late source')boundary=()=>{input.nativeImage[100]=input.nativeImage[100]!^1;};if(change==='async boundary')boundary=(()=>Promise.resolve()) as unknown as ()=>void;
 const original=Buffer.from(input.nativeImage);expect(()=>projectNativeForwardErasures(input,boundary)).toThrow();if(change!=='late source')expect(input.nativeImage).toEqual(original);
});

it('preserves a latest native administrative intent and receipt exactly, then projects old closure bytes and replays without duplicate audits',async()=>{
 const s=await setup(),id=profileId('m_'+'a'.repeat(24)),intent:ErasureIntent={version:2,kind:'admin_music',command:'delete_profile',actorRef:'account:alice',profiles:[{id,userId:'contact-owner'}],entries:[],requestId:randomUUID(),createdAt:'2026-11-20T02:00:00Z',secretHash:hash('synthetic-admin-secret'),signature:hash('synthetic-admin-signature')};
 s.record('unified',[intent]);s.record('board',[{user_id:'contact-owner',request_id:'old-account-only',created_at:'old-time'}]);const authoritative=readRollbackErasureAuthority(s.input.authorityRoot,s.input.manifestSha256).ledgers.unified,first=projectNativeForwardErasures(s.input),db=open(first);
 expect(first.nativeJournal.subarray(0,authoritative.length)).toEqual(authoritative);expect(db.prepare('SELECT secret_hash,signature FROM privacy_receipts WHERE request_id=?').get(intent.requestId)).toEqual({secret_hash:intent.secretHash,signature:intent.signature});expect(db.prepare('SELECT user_id,erased_at FROM music_profiles WHERE id=?').get(id)).toEqual({user_id:null,erased_at:intent.createdAt});expect(db.prepare("SELECT count(*) n FROM music_catalog_actions WHERE command='delete_profile'").get()).toEqual({n:1});
 const second=projectNativeForwardErasures({...s.input,nativeImage:first.nativeImage,nativeImageSha256:digest(first.nativeImage)});expect(data(open(second))).toEqual(data(db));
});
it('repairs private profile content restored under an already-applied latest native music-only intent while retaining the real receipt and website login',async()=>{
 const s=await setup(),id=profileId('m_'+'a'.repeat(24)),intent:ErasureIntent={...s.baselineIntent,kind:'music',userId:'contact-owner',profileId:id,requestId:randomUUID(),createdAt:'2026-11-20T02:00:00Z'};s.record('unified',[intent]);const intents=decodeErasureJournal(readRollbackErasureAuthority(s.input.authorityRoot,s.input.manifestSha256).ledgers.unified.toString());
 changeImage(s.input,db=>{createPrivacy(db,{read:()=>intents,append(){throw Error();}});db.prepare('INSERT INTO music_profile_fields VALUES(?,?,?,?,?,?,?,?)').run(id,'restored private name','private note',123,'other',0,1,'restore');});const receipt=open(projectNativeForwardErasures(s.input));expect(receipt.prepare('SELECT 1 FROM music_profile_fields WHERE profile_id=?').get(id)).toBeUndefined();expect(receipt.prepare("SELECT 1 FROM browser_sessions WHERE user_id='contact-owner'").get()).toBeDefined();expect(receipt.prepare('SELECT secret_hash,signature FROM privacy_receipts WHERE request_id=?').get(intent.requestId)).toEqual({secret_hash:intent.secretHash,signature:intent.signature});
});
it('does not overwrite a newer native tombstone marker or its original ledger JSON with an opaque baseline time',async()=>{
 const s=await setup({opaque:true});changeImage(s.input,db=>{db.prepare("UPDATE music_profiles SET erased_at='2026-11-20T03:00:00Z' WHERE id=?").run(profileId('99999'));db.prepare("UPDATE music_legacy_erasures SET erased_at_json=? WHERE legacy_key='99999'").run(JSON.stringify({original:'newer-native-time'}));});const db=open(projectNativeForwardErasures(s.input));expect(db.prepare('SELECT erased_at FROM music_profiles WHERE id=?').get(profileId('99999'))).toEqual({erased_at:'2026-11-20T03:00:00Z'});expect(db.prepare("SELECT erased_at_json FROM music_legacy_erasures WHERE legacy_key='99999'").get()).toEqual({erased_at_json:JSON.stringify({original:'newer-native-time'})});
});
it('keeps an old account-only closure separate from music-only deletion and retains unaffected accounts and profile content',async()=>{
 const s=await setup();s.record('board',[{user_id:'contact-owner',request_id:'old-account-only',created_at:'old-time'}]);s.record('music',[{qq:'10001',erased_at:'2026-11-20T03:00:00Z'}]);const db=open(projectNativeForwardErasures(s.input));expect(db.prepare('SELECT user_id,erased_at FROM music_profiles WHERE id=?').get(profileId('m_'+'a'.repeat(24)))).toEqual({user_id:null,erased_at:null});expect(db.prepare('SELECT 1 FROM music_profile_fields WHERE profile_id=?').get(profileId('m_'+'a'.repeat(24)))).toBeDefined();expect(db.prepare("SELECT nickname FROM users WHERE id='alice'").get()).toEqual(s.db.prepare("SELECT nickname FROM users WHERE id='alice'").get());expect(db.prepare("SELECT 1 FROM browser_sessions WHERE user_id='alice'").get()).toBeDefined();
});
it.each([null,{opaque:'new'},'unknown-zone',-1])('rejects a new old-service erasure time needing review: %j',async time=>{
 const s=await setup();s.record('music',[{qq:'10001',erased_at:time}]);expect(()=>projectNativeForwardErasures(s.input)).toThrow('time requires explicit review');
});
it.each(['WAL header','schema','current marker','generated key collision'])('rejects independently pinned unsafe native source: %s',async change=>{
 const s=await setup({generated:change==='generated key collision'});if(change==='WAL header'){s.input.nativeImage[18]=2;s.input.nativeImageSha256=digest(s.input.nativeImage);}
 else changeImage(s.input,db=>{if(change==='schema')db.exec('CREATE TABLE unsupported_forward(value TEXT)');if(change==='current marker')db.prepare("UPDATE music_profiles SET erased_at='invalid-time' WHERE id=?").run(profileId('10002'));if(change==='generated key collision'){const key=s.state.music.keys.find(row=>row.profileId===s.generated)!;db.prepare("INSERT INTO migration_map VALUES('music','profile',?,?,'','synthetic','erased')").run(key.legacyKey,profileId('98888'));}});
 expect(()=>projectNativeForwardErasures(s.input)).toThrow();
});

it('independently verifies projected SQLite scopes and unchanged shared rows with Python, and replays its exact retained music journal through original Python maintenance',async()=>{
 const s=await setup();s.record('board',[{user_id:'alice',request_id:'python-old-closure',created_at:'old-time'}]);s.record('music',[{qq:'10001',erased_at:2001}]);const result=projectNativeForwardErasures(s.input),folder=join(s.root,'independent-python');fs.mkdirSync(folder,{mode:0o700});
 for(const [name,bytes] of [['native.sqlite3',result.nativeImage],['source.sqlite3',s.input.nativeImage],['identity.sqlite3',s.state.identityImage],['data.json',Buffer.from(JSON.stringify(s.state.music.data))],['erasures.jsonl',result.musicJournal]] as const)fs.writeFileSync(join(folder,name),bytes,{mode:0o600});
 const output=execFileSync('python3',['-c',`import json,sqlite3,sys
from pathlib import Path
from contextlib import closing
from music_site.maintenance import replay
from music_site.identity_store import Store
folder=Path(sys.argv[1]);profile=sys.argv[2];ledger=(folder/'erasures.jsonl').read_bytes()
with closing(sqlite3.connect((folder/'native.sqlite3').as_uri()+'?mode=ro',uri=True)) as native, closing(sqlite3.connect((folder/'source.sqlite3').as_uri()+'?mode=ro',uri=True)) as source:
 assert native.execute('PRAGMA integrity_check').fetchone()==('ok',) and not native.execute('PRAGMA foreign_key_check').fetchall()
 for table in ('registrations','event_audit','settlement_history','finance_entries','bot_outbox','bot_settings','bot_settings_history','bot_runtime','privacy_receipts'):
  assert native.execute('SELECT rowid,* FROM '+table+' ORDER BY rowid').fetchall()==source.execute('SELECT rowid,* FROM '+table+' ORDER BY rowid').fetchall(),table
 assert native.execute("SELECT nickname FROM users WHERE id='alice'").fetchone()==('已注销用户',)
 assert not native.execute("SELECT 1 FROM browser_sessions WHERE user_id='alice'").fetchall()
 assert not native.execute('SELECT 1 FROM music_profile_fields WHERE profile_id=?',(profile,)).fetchall()
 assert native.execute('SELECT user_id,erased_at FROM music_profiles WHERE id=?',(profile,)).fetchone()==(None,'1970-01-01T00:33:21.000Z')
replay(folder,Store(folder/'identity.sqlite3'))
value=json.loads((folder/'data.json').read_text());assert '10001' not in value['members'];assert not any(str(row.get('qq'))=='10001' for kind in ('shouts','shoutHistory') for row in value.get(kind,[]))
with closing(sqlite3.connect((folder/'identity.sqlite3').as_uri()+'?mode=ro',uri=True)) as old:
 for table in ('links','prelinks','sessions','link_overrides','link_audit','native_profiles','profile_contacts','entry_intents'):assert not old.execute('SELECT 1 FROM '+table+' WHERE qq=?',('10001',)).fetchall(),table
assert (folder/'erasures.jsonl').read_bytes()==ledger
print(json.dumps(dict(nativeScopes=True,sharedHistoryAndBotUnchanged=True,originalPythonMusicReplay=True,rawJournalUnchanged=True)))`,folder,profileId('10001')],{encoding:'utf8',timeout:10000});
 expect(JSON.parse(output)).toEqual({nativeScopes:true,sharedHistoryAndBotUnchanged:true,originalPythonMusicReplay:true,rawJournalUnchanged:true});
});

it.each(['revived private account','revived event access','later native account'])('repairs an independently pinned mixed restore: %s',async change=>{
 const s=await setup();let target='bob';
 if(change==='later native account'){target='alice';const intent:ErasureIntent={...s.baselineIntent,kind:'account',userId:target,profileId:null,requestId:randomUUID()};s.record('unified',[intent]);const intents=decodeErasureJournal(readRollbackErasureAuthority(s.input.authorityRoot,s.input.manifestSha256).ledgers.unified.toString());changeImage(s.input,db=>{createPrivacy(db,{read:()=>intents,append(){throw Error();}});});}
 changeImage(s.input,db=>{if(change==='revived event access')db.prepare("INSERT INTO event_access(event_id,user_id,created_at) VALUES('listen',?,'old')").run(target);else db.prepare("INSERT INTO external_identities VALUES('qq','revived','revived',?,'private','old')").run(target);});
 const original=Buffer.from(s.input.nativeImage),result=projectNativeForwardErasures(s.input),db=open(result);expect(s.input.nativeImage).toEqual(original);expect(result.report.accountRepair).toMatchObject({allRowsVerified:true});expect(result.report.accountRepair.removedRows).toBeGreaterThan(0);
 for(const table of ['event_access','external_identities'])expect(db.prepare('SELECT 1 FROM '+table+' WHERE user_id=?').get(target)).toBeUndefined();
 expect(db.prepare('SELECT * FROM privacy_requests WHERE user_id=?').get(target)).toEqual(open({nativeImage:original} as ReturnType<typeof projectNativeForwardErasures>).prepare('SELECT * FROM privacy_requests WHERE user_id=?').get(target));
 expect(db.prepare('SELECT * FROM bot_outbox ORDER BY id').all()).toEqual(s.db.prepare('SELECT * FROM bot_outbox ORDER BY id').all());
 const again=projectNativeForwardErasures({...s.input,nativeImage:result.nativeImage,nativeImageSha256:digest(result.nativeImage)});expect(data(open(again))).toEqual(data(db));
});
