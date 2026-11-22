import Database from 'better-sqlite3';
import {afterEach,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {assertDatabaseUsable,type DB} from '@qgroup/database';
import {forwardSourceRebaseFixture,sourceRebasedAt} from '../testsupport/forward-source-rebase-fixture';
import {proofPin} from '../testsupport/forward-proof-fixture';
import {rebaseForwardSources} from '../../../tools/migration/forward-source-rebase';
import {verifyForwardSourceRebase,verifyForwardSourceRebaseBundle} from '../../../tools/migration/forward-source-rebase-reconciliation';
import {forwardRows,forwardHash} from '../../../tools/migration/forward-board-storage';
import {sourceRebaseDigest,readSourceRebaseEvidence} from '../../../tools/migration/source-rebase-evidence';
import {projectRollbackMusic,rollbackMusicKeys} from '../../../tools/migration/rollback-music';
import {projectRollbackIdentity} from '../../../tools/migration/rollback-identity';
import {projectRollbackState} from '../../../tools/migration/rollback-state';
import {object,profileId,jsonObjectKeys,jsonObjectFromEntries,stringifyJson,parseJson} from '../../../tools/migration/music-codec';
import {erasureJournal,type ErasureJournal} from './erasure-journal';
import {hash} from './security';
import {createPrivacy} from './privacy';
import {saveProfile} from './repositories';
import {createMusicClaims} from './music-claim';
import {musicMatchData} from './music-match-data';
import {exportMusic} from './music-export';

const cleanup:(()=>void)[]=[];afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
async function setup(stage:Parameters<typeof forwardSourceRebaseFixture>[0]='completed'){const s=await forwardSourceRebaseFixture(stage);cleanup.push(()=>s.close());return s;}
const open=(bytes:Buffer)=>{const db=new Database(bytes);cleanup.push(()=>db.close());return db;},rows=(db:DB,table:string)=>[...forwardRows(db,table)];
function project(db:DB,journal:ErasureJournal=erasureJournal(db)){const music=projectRollbackMusic(db,journal),identity=projectRollbackIdentity(db,journal,music);cleanup.push(()=>identity.db.close());return {music,identity};}
function member(s:Awaited<ReturnType<typeof setup>>,key:string){return object(object(s.old.members,'members')[key],'member');}
function oldChanges(s:Awaited<ReturnType<typeof setup>>,key:string,targets:string[]){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'qgroup-source-rebase-old-')));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));writeFileSync(join(root,'identity.sqlite3'),s.oldIdentity.serialize(),{mode:0o600});writeFileSync(join(root,'data.json'),JSON.stringify(s.old),{mode:0o600});
  execFileSync('python3',['-c',`import sys,json
from pathlib import Path
from music_site.identity_store import Store
from music_site import admin_links
root=Path(sys.argv[1]);key=sys.argv[2];data=json.loads((root/'data.json').read_text());store=Store(root/'identity.sqlite3')
for target in json.loads(sys.argv[3]):
 with store.connect() as db:revision=store.admin_state(db,key)['revision']
 admin_links.change(data,store,dict(qq=key,user_id=target,base_revision=revision),'synthetic-admin')
(root/'data.json').write_text(json.dumps(data))`,root,key,JSON.stringify(targets)],{timeout:10000,env:{PATH:process.env.PATH,PYTHONPATH:process.cwd()}});
  const changed=open(readFileSync(join(root,'identity.sqlite3')));s.oldIdentity.exec('DELETE FROM links;DELETE FROM prelinks;DELETE FROM link_overrides;DELETE FROM link_audit');
  for(const table of ['links','prelinks','link_overrides','link_audit']){const columns=(changed.prepare(`PRAGMA table_xinfo(${table})`).all() as {name:string}[]).map(row=>row.name);for(const row of rows(changed,table))s.oldIdentity.prepare(`INSERT INTO ${table}(rowid,${columns.join(',')}) VALUES(${Array(columns.length+1).fill('?').join(',')})`).run(row.__forward_rowid__,...columns.map(column=>row[column]));}
  s.oldIdentity.exec('DELETE FROM sqlite_sequence');for(const row of changed.prepare('SELECT name,seq FROM sqlite_sequence').safeIntegers(true).all() as {name:string;seq:bigint}[])s.oldIdentity.prepare('INSERT INTO sqlite_sequence VALUES(?,?)').run(row.name,row.seq);
  const data=JSON.parse(readFileSync(join(root,'data.json'),'utf8'));for(const name of Object.keys(s.old))s.old[name]=data[name];return root;
}
it('rebases latest sources with original generated bindings and preserves every unrelated native table and sequence',async()=>{
  const s=await setup(),key=s.base.music.keys.find(row=>row.profileId===s.native.id)!;member(s,key.legacyKey).note='舊站更新原生成分';const input=s.rebaseInput(),result=rebaseForwardSources(input),db=open(result.nativeImage),before=open(input.proofImage.bytes);expect(rollbackMusicKeys(db).find(row=>row.profileId===s.native.id)).toEqual(key);expect(project(db).music.keys).toEqual(s.base.music.keys);expect(project(db).music.data.members).toMatchObject({[key.legacyKey]:{note:'舊站更新原生成分'}});
  for(const table of (before.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(row=>row.name))if(!['music_documents','music_legacy_identity','migration_map','migration_runs'].includes(table))expect(rows(db,table),table).toEqual(rows(before,table));expect(result.retainedProofImage).toEqual(input.proofImage.bytes);expect(result.retainedBusinessImage).toEqual(input.proofs.businessImage.bytes);expect(()=>assertDatabaseUsable(db)).toThrow('offline review');expect(result.report).toMatchObject({sourceEvidenceRebased:true,externalRetentionVerified:false,latestErasureReplayRequired:true,releaseEligible:false,rollbackEligible:false,recoveryRequired:true});
});
it('retains literal member and numeric term order through source rebase and repeated rollback projection',async()=>{
  const s=await setup(),members=object(s.old.members,'old members'),order=jsonObjectKeys(members).reverse(),entry=object(object(s.old.entries,'entries').e,'entry');
  s.old.members=jsonObjectFromEntries(order.map(key=>[key,members[key]!]));
  s.old.entries=jsonObjectFromEntries([['20',{id:'20',text:'Twenty',kind:'sub'}],['3',{id:'3',text:'Three',kind:'sub'}],['01',{id:'01',text:'Leading zero',kind:'sub'}],['e',entry]]);
  const input=s.rebaseInput(),result=rebaseForwardSources(input),db=open(result.nativeImage),first=project(db).music,second=project(db).music;
  for(const music of [first,second]){
    expect(jsonObjectKeys(object(music.data.members,'members'))).toEqual(order);
    expect(jsonObjectKeys(object(music.data.entries,'entries'))).toEqual(['20','3','01','e']);
    const readBack=object(parseJson(stringifyJson(music.data)),'serialized projection');
    expect(jsonObjectKeys(object(readBack.members,'members'))).toEqual(order);
    expect(jsonObjectKeys(object(readBack.entries,'entries'))).toEqual(['20','3','01','e']);
    expect(music.keys).toEqual(s.base.music.keys);
  }
  const matching=musicMatchData(db),admin=exportMusic(db);
  expect(matching.members.map(row=>first.keys.find(key=>key.profileId===row.id)!.legacyKey)).toEqual(order);
  expect(matching.entries.map(row=>row.id)).toEqual(['20','3','01','e']);
  expect(jsonObjectKeys(admin.members)).toEqual(order.map(key=>{
    const id=first.keys.find(binding=>binding.legacyKey===key)!.profileId;
    return (db.prepare('SELECT legacy_key FROM music_legacy_profiles WHERE profile_id=?').get(id) as {legacy_key:string}|undefined)?.legacy_key??id;
  }));
  expect(jsonObjectKeys(admin.entries)).toEqual(['20','3','01','e']);
  const proof=open(input.proofImage.bytes),names=(proof.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(row=>row.name);
  for(const table of names)if(!['music_documents','music_legacy_identity','migration_map','migration_runs'].includes(table))expect(rows(db,table),table).toEqual(rows(proof,table));
  db.prepare("UPDATE music_documents SET position=position+100000 WHERE kind='profile_source'").run();
  db.prepare("UPDATE music_documents SET position=CASE position WHEN 100000 THEN 1 WHEN 100001 THEN 0 ELSE position-100000 END WHERE kind='profile_source'").run();
  expect(()=>verifyForwardSourceRebase(input,db.serialize())).toThrow('row inventory differs in music_documents');
});
it('projects a completed native claim repeatedly without duplicating its original audit or changing legacy IDs',async()=>{
  const s=await setup(),input=s.rebaseInput(),result=rebaseForwardSources(input),db=open(result.nativeImage),a=project(db),b=project(db);expect(a.identity.db.serialize()).toEqual(b.identity.db.serialize());expect(rows(a.identity.db,'link_audit')).toEqual(rows(s.oldIdentity,'link_audit'));expect(a.identity.report.auditMappings).toEqual(s.base.identityAuditMappings);expect(a.identity.report.highWater).toBe(s.base.report.identity.highWater);expect(rows(db,'music_claim_intents')).toEqual(rows(open(input.proofImage.bytes),'music_claim_intents'));expect(createMusicClaims(db,()=>new Date(sourceRebasedAt)).status(s.device,s.claimId).status).toBe('completed');
});
it.each([{targets:['']},{targets:['claimant2']},{targets:['','claimant']}])('uses genuine Python old overrides and preserves audit IDs after changes %j',async ({targets})=>{
  const s=await setup(),root=oldChanges(s,'10003',targets),input=s.rebaseInput(),result=rebaseForwardSources(input),db=open(result.nativeImage),p=project(db),owner=targets.at(-1)!;expect(rows(p.identity.db,'link_audit')).toEqual(rows(s.oldIdentity,'link_audit'));expect(p.identity.db.prepare("SELECT user_id FROM link_overrides WHERE qq='10003'").get()).toEqual({user_id:owner});expect(db.prepare('SELECT user_id FROM music_profiles WHERE id=?').get(s.id)).toEqual({user_id:owner||null});expect(p.identity.report.auditMappings).toEqual(s.base.identityAuditMappings);expect(createMusicClaims(db,()=>new Date(sourceRebasedAt)).status(s.device,s.claimId).status).toBe('none');writeFileSync(join(root,'rebased.sqlite3'),result.nativeImage,{mode:0o600});writeFileSync(join(root,'retained.sqlite3'),result.retainedProofImage,{mode:0o600});
});
it('appends only genuine post-rebase ownership changes, retaining frozen mappings and audit high-water',async()=>{
  const s=await setup(),input=s.rebaseInput(),result=rebaseForwardSources(input),db=open(result.nativeImage),before=project(db),stamp='2026-11-20T01:04:00.000Z';
  db.transaction(()=>{db.prepare('UPDATE music_profiles SET user_id=NULL,revision=revision+1 WHERE id=?').run(s.id);db.prepare("INSERT INTO music_ownership_history(profile_id,revision,actor_ref,before_user_id,after_user_id,reason,created_at) SELECT id,revision,'account:claimant',?,NULL,'synthetic-native-detach',? FROM music_profiles WHERE id=?").run('claimant',stamp,s.id);})();
  const first=project(db),second=project(db),high=BigInt(before.identity.report.highWater);expect(rows(first.identity.db,'link_audit')).toEqual(rows(second.identity.db,'link_audit'));expect(first.identity.report.highWater).toBe(String(high+1n));expect(first.identity.report.auditMappings.slice(0,-1)).toEqual(before.identity.report.auditMappings);expect(first.identity.db.prepare('SELECT id,before_user_id,after_user_id FROM link_audit WHERE id=?').safeIntegers(true).get(high+1n)).toEqual({id:high+1n,before_user_id:'claimant',after_user_id:''});expect(first.identity.db.prepare("SELECT user_id FROM link_overrides WHERE qq='10003'").get()).toEqual({user_id:''});
});
it('preserves native history sequence holes and allocates new audits beyond the legacy high-water',async()=>{
  const s=await setup();s.db.prepare("INSERT INTO sqlite_sequence VALUES('music_ownership_history',70)").run();s.db.prepare("UPDATE sqlite_sequence SET seq=90 WHERE name='music_profile_audit'").run();s.oldIdentity.prepare("UPDATE sqlite_sequence SET seq=1000 WHERE name='link_audit'").run();const input=s.rebaseInput(),result=rebaseForwardSources(input),db=open(result.nativeImage);expect(readSourceRebaseEvidence(db)?.histories).toMatchObject({music_ownership_history:{cutoff:'70'},music_profile_audit:{cutoff:'90'}});db.prepare("INSERT INTO music_ownership_history(profile_id,revision,actor_ref,before_user_id,after_user_id,reason,created_at) VALUES(?,9,'account:claimant','claimant','claimant','synthetic-kept','2026-11-20T01:04:00Z')").run(s.id);const p=project(db);expect(p.identity.report.auditMappings.at(-1)).toEqual({source:'ownership',sourceId:'71',legacyId:'1001'});expect(p.identity.report.highWater).toBe('1001');
});
it('retains a genuine native profile save after rebase without freezing source business values',async()=>{
  const s=await setup(),result=rebaseForwardSources(s.rebaseInput()),db=open(result.nativeImage),current=db.prepare('SELECT revision FROM music_profiles WHERE id=?').get(s.native.id) as {revision:number};const saved=saveProfile(db,'fresh-native',{profileId:s.native.id,revision:current.revision,musicEpoch:0,selections:[{entryId:'e',level:4}]},new Date('2026-11-20T01:04:00Z'));const p=project(db),key=s.base.music.keys.find(row=>row.profileId===s.native.id)!;expect(saved.id).toBe(s.native.id);expect(p.music.data.members).toMatchObject({[key.legacyKey]:{selection:[{id:'e',level:4}]}});expect(p.identity.report.auditMappings).toEqual(s.base.identityAuditMappings);
});
it.each(['legacy','generated'])('uses native privacy replay after rebase to erase %s sources and audits without reviving them',async kind=>{
  const s=await setup(),result=rebaseForwardSources(s.rebaseInput()),db=open(result.nativeImage),id=kind==='legacy'?s.id:s.native.id,userId=kind==='legacy'?'claimant':'fresh-native',journal=erasureJournal(db),privacy=createPrivacy(db,journal),requestId=randomUUID();db.transaction(()=>privacy.submit({version:1,kind:'music',userId,profileId:id,requestId,secretHash:'a'.repeat(64),signature:'b'.repeat(64),createdAt:'2026-11-20T01:04:00.000Z'})).immediate();privacy.guard();const p=project(db,journal),key=p.music.keys.find(row=>row.profileId===id)!;expect(key.erased).toBe(true);expect(key.mode).toBe(kind==='legacy'?'preserved':'generated');expect(Object.hasOwn(object(p.music.data.members,'members'),key.legacyKey)).toBe(false);expect(p.identity.db.prepare('SELECT 1 FROM link_audit WHERE qq=?').get(key.legacyKey)).toBeUndefined();expect(db.prepare("SELECT 1 FROM music_documents WHERE kind='profile_source' AND json_extract(payload_json,'$.profileId')=?").get(id)).toBeUndefined();expect(db.prepare("SELECT 1 FROM music_legacy_identity WHERE json_extract(payload_json,'$.qq')=?").get(key.legacyKey)).toBeUndefined();expect(p.identity.report.auditMappings).toEqual(s.base.identityAuditMappings);expect(projectRollbackState(db,journal).identityAuditMappings).toEqual(s.base.identityAuditMappings);expect(project(db,journal).music).toEqual(p.music);
});
it('keeps account closure history while detaching rebased ownership and private authentication',async()=>{
  const s=await setup(),result=rebaseForwardSources(s.rebaseInput()),db=open(result.nativeImage),journal=erasureJournal(db),privacy=createPrivacy(db,journal);db.transaction(()=>privacy.submit({version:1,kind:'account',userId:'claimant',profileId:s.id,requestId:randomUUID(),secretHash:'a'.repeat(64),signature:'b'.repeat(64),createdAt:'2026-11-20T01:04:00.000Z'})).immediate();privacy.guard();const p=project(db,journal);expect(p.music.data.members).toMatchObject({'10003':{boardUserId:''}});expect(p.identity.db.prepare("SELECT 1 FROM links WHERE qq='10003'").get()).toBeUndefined();expect(p.identity.db.prepare("SELECT 1 FROM prelinks WHERE qq='10003'").get()).toBeUndefined();expect(p.identity.report.auditMappings).toEqual(s.base.identityAuditMappings);expect(rows(p.identity.db,'link_audit')).toEqual(rows(s.oldIdentity,'link_audit'));expect(rows(db,'browser_sessions').some(row=>row.user_id==='claimant')).toBe(false);
});
it('assembles and independently reconciles the complete rollback state from a rebased checkpoint',async()=>{
  const s=await setup(),result=rebaseForwardSources(s.rebaseInput()),db=open(result.nativeImage),state=projectRollbackState(db,erasureJournal(db));expect(state.identityAuditMappings).toEqual(s.base.identityAuditMappings);const projected=project(db).music;expect(state.music).toEqual({data:projected.data,keys:projected.keys});expect(state.report.rollbackEligible).toBe(false);expect(rows(open(state.checkpointImage),'music_documents')).toEqual(rows(db,'music_documents'));
});
it('retains inactive old proof rows privately without enabling them in either runtime or rollback projection',async()=>{
  const s=await setup();s.oldIdentity.prepare("INSERT INTO sessions VALUES('old-synthetic-token','10003',9999999999,'old-device',0)").run();s.oldIdentity.prepare("INSERT INTO entry_intents VALUES('old-synthetic-intent','10003','old-device','claimant','{}',9999999999)").run();const input=s.rebaseInput(),result=rebaseForwardSources(input),db=open(result.nativeImage),p=project(db);expect(db.prepare("SELECT count(*) n FROM music_legacy_identity WHERE table_name IN ('sessions','entry_intents')").get()).toEqual({n:2});expect(rows(p.identity.db,'sessions')).toEqual([]);expect(rows(p.identity.db,'entry_intents')).toEqual([]);expect(rows(db,'browser_sessions')).toEqual(rows(open(input.proofImage.bytes),'browser_sessions'));expect(result.identitySources).toEqual(input.proofs.identitySources.bytes);
});
it('rejects an old creation-time edit conflicting with original native creation provenance without losing input',async()=>{
  const s=await setup(),key=s.base.music.keys.find(row=>row.profileId===s.native.id)!;member(s,key.legacyKey).createdAt=123;const input=s.rebaseInput(),before=Buffer.from(input.proofImage.bytes);expect(()=>rebaseForwardSources(input)).toThrow('original native creation time');expect(input.proofImage.bytes).toEqual(before);
});
it.each(['nativeJournal','retainedProofImage','retainedBusinessImage','musicSources','identitySources'] as const)('requires exact retained %s bytes in the parent bundle',async key=>{
  const s=await setup(),input=s.rebaseInput(),result=rebaseForwardSources(input);expect(verifyForwardSourceRebaseBundle(input,result)).toMatchObject({retainedOriginalImagesVerified:true,pairedSourceBytesVerified:true});const altered=Buffer.from(result[key].length?result[key]:Buffer.from([0]));altered[0]=altered[0]!^1;expect(()=>verifyForwardSourceRebaseBundle(input,{...result,[key]:altered})).toThrow('rebase reconciliation');
});
it.each(['generated-mode','cutoff','audit-mapping','identity-row','profile-document','map','native-history','sequence','receipt','bot-work','run','recovery','metadata','extra-document'] as const)('rejects independently verified candidate %s tampering',async kind=>{
  const s=await setup(),input=s.rebaseInput(),result=rebaseForwardSources(input),db=open(result.nativeImage);
  if(['generated-mode','cutoff','audit-mapping'].includes(kind)){const doc=db.prepare("SELECT payload_json FROM music_documents WHERE kind='source_rebase'").get() as {payload_json:string},evidence=JSON.parse(doc.payload_json);if(kind==='generated-mode')evidence.bindings.find((row:{mode:string})=>row.mode==='generated').mode='preserved';if(kind==='cutoff')evidence.histories.music_profile_audit.cutoff='999';if(kind==='audit-mapping')evidence.auditMappings[0].legacyId='999';db.prepare("UPDATE music_documents SET payload_json=? WHERE kind='source_rebase'").run(JSON.stringify(evidence));}
  if(kind==='identity-row')db.prepare("UPDATE music_legacy_identity SET payload_json=json_set(payload_json,'$.actor','forged') WHERE table_name='link_audit'").run();
  if(kind==='profile-document')db.prepare("UPDATE music_documents SET payload_json=json_set(payload_json,'$.profileId',?) WHERE kind='profile_source' AND json_extract(payload_json,'$.legacyKey')=?").run(profileId('10003'),s.base.music.keys.find(row=>row.profileId===s.native.id)!.legacyKey);
  if(kind==='map')db.prepare("UPDATE migration_map SET source_revision='forged' WHERE source='music-identity'").run();
  if(kind==='native-history'){const sql=(db.prepare("SELECT sql FROM sqlite_master WHERE name='music_audit_no_update'").get() as {sql:string}).sql;db.exec('DROP TRIGGER music_audit_no_update');db.prepare("UPDATE music_profile_audit SET after_json='{}'").run();db.exec(sql);}
  if(kind==='sequence')db.prepare("UPDATE sqlite_sequence SET seq=999 WHERE name='music_profile_audit'").run();
  if(kind==='receipt')db.prepare("UPDATE request_results SET response_status=201").run();
  if(kind==='bot-work')db.prepare("INSERT INTO bot_settings_history VALUES(999,'{}','forged','','forged')").run();
  if(kind==='run')db.prepare("UPDATE migration_runs SET report_json='{}' WHERE source_digest=?").run(result.report.sourceDigest);
  if(kind==='recovery'){const sql=(db.prepare("SELECT sql FROM sqlite_master WHERE name='rebuild_storage_no_update'").get() as {sql:string}).sql;db.exec('DROP TRIGGER rebuild_storage_no_update');db.prepare('UPDATE rebuild_storage SET recovery_required=0').run();db.exec(sql);}
  if(kind==='metadata')db.pragma('application_id=999');if(kind==='extra-document')db.prepare("INSERT INTO music_documents VALUES('source_rebase',1,'{}')").run();expect(()=>verifyForwardSourceRebase(input,db.serialize())).toThrow();
});
it.each(['unrecognized-old-row','changed-legacy-audit','missing-history','rewound-high-water'] as const)('local rollback readers reject %s after source rebase',async kind=>{
  const s=await setup(),result=rebaseForwardSources(s.rebaseInput()),db=open(result.nativeImage);
  if(kind==='unrecognized-old-row')db.prepare("INSERT INTO music_profile_audit(id,profile_id,actor_id,revision,before_json,after_json,created_at) VALUES(0,?,'claimant',99,'null','{}','2026-11-20T01:04:00Z')").run(s.id);
  if(kind==='changed-legacy-audit')db.prepare("UPDATE music_legacy_identity SET payload_json=json_set(payload_json,'$.after_user_id','claimant2') WHERE table_name='link_audit'").run();
  if(kind==='missing-history'){const sql=(db.prepare("SELECT sql FROM sqlite_master WHERE name='music_audit_no_delete'").get() as {sql:string}).sql;db.exec('DROP TRIGGER music_audit_no_delete');db.prepare('DELETE FROM music_profile_audit WHERE profile_id=?').run(s.id);db.exec(sql);}
  if(kind==='rewound-high-water')db.prepare("UPDATE sqlite_sequence SET seq=0 WHERE name='music_profile_audit'").run();expect(()=>project(db)).toThrow('Source rebase');
});
it('rejects source mutation, operation time changes, asynchronous and late boundaries without candidate output',async()=>{
  const s=await setup(),input=s.rebaseInput();expect(()=>rebaseForwardSources({...input,proofImage:{...input.proofImage,sha256:'0'.repeat(64)}})).toThrow('pin differs');expect(()=>rebaseForwardSources({...input,proofImage:proofPin(input.proofs.businessImage.bytes)})).toThrow('proof reconciliation');expect(()=>rebaseForwardSources({...input,rebasedAt:input.proofs.reconstructedAt})).toThrow('predates');expect(()=>rebaseForwardSources(input,(()=>Promise.resolve()) as unknown as ()=>void)).toThrow('synchronous');let calls=0;expect(()=>rebaseForwardSources(input,()=>{if(++calls===2)input.rebasedAt='2026-11-20T01:05:00.000Z';})).toThrow('input changed');expect(calls).toBe(2);
});
it('reconstructs fixed inputs deterministically and binds source evidence to its unique run',async()=>{
  const s=await setup(),input=s.rebaseInput(),a=rebaseForwardSources(input),b=rebaseForwardSources(input),db=open(a.nativeImage),evidence=readSourceRebaseEvidence(db)!;expect(a.nativeImage).toEqual(b.nativeImage);expect(a.report).toEqual(b.report);expect(sourceRebaseDigest(evidence)).toBe(a.report.sourceDigest);expect(forwardHash(JSON.stringify(evidence))).toBe(JSON.parse((db.prepare('SELECT manifest_json FROM migration_runs WHERE source_digest=?').get(a.report.sourceDigest) as {manifest_json:string}).manifest_json).evidenceSha256);expect(Object.keys(evidence.sourcePins)).toHaveLength(14);
});
it('projects a genuine completed native claim created after rebase with only one new mapped audit',async()=>{
  const s=await setup('none'),result=rebaseForwardSources(s.rebaseInput()),db=open(result.nativeImage),time='2026-11-20T01:04:00.000Z',claims=createMusicClaims(db,()=>new Date(time)),requestId=randomUUID(),attempt='synthetic-post-rebase-attempt';
  claims.start(s.device,{requestId,legacyQQ:'10003',pin:'123456',consent:true});db.prepare("INSERT INTO login_attempts(id,token_hash,user_id,provider,app_id,mode,status,expires_at,created_at,openid) VALUES(?,?,'claimant','qq','synthetic-app','bind','used','2026-11-20T01:10:00.000Z',?,'synthetic-subject')").run(attempt,s.device.tokenHash,time);db.prepare("INSERT INTO external_identities VALUES('qq','synthetic-app','synthetic-subject','claimant','合成授權',?)").run(time);claims.attach(s.device,requestId,attempt,'bind');const row=db.prepare('SELECT * FROM music_claim_intents WHERE id=?').get(requestId) as Parameters<typeof claims.authorize>[0];claims.authorize(row,s.device.tokenHash,'claimant','synthetic-app','synthetic-subject');db.transaction(()=>claims.finish(s.device,requestId)).immediate();const p=project(db),again=project(db);expect(p.identity.report.auditMappings).toHaveLength(1);expect(p.identity.report.auditMappings[0]?.source).toBe('claim');expect(p.identity.report.highWater).toBe('1');expect(p.identity.db.prepare("SELECT openid,user_id FROM links WHERE qq='10003'").get()).toEqual({openid:'synthetic-subject',user_id:'claimant'});expect(rows(p.identity.db,'link_audit')).toEqual(rows(again.identity.db,'link_audit'));
});
it('allows a genuinely new native profile after source rebase and preserves its generated binding on export',async()=>{
  const s=await setup(),result=rebaseForwardSources(s.rebaseInput()),db=open(result.nativeImage);db.prepare("INSERT INTO users VALUES('later-native',?,'合成後續成分','2026-11-20T01:04:00Z')").run(hash('synthetic-later-native'));const created=saveProfile(db,'later-native',{profileId:null,revision:0,musicEpoch:0,selections:[{entryId:'e',level:3}]},new Date('2026-11-20T01:04:00Z')),p=project(db),mapping=p.music.keys.find(row=>row.profileId===created.id)!;expect(mapping.mode).toBe('generated');expect(p.identity.db.prepare('SELECT user_id FROM prelinks WHERE qq=?').get(mapping.legacyKey)).toEqual({user_id:'later-native'});expect(p.identity.report.auditMappings).toEqual(s.base.identityAuditMappings);
});
it('checks source replacement and retained original images using an independent readonly Python oracle',async()=>{
  const s=await setup(),root=oldChanges(s,'10003',['','claimant2']),input=s.rebaseInput(),result=rebaseForwardSources(input),db=open(result.nativeImage),p=project(db),key=s.base.music.keys.find(row=>row.profileId===s.native.id)!;for(const [name,bytes] of [['proof',input.proofImage.bytes],['rebased',result.nativeImage],['retained',result.retainedProofImage],['projected-identity',p.identity.db.serialize()]] as const)writeFileSync(join(root,name+'.sqlite3'),bytes,{mode:0o600});writeFileSync(join(root,'projected-music.json'),JSON.stringify(p.music.data),{mode:0o600});
  const oracle=JSON.parse(execFileSync('python3',['-c',`import json,sqlite3,sys
from pathlib import Path
from contextlib import ExitStack,closing
root=Path(sys.argv[1]);key=sys.argv[2];changed={'music_documents','music_legacy_identity','migration_map','migration_runs'}
with ExitStack() as stack:
 dbs={name:stack.enter_context(closing(sqlite3.connect((root/(name+'.sqlite3')).as_uri()+'?mode=ro',uri=True))) for name in ('proof','rebased','retained','projected-identity')}
 def rows(db,table):
  columns=[r[1] for r in db.execute('PRAGMA table_xinfo("'+table+'")')]
  return list(db.execute('SELECT rowid,*,'+','.join('typeof("'+name+'")' for name in columns)+' FROM "'+table+'" ORDER BY rowid'))
 tables=[r[0] for r in dbs['proof'].execute("SELECT name FROM sqlite_master WHERE type='table'")]
 for table in tables:
  assert rows(dbs['proof'],table)==rows(dbs['retained'],table),table
  if table not in changed:assert rows(dbs['proof'],table)==rows(dbs['rebased'],table),table
 assert dbs['rebased'].execute('PRAGMA integrity_check').fetchone()==('ok',) and not dbs['rebased'].execute('PRAGMA foreign_key_check').fetchall()
 proof=json.loads(dbs['rebased'].execute("SELECT payload_json FROM music_documents WHERE kind='source_rebase'").fetchone()[0]);assert next(r for r in proof['bindings'] if r['legacyKey']==key)['mode']=='generated'
 before=dbs['proof'].execute('SELECT profile_id,created_at FROM music_profile_creation').fetchall();assert before==dbs['rebased'].execute('SELECT profile_id,created_at FROM music_profile_creation').fetchall()
 assert dbs['projected-identity'].execute("SELECT user_id FROM prelinks WHERE qq='10003'").fetchone()==('claimant2',)
 assert dbs['projected-identity'].execute('SELECT count(*) FROM sessions').fetchone()==(0,) and dbs['projected-identity'].execute('SELECT count(*) FROM entry_intents').fetchone()==(0,)
 expected=json.loads((root/'projected-music.json').read_text());assert expected['members']['10003']['boardUserId']=='claimant2' and key in expected['members']
 original=stack.enter_context(closing(sqlite3.connect((root/'identity.sqlite3').as_uri()+'?mode=ro',uri=True)));assert rows(original,'link_audit')==rows(dbs['projected-identity'],'link_audit')
 print(json.dumps(dict(tables=len(tables),allUnrelatedExact=True,retainedImageExact=True,generatedModePreserved=True,originalAuditExact=True,oldProofsInactive=True)))`,root,key.legacyKey],{encoding:'utf8',timeout:10000}));expect(oracle).toMatchObject({allUnrelatedExact:true,retainedImageExact:true,generatedModePreserved:true,originalAuditExact:true,oldProofsInactive:true});expect(oracle.tables).toBeGreaterThan(90);
});
it.each(['music_documents','music_legacy_identity','migration_map'] as const)('rejects source rebase %s rowid exhaustion while retaining original bytes',async table=>{
  const s=await setup();
  if(table==='music_documents')s.db.prepare("UPDATE music_documents SET rowid=? WHERE kind='settings'").run(9223372036854775807n);
  if(table==='music_legacy_identity')s.db.prepare("UPDATE music_legacy_identity SET rowid=? WHERE table_name='prelinks' AND row_number=0").run(9223372036854775807n);
  if(table==='migration_map')s.db.prepare("UPDATE migration_map SET rowid=? WHERE source='music' AND entity_type='entry'").run(9223372036854775807n);
  const input=s.rebaseInput(),before=Buffer.from(input.proofImage.bytes);expect(()=>rebaseForwardSources(input)).toThrow('rowid capacity exhausted');expect(input.proofImage.bytes).toEqual(before);
});
it('rebases latest private settings and source creators without exposing the credential in rollback music',async()=>{
  const s=await setup();s.old.settings={adminPasswordHash:'SYNTHETIC-LATEST-PRIVATE-HASH'};const input=s.rebaseInput(),result=rebaseForwardSources(input),db=open(result.nativeImage),p=project(db);expect(JSON.parse((db.prepare("SELECT payload_json FROM music_documents WHERE kind='settings'").get() as {payload_json:string}).payload_json)).toEqual(s.old.settings);expect(p.music.data.settings).toEqual({});expect(JSON.parse((db.prepare("SELECT payload_json FROM music_documents WHERE kind='entry_source'").get() as {payload_json:string}).payload_json).entry.createdBy).toBe('10002');expect(result.musicSources).toEqual(input.proofs.musicSources.bytes);
});
