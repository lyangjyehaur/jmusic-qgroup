import {beforeAll,afterAll,expect,it} from 'vitest';
import Database from 'better-sqlite3';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import Fastify from 'fastify';
import {assertDatabaseUsable,readMusicRetirements} from '@qgroup/database';
import {legacyResetRecoveryFixture} from '../testsupport/legacy-reset-recovery-fixture';
import {projectForwardResetMemberRetirements,verifyForwardResetMemberRetirements,type ResetMemberRetirementInput,type ResetMemberRetirementBundle} from '../../../tools/migration/forward-reset-member-retirement';
import {forwardHash,forwardRows} from '../../../tools/migration/forward-board-storage';
import {getProfile,saveProfile} from './repositories';
import {musicMatchData,musicNoteAllowed} from './music-match-data';
import {profileFields} from './music-fields';
import {resolveMusicProfileId} from './music-profile-id';
import {adminMusicProfile} from './admin-music';
import {musicErasureScope} from './admin-music-erasure';
import {exportMusic} from './music-export';
import {exportLegacyMusic} from './legacy-music-export';
import {rollbackMusicKeys} from '../../../tools/migration/rollback-music';
import {projectRollbackStateFromCheckpoint} from '../../../tools/migration/rollback-state';
import {verifyRollbackState} from '../../../tools/migration/rollback-state-reconciliation';
import {decodeErasureJournal,type ErasureJournal} from './erasure-journal';
import {createPrivacy} from './privacy';
import {hash,type Security} from './security';
import type {AdminSecurity} from './admin-security';
import {registerMusicShouts} from './music-shouts';
let s:Awaited<ReturnType<typeof legacyResetRecoveryFixture>>,input:ResetMemberRetirementInput,bundle:ResetMemberRetirementBundle,id:string;
beforeAll(async()=>{s=await legacyResetRecoveryFixture(true,false,'persisted-only');input={members:{vault:s.input.vault,music:s.recoveryInput.latestMusic,identity:s.recoveryInput.latestIdentity},checkpoint:s.input.checkpoint,nativeImage:{bytes:s.recoveryInput.erasures.nativeImage,sha256:s.recoveryInput.erasures.nativeImageSha256},nativeJournal:{bytes:s.recoveryInput.erasures.nativeJournal,sha256:s.recoveryInput.erasures.nativeJournalSha256},retiredAt:'2026-11-21T00:10:00.000Z'};id=rollbackMusicKeys(s.native).find(row=>row.legacyKey==='10001')!.profileId;bundle=projectForwardResetMemberRetirements(input);},60000);
afterAll(()=>s?.close());
function output():ResetMemberRetirementBundle{return {...bundle,nativeImage:Buffer.from(bundle.nativeImage),nativeJournal:Buffer.from(bundle.nativeJournal),retainedNativeImage:Buffer.from(bundle.retainedNativeImage),report:structuredClone(bundle.report)};}
it('applies real persisted-only reset removal to native current membership while retaining original fields, selections, history, receipts and bot work',()=>{
  const db=new Database(bundle.nativeImage);try{
    expect(verifyForwardResetMemberRetirements(input,bundle)).toMatchObject({retiredProfiles:1,allOriginalNativeRowsVerified:true,nativeDispositionApplied:true,releaseEligible:false});
    expect(db.prepare('SELECT user_id,erased_at FROM music_profiles WHERE id=?').get(id)).toEqual({user_id:null,erased_at:null});expect(readMusicRetirements(db).map(row=>row.legacyKey)).toEqual(['10001']);
    for(const table of ['music_selections','music_profile_fields','music_profile_contacts','music_legacy_profiles','music_profile_audit','music_contact_history','music_ownership_history','music_pin_history','music_field_history','music_profile_receipts','music_claim_intents','bot_outbox','bot_settings','bot_runtime'])expect([...forwardRows(db,table)]).toEqual([...forwardRows(s.native,table)]);
    expect(db.prepare('SELECT epoch FROM music_account_epochs WHERE user_id=?').get('alice')).toEqual({epoch:1});expect(db.prepare("SELECT 1 FROM music_legacy_erasures WHERE legacy_key='10001'").get()).toBeUndefined();
    expect(()=>assertDatabaseUsable(db)).toThrow('offline review');expect(bundle.retainedNativeImage).toEqual(input.nativeImage.bytes);expect(bundle.nativeJournal).toEqual(input.nativeJournal.bytes);
    expect(readFileSync(join(s.music,'data.json'))).toEqual(input.members.music.bytes);expect(readFileSync(join(s.music,'identity.sqlite3'))).toEqual(input.members.identity.bytes);expect(s.recoveryInput.erasures.nativeImage).toEqual(input.nativeImage.bytes);
  }finally{db.close();}
});
it('excludes the retired profile from active lookup, matching, fields, note visibility, administration and current export while allowing erasure review',()=>{
  const db=new Database(bundle.nativeImage);try{
    expect(getProfile(db,'alice')).toBeNull();expect(musicMatchData(db).members.some(row=>row.id===id)).toBe(false);expect(musicNoteAllowed(db,'alice',id)).toBe(false);
    expect(()=>resolveMusicProfileId(db,'10001')).toThrow();expect(()=>profileFields(db,id)).toThrow();expect(()=>adminMusicProfile(db,id)).toThrow();expect(resolveMusicProfileId(db,'10001',true)).toBe(id);
    expect(adminMusicProfile(db,id,true).owner).toBeNull();expect(musicErasureScope(db,id).profiles).toEqual([{id,userId:null}]);expect(exportMusic(db).members).not.toHaveProperty('10001');
    expect(getProfile(db,'later-native-user')!.id).toBe(s.nativeProfile);
  }finally{db.close();}
});
it('keeps historical member content while removing current ownership, PIN and contact authority from both historical export formats',()=>{
  const db=new Database(bundle.nativeImage);try{
    const historic=exportMusic(s.native,db).members['10001'] as {boardUserId:string;pinHash:string;contactQQ:string;selection:unknown[]};expect(historic.selection.length).toBeGreaterThan(0);expect(historic).toMatchObject({boardUserId:'',pinHash:'',contactQQ:''});
    const original=exportLegacyMusic(s.state.music.data,db,[],new Set()).members as Record<string,unknown>;expect(original['10001']).toMatchObject({qq:'10001',boardUserId:'',pinHash:'',contactQQ:''});expect((original['10001'] as {selection:unknown[]}).selection.length).toBeGreaterThan(0);
  }finally{db.close();}
});
it('rejects an old draft epoch and creates a new independent profile without reactivating the retired ID or stealing its legacy alias',()=>{
  const db=new Database(bundle.nativeImage);try{
    expect(()=>saveProfile(db,'alice',{profileId:null,revision:0,musicEpoch:0,selections:[]},new Date(input.retiredAt))).toThrow();
    const next=saveProfile(db,'alice',{profileId:null,revision:0,musicEpoch:1,selections:[]},new Date(input.retiredAt));expect(next.id).not.toBe(id);expect(getProfile(db,'alice')!.id).toBe(next.id);expect(readMusicRetirements(db)[0]!.profileId).toBe(id);expect(db.prepare('SELECT legacy_key FROM music_legacy_profiles WHERE profile_id=?').get(id)).toEqual({legacy_key:'10001'});
  }finally{db.close();}
});
it('detects a real native selection save to the same original member and preserves both forks instead of silently retiring its new work',()=>{
  const db=new Database(input.nativeImage.bytes);try{const before=getProfile(db,'alice')!;saveProfile(db,'alice',{profileId:before.id,revision:before.revision,musicEpoch:0,selections:[]},new Date(input.retiredAt));const bytes=db.serialize(),supplied={...input,nativeImage:{bytes,sha256:forwardHash(bytes)}};expect(()=>projectForwardResetMemberRetirements(supplied)).toThrow('native writes requiring explicit reconciliation');expect(supplied.nativeImage.bytes).toEqual(bytes);expect(input.nativeImage.bytes).toEqual(bundle.retainedNativeImage);}finally{db.close();}
},60000);
it.each(['fields','selection','history','bot','marker','missing-marker','owner'] as const)('independent complete-row verification rejects a re-pinned %s corruption',kind=>{
  const changed=output(),db=new Database(changed.nativeImage);try{
    if(kind==='fields')db.prepare("UPDATE music_profile_fields SET note='tampered' WHERE profile_id=?").run(id);
    if(kind==='selection')db.prepare('DELETE FROM music_selections WHERE profile_id=?').run(id);
    if(kind==='history')db.exec('DROP TRIGGER music_audit_no_delete;DELETE FROM music_profile_audit');
    if(kind==='bot')expect(db.prepare("UPDATE bot_outbox SET last_error='retirement-tamper'").run().changes).toBeGreaterThan(0);
    if(kind==='marker')db.prepare("UPDATE music_documents SET payload_json=json_set(payload_json,'$.occurrences[0].memberSha256',?) WHERE kind='profile_retirement'").run('a'.repeat(64));
    if(kind==='missing-marker')db.prepare("DELETE FROM music_documents WHERE kind='profile_retirement'").run();
    if(kind==='owner')db.prepare("UPDATE music_profiles SET user_id='alice' WHERE id=?").run(id);
    changed.nativeImage=db.serialize();changed.report.nativeImageSha256=forwardHash(changed.nativeImage);
  }finally{db.close();}
  expect(()=>verifyForwardResetMemberRetirements(input,changed)).toThrow();
});
it('rejects forged activation and detects a late output mutation without granting service startup',()=>{
  const changed=output();Object.assign(changed.report,{releaseEligible:true});expect(()=>verifyForwardResetMemberRetirements(input,changed)).toThrow('report differs');
  const late=output();expect(()=>verifyForwardResetMemberRetirements(input,late,()=>{late.nativeJournal[0]=1;late.report.sourceDigest='a'.repeat(64);})).toThrow('output changed');
});
it('rejects a disposition timestamp preceding the original reset without changing either source',()=>{
  expect(()=>projectForwardResetMemberRetirements({...input,retiredAt:'2020-01-01T00:00:00.000Z'})).toThrow('predates the recorded reset');
  expect(input.nativeImage.bytes).toEqual(bundle.retainedNativeImage);
});
it('assembles a complete rollback with inactive reserved contacts and no old Store resurrection, preserving bot work and the full retired checkpoint',()=>{
  const result=projectRollbackStateFromCheckpoint(bundle.nativeImage,decodeErasureJournal(bundle.nativeJournal.toString())),db=new Database(result.checkpointImage),identity=new Database(result.identityImage),board=new Database(result.boardImage),originalBoard=new Database(s.state.boardImage);
  try{
    expect(result.music.keys.find(row=>row.profileId===id)).toMatchObject({legacyKey:'10001',erased:false,retired:true});expect(result.music.data.members).not.toHaveProperty('10001');expect(result.erasures.musicJournal).toBe('');expect(result.erasures.unifiedJournal).toBe('');
    for(const table of ['prelinks','links','link_overrides','native_profiles'])expect(identity.prepare('SELECT * FROM '+table+' WHERE qq=?').all('10001')).toEqual([]);
    expect(identity.prepare("SELECT qq,number FROM profile_contacts WHERE qq='10001'").get()).toEqual({qq:'10001',number:'10001'});expect(identity.prepare('SELECT * FROM sessions').all()).toEqual([]);expect(identity.prepare('SELECT * FROM entry_intents').all()).toEqual([]);
    const loaded=JSON.parse(execFileSync('python3',['-I','-c',`import base64,json,sys,tempfile
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from music_site.identity_store import Store
from music_site import contacts,admin_links
value=json.loads(sys.stdin.read());data=value['data']
with tempfile.TemporaryDirectory() as root:
 path=Path(root)/'identity.sqlite3';path.write_bytes(base64.b64decode(value['identity']));store=Store(path)
 store.recover_profiles(data);contacts.project(data,store);admin_links.projection(data,store)
 print(json.dumps(data))`,process.cwd()],{input:JSON.stringify({data:result.music.data,identity:result.identityImage.toString('base64')}),encoding:'utf8',timeout:30000}));
    expect(loaded.members).not.toHaveProperty('10001');expect(loaded.members).toEqual(result.music.data.members);
    for(const table of ['music_profile_audit','music_contact_history','music_ownership_history','music_pin_history','music_field_history','music_profile_receipts','music_claim_intents'])expect([...forwardRows(db,table)]).toEqual([...forwardRows(s.native,table)]);
    expect([...forwardRows(board,'bot_outbox')]).toEqual([...forwardRows(originalBoard,'bot_outbox')]);expect(readMusicRetirements(db)[0]!.profileId).toBe(id);
    expect(db.transaction(()=>verifyRollbackState(db,result,result.journal)).immediate()).toEqual(result.report);expect(result.report.rollbackEligible).toBe(false);
    const corrupted={...result,music:structuredClone(result.music)};delete corrupted.music.keys.find(row=>row.profileId===id)!.retired;expect(()=>db.transaction(()=>verifyRollbackState(db,corrupted,result.journal)).immediate()).toThrow();
  }finally{originalBoard.close();board.close();identity.close();db.close();}
},60000);
it('retains historical shouts for review while hiding current retired-author posts and contact authority from member routes',async()=>{
  const db=new Database(bundle.nativeImage),app=Fastify();
  try{
    db.prepare("INSERT INTO music_shouts VALUES('retired-active',?,'10001','retained author','retained active body',?,NULL,1001)").run(id,Date.parse(input.retiredAt)/1000);
    db.prepare("INSERT INTO music_shouts VALUES('retired-history',?,'10001','retained author','retained history body',?, ?,1002)").run(id,Date.parse(input.retiredAt)/1000-100,Date.parse(input.retiredAt)/1000);
    const security={scopedMember:()=>({id:'later-native-user'})} as unknown as Security,admin={authority:()=>({})} as unknown as AdminSecurity;
    registerMusicShouts(app,db,security,admin,()=>new Date(input.retiredAt));await app.ready();
    expect((await app.inject('/api/v2/music/shouts')).json().items.some((row:{id:string})=>row.id==='retired-active')).toBe(false);
    expect((await app.inject('/api/v2/music/shouts/retired-active')).statusCode).toBeGreaterThanOrEqual(400);
    const history=await app.inject('/api/v2/music/shouts/retired-history');expect(history.statusCode).toBe(200);expect(history.json()).toMatchObject({text:'retained history body',author:null,mine:false});expect(history.body).not.toContain('10001');
    expect((await app.inject('/api/v2/admin/shouts/retired-active')).json()).toMatchObject({text:'retained active body',author:null});expect(db.prepare("SELECT body FROM music_shouts WHERE id='retired-active'").get()).toEqual({body:'retained active body'});
  }finally{await app.close();db.close();}
});
it('allows a subsequent real privacy erasure of retained content and preserves its own durable erasure semantics',()=>{
  const db=new Database(bundle.nativeImage),entries=decodeErasureJournal(bundle.nativeJournal.toString()),journal:ErasureJournal={read:()=>structuredClone(entries),append:entry=>{entries.push(structuredClone(entry));}};
  try{
    const scope=musicErasureScope(db,id),privacy=createPrivacy(db,journal),secret='synthetic-retired-delete',entry={version:2 as const,kind:'admin_music' as const,command:'delete_profile' as const,actorRef:'account:alice',profiles:scope.profiles,entries:[],requestId:randomUUID(),secretHash:hash(secret),signature:hash('retired-delete'),createdAt:input.retiredAt};
    db.transaction(()=>privacy.submit(entry)).immediate();privacy.guard();expect(privacy.receipt(entry.requestId,secret)).toMatchObject({status:'completed',profiles:1});
    expect(readMusicRetirements(db)).toEqual([]);expect(db.prepare('SELECT erased_at FROM music_profiles WHERE id=?').get(id)).toEqual({erased_at:input.retiredAt});
    for(const table of ['music_profile_fields','music_profile_contacts','music_selections','music_legacy_profiles','music_profile_audit'])expect(db.prepare('SELECT * FROM '+table+' WHERE profile_id=?').all(id)).toEqual([]);
    const result=projectRollbackStateFromCheckpoint(db.serialize(),journal.read());expect(result.music.keys.find(row=>row.profileId===id)).toMatchObject({erased:true});expect(result.erasures.musicJournal).toContain('10001');
    expect([...forwardRows(db,'bot_outbox')]).toEqual([...forwardRows(s.native,'bot_outbox')]);expect(()=>assertDatabaseUsable(db)).toThrow('offline review');
  }finally{db.close();}
},60000);
