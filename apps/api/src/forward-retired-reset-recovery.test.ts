import {afterAll,beforeAll,expect,it} from 'vitest';
import Database from 'better-sqlite3';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {assertDatabaseUsable,readMusicRetirements} from '@qgroup/database';
import {legacyResetRecoveryFixture} from '../testsupport/legacy-reset-recovery-fixture';
import {reconstructForwardRetiredResetRecovery,verifyForwardRetiredResetRecovery,type RetiredResetRecoveryBundle} from '../../../tools/migration/forward-retired-reset-recovery';
import {forwardHash,forwardRows} from '../../../tools/migration/forward-board-storage';
import {projectRollbackStateFromCheckpoint} from '../../../tools/migration/rollback-state';
import {decodeErasureJournal} from './erasure-journal';
import {getProfile} from './repositories';
import {profileId} from '../../../tools/migration/music-codec';
import {openForwardMusicSources} from '../../../tools/migration/forward-music-sources';
import {saveProfile} from './repositories';

let s:Awaited<ReturnType<typeof legacyResetRecoveryFixture>>,bundle:RetiredResetRecoveryBundle;
beforeAll(async()=>{s=await legacyResetRecoveryFixture(true,false,'persisted-only');bundle=reconstructForwardRetiredResetRecovery(s.recoveryInput);},60000);
afterAll(()=>s?.close());
function copy<T>(value:T):T{
  if(Buffer.isBuffer(value))return Buffer.from(value) as T;
  if(Array.isArray(value))return value.map(copy) as T;
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,copy(item)])) as T;
  return value;
}
function changedImage(bytes:Buffer,change:(db:Database.Database)=>void){const db=new Database(bytes);try{change(db);return db.serialize();}finally{db.close();}}
const pin=(bytes:Buffer)=>({bytes:Buffer.from(bytes),sha256:forwardHash(bytes)});

it('reconciles the actual persisted-only removal through global reset, business, proof and source rebase, retaining both later branches and all bot rows',()=>{
  const db=new Database(bundle.rebased.nativeImage),retired=new Database(bundle.retirement.native.nativeImage);
  try{
    expect(verifyForwardRetiredResetRecovery(s.recoveryInput,bundle)).toMatchObject({allCandidateRowsVerified:true,retiredBaselineAndNativeVerified:true,releaseEligible:false});
    expect(readMusicRetirements(db).map(row=>row.legacyKey)).toEqual(['10001']);
    expect(db.prepare('SELECT user_id,erased_at FROM music_profiles WHERE id=?').get(profileId('10001'))).toEqual({user_id:null,erased_at:null});expect(getProfile(db,'alice')).toBeNull();
    expect(getProfile(db,'later-native-user')).toEqual(getProfile(s.native,'later-native-user'));
    const oldEntry=bundle.generation.mapping.entries.find(row=>row.originalKey==='e')!.derivedId;
    expect(db.prepare('SELECT name FROM music_entries WHERE id=?').get(oldEntry)).toEqual({name:'later old catalog'});expect(db.prepare("SELECT name FROM music_entries WHERE id='native-added-entry'").get()).toEqual({name:'later native catalog'});
    expect(db.prepare('SELECT level,entry_id FROM music_selections WHERE profile_id=?').all(profileId('38888'))).toEqual([{level:4,entry_id:oldEntry}]);
    for(const table of ['bot_outbox','bot_settings','bot_settings_history','bot_runtime','privacy_receipts','event_audit','finance_entries','settlement_history'])expect([...forwardRows(db,table)],table).toEqual([...forwardRows(s.native,table)]);
    for(const table of ['music_profile_fields','music_field_history','music_pin_history','music_contact_history','music_profile_audit','music_ownership_history'])expect([...forwardRows(db,table)].filter(row=>row.profile_id===profileId('10001')),table).toEqual([...forwardRows(retired,table)].filter(row=>row.profile_id===profileId('10001')));
    const source=(image:Database.Database)=>image.prepare("SELECT rowid,position,payload_json FROM music_documents WHERE kind='profile_source' AND json_extract(payload_json,'$.profileId')=?").all(profileId('10001'));
    expect(source(db)).toEqual(source(retired));expect(db.prepare("SELECT * FROM migration_map WHERE source='music' AND entity_type='profile' AND target_id=?").all(profileId('10001'))).toEqual(retired.prepare("SELECT * FROM migration_map WHERE source='music' AND entity_type='profile' AND target_id=?").all(profileId('10001')));
    expect(bundle.business.musicSources.data.members).not.toHaveProperty('10001');
    expect(bundle.retirement.native.retainedNativeImage).toEqual(s.recoveryInput.erasures.nativeImage);expect(bundle.retirement.baseline.retainedNativeImage).toEqual(s.recoveryInput.erasures.checkpoint);
    expect(readFileSync(join(s.music,'data.json'))).toEqual(s.latest);expect(readFileSync(join(s.music,'identity.sqlite3'))).toEqual(s.recoveryInput.latestIdentity.bytes);
    expect(bundle.report).toMatchObject({retiredResetRecoveryCandidatePrepared:true,allResetGenerationsReconciled:false,releaseEligible:false});expect(()=>assertDatabaseUsable(db)).toThrow('offline review');
  }finally{retired.close();db.close();}
},60000);
it('keeps retired keys and contact reservations out of rollback active members and authentication without inventing erasure scope',()=>{
  const rollback=projectRollbackStateFromCheckpoint(bundle.rebased.nativeImage,decodeErasureJournal(bundle.rebased.nativeJournal.toString())),identity=new Database(rollback.identityImage);
  try{
    expect(rollback.music.keys.find(row=>row.legacyKey==='10001')).toMatchObject({retired:true,erased:false});expect(rollback.music.data.members).not.toHaveProperty('10001');
    for(const table of ['sessions','entry_intents','prelinks','links','link_overrides','native_profiles'])expect(identity.prepare('SELECT * FROM '+table+' WHERE qq=?').all('10001')).toEqual([]);
    expect(identity.prepare("SELECT qq,number FROM profile_contacts WHERE qq='10001'").get()).toEqual({qq:'10001',number:'10001'});
    expect(rollback.erasures.musicJournal.split('\n').filter(Boolean).map(row=>JSON.parse(row).qq)).not.toContain('10001');expect(bundle.rebased.nativeJournal.toString()).not.toContain('10001');
  }finally{identity.close();}
});
it.each(['baseline-marker','retired-source','retired-owner','bot-work','old-revival','identity-revival','generation','retained-image','activation-report'] as const)('rejects independently re-pinned %s corruption',kind=>{
  const value=copy(bundle);
  if(kind==='baseline-marker')value.sources.checkpoint=pin(changedImage(value.sources.checkpoint.bytes,db=>{db.prepare("DELETE FROM music_documents WHERE kind='profile_retirement'").run();}));
  if(kind==='retired-source')value.rebased.nativeImage=changedImage(value.rebased.nativeImage,db=>{db.prepare("UPDATE music_documents SET payload_json=json_set(payload_json,'$.member.name','forged') WHERE kind='profile_source' AND json_extract(payload_json,'$.profileId')=?").run(profileId('10001'));});
  if(kind==='retired-owner')value.business.nativeImage=changedImage(value.business.nativeImage,db=>{db.prepare('UPDATE music_profiles SET user_id=? WHERE id=?').run('alice',profileId('10001'));});
  if(kind==='bot-work')value.proof.nativeImage=changedImage(value.proof.nativeImage,db=>{db.prepare("UPDATE bot_outbox SET last_error='forged'").run();});
  if(kind==='old-revival'){const data=JSON.parse(value.sources.oldMusic.bytes.toString());data.members['10001']={qq:'10001',name:'revived',selection:[]};value.sources.oldMusic=pin(Buffer.from(JSON.stringify(data)));}
  if(kind==='identity-revival')value.retirement.identity=pin(changedImage(value.retirement.identity.bytes,db=>{db.prepare("INSERT INTO prelinks VALUES('10001','alice',1)").run();}));
  if(kind==='generation'){const data=JSON.parse(value.generation.derivedMusic.bytes.toString());data.members['38888'].name='forged';value.generation.derivedMusic=pin(Buffer.from(JSON.stringify(data)));}
  if(kind==='retained-image')value.retirement.native.retainedNativeImage[0]=value.retirement.native.retainedNativeImage[0]!^1;
  if(kind==='activation-report')Object.assign(value.report,{releaseEligible:true});
  value.report.finalNativeImageSha256=forwardHash(value.rebased.nativeImage);
  expect(()=>verifyForwardRetiredResetRecovery(s.recoveryInput,value)).toThrow();
},60000);
it('fences late original and final output changes and rejects asynchronous boundaries',()=>{
  const value=copy(bundle);let count=0;verifyForwardRetiredResetRecovery(s.recoveryInput,bundle,()=>count++);let calls=0;
  expect(()=>verifyForwardRetiredResetRecovery(s.recoveryInput,value,()=>{if(++calls===count)value.rebased.nativeImage[0]=value.rebased.nativeImage[0]!^1;})).toThrow('output bundle changed');expect(calls).toBe(count);
  const input=copy(s.recoveryInput);expect(()=>reconstructForwardRetiredResetRecovery(input,()=>{input.latestMusic.bytes[0]=input.latestMusic.bytes[0]!^1;})).toThrow('source changed');
  const asyncBoundary=(()=>Promise.resolve()) as unknown as ()=>void;expect(()=>verifyForwardRetiredResetRecovery(s.recoveryInput,bundle,asyncBoundary)).toThrow('synchronous');
},60000);
it('runs the original Python Store recovery on the final rollback without resurrecting the retired member',()=>{
  const rollback=projectRollbackStateFromCheckpoint(bundle.rebased.nativeImage,decodeErasureJournal(bundle.rebased.nativeJournal.toString()));
  const loaded=JSON.parse(execFileSync('python3',['-I','-c',`import base64,json,sys,tempfile
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from music_site.identity_store import Store
from music_site import contacts,admin_links
value=json.loads(sys.stdin.read());data=value['data']
with tempfile.TemporaryDirectory() as root:
 path=Path(root)/'identity.sqlite3';path.write_bytes(base64.b64decode(value['identity']));store=Store(path)
 store.recover_profiles(data);contacts.project(data,store);admin_links.projection(data,store)
 print(json.dumps(data))`,process.cwd()],{input:JSON.stringify({data:rollback.music.data,identity:rollback.identityImage.toString('base64')}),encoding:'utf8',timeout:30000,stdio:['pipe','pipe','pipe']}));
  expect(loaded.members).not.toHaveProperty('10001');expect(loaded.members).toEqual(rollback.music.data.members);
});
it('rejects removal of the original retirement marker from a native source even after re-pinning it',()=>{
  const input=copy(bundle.sources);input.nativeImage=pin(changedImage(input.nativeImage.bytes,db=>{db.prepare("DELETE FROM music_documents WHERE kind='profile_retirement'").run();db.prepare("DELETE FROM migration_runs WHERE json_extract(manifest_json,'$.kind')='forward_reset_member_retirement'").run();}));
  expect(()=>openForwardMusicSources(input)).toThrow(/retirement|detachment provenance/);
});
it('reconstructs a retirement with no later native fork and remains repeatable on identical original inputs',async()=>{
  const fixture=await legacyResetRecoveryFixture(false,false,'persisted-only');
  try{
    const result=reconstructForwardRetiredResetRecovery(fixture.recoveryInput),again=reconstructForwardRetiredResetRecovery(fixture.recoveryInput),db=new Database(result.rebased.nativeImage);
    try{expect(again).toEqual(result);expect(verifyForwardRetiredResetRecovery(fixture.recoveryInput,result).allCandidateRowsVerified).toBe(true);expect(readMusicRetirements(db).map(row=>row.legacyKey)).toEqual(['10001']);expect(getProfile(db,'alice')).toBeNull();}finally{db.close();}
  }finally{fixture.close();}
},120000);
it('rejects real native member writes before global reset can obscure the conflict, retaining both original inputs',()=>{
  const input=copy(s.recoveryInput),db=new Database(input.erasures.nativeImage);
  try{
    const p=getProfile(db,'alice')!;saveProfile(db,'alice',{profileId:p.id,revision:p.revision,musicEpoch:0,selections:[]},new Date(input.reconstructedAt));input.erasures.nativeImage=db.serialize();input.erasures.nativeImageSha256=forwardHash(input.erasures.nativeImage);const original=Buffer.from(input.erasures.nativeImage);
    expect(()=>reconstructForwardRetiredResetRecovery(input)).toThrow('native writes requiring explicit reconciliation');expect(input.erasures.nativeImage).toEqual(original);expect(s.recoveryInput.erasures.nativeImage).toEqual(bundle.retirement.native.retainedNativeImage);
  }finally{db.close();}
},60000);
