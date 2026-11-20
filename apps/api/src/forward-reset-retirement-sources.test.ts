import {beforeAll,afterAll,expect,it} from 'vitest';
import Database from 'better-sqlite3';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {readMusicRetirements,assertDatabaseUsable} from '@qgroup/database';
import {legacyResetRecoveryFixture} from '../testsupport/legacy-reset-recovery-fixture';
import {prepareForwardResetRetirementSources,verifyForwardResetRetirementSources,type ResetRetirementSourcesBundle} from '../../../tools/migration/forward-reset-retirement-sources';
import type {ResetMemberRetirementInput} from '../../../tools/migration/forward-reset-member-retirement';
import {forwardHash,forwardRows} from '../../../tools/migration/forward-board-storage';
import {getProfile,saveProfile} from './repositories';
let s:Awaited<ReturnType<typeof legacyResetRecoveryFixture>>,input:ResetMemberRetirementInput,bundle:ResetRetirementSourcesBundle;
beforeAll(async()=>{s=await legacyResetRecoveryFixture(true,false,'persisted-only');input={members:{vault:s.input.vault,music:s.recoveryInput.latestMusic,identity:s.recoveryInput.latestIdentity},checkpoint:s.input.checkpoint,nativeImage:{bytes:s.recoveryInput.erasures.nativeImage,sha256:s.recoveryInput.erasures.nativeImageSha256},nativeJournal:{bytes:s.recoveryInput.erasures.nativeJournal,sha256:s.recoveryInput.erasures.nativeJournalSha256},retiredAt:s.recoveryInput.reconstructedAt};bundle=prepareForwardResetRetirementSources(input);},60000);
afterAll(()=>s?.close());
function changed():ResetRetirementSourcesBundle{return {...bundle,identity:{bytes:Buffer.from(bundle.identity.bytes),sha256:bundle.identity.sha256},baselineJournal:{bytes:Buffer.from(bundle.baselineJournal.bytes),sha256:bundle.baselineJournal.sha256},report:structuredClone(bundle.report)};}
it('prepares the actual original journal and independent retired baseline/native fork, preserving the original identity and native additions',()=>{
  const baseline=new Database(bundle.baseline.nativeImage),native=new Database(bundle.native.nativeImage),original=new Database(input.members.identity.bytes),derived=new Database(bundle.identity.bytes);
  try{
    expect(verifyForwardResetRetirementSources(input,bundle)).toMatchObject({allOriginalIdentityRowsVerified:true,baselineAndNativeCheckedSeparately:true,releaseEligible:false});
    expect(getProfile(baseline,'later-native-user')).toBeNull();expect(getProfile(native,'later-native-user')!.id).toBe(s.nativeProfile);expect(readMusicRetirements(native).map(row=>row.legacyKey)).toEqual(['10001']);expect(readMusicRetirements(baseline).map(row=>row.legacyKey)).toEqual(['10001']);
    for(const table of ['sessions','entry_intents','prelinks','links','link_overrides','native_profiles'])expect(derived.prepare('SELECT * FROM '+table+' WHERE qq=?').all('10001')).toEqual([]);
    expect(derived.prepare("SELECT qq,number FROM profile_contacts WHERE qq='10001'").get()).toEqual({qq:'10001',number:'10001'});
    for(const table of ['link_audit','used_oauth','login_attempts'])expect([...forwardRows(derived,table)]).toEqual([...forwardRows(original,table)]);
    expect(bundle.native.retainedNativeImage).toEqual(input.nativeImage.bytes);expect(bundle.baseline.retainedNativeImage).toEqual(input.checkpoint.bytes);expect(bundle.baselineJournal.bytes).toEqual(readFileSync(join(input.members.vault.authorityRoot,'baseline/unified.erasures.jsonl')));
    expect(readFileSync(join(s.music,'identity.sqlite3'))).toEqual(input.members.identity.bytes);expect(()=>assertDatabaseUsable(native)).toThrow('offline review');expect(()=>assertDatabaseUsable(baseline)).toThrow('offline review');
    expect(bundle.report).toMatchObject({globalResetProjected:false,businessProofAndRebasePrepared:false,releaseEligible:false});
  }finally{derived.close();original.close();native.close();baseline.close();}
});
it('rejects real native writes before preparing either reset branch and retains both originals',()=>{
  const native=new Database(input.nativeImage.bytes);try{const p=getProfile(native,'alice')!;saveProfile(native,'alice',{profileId:p.id,revision:p.revision,musicEpoch:0,selections:[]},new Date(input.retiredAt));const bytes=native.serialize(),supplied={...input,nativeImage:{bytes,sha256:forwardHash(bytes)}};
    expect(()=>prepareForwardResetRetirementSources(supplied)).toThrow('native writes requiring explicit reconciliation');expect(supplied.nativeImage.bytes).toEqual(bytes);expect(input.nativeImage.bytes).toEqual(bundle.native.retainedNativeImage);
  }finally{native.close();}
},60000);
it.each(['revival','contact','audit','rowid'] as const)('independent source verification rejects re-pinned identity %s',kind=>{
  const value=changed(),db=new Database(value.identity.bytes);try{
    if(kind==='revival')db.prepare("INSERT INTO prelinks VALUES('10001','alice',1)").run();
    if(kind==='contact')db.prepare("DELETE FROM profile_contacts WHERE qq='10001'").run();
    if(kind==='audit')db.prepare("INSERT INTO link_audit(qq,actor,before_user_id,after_user_id,created) VALUES('10001','forged','','alice',1)").run();
    if(kind==='rowid')db.prepare("UPDATE profile_contacts SET rowid=rowid+10000 WHERE qq='10001'").run();
    value.identity.bytes=db.serialize();value.identity.sha256=forwardHash(value.identity.bytes);value.report.derivedIdentitySha256=value.identity.sha256;
  }finally{db.close();}
  expect(()=>verifyForwardResetRetirementSources(input,value)).toThrow();
},60000);
it('rejects a forged baseline journal, native branch substitution and activation report',()=>{
  const journal=changed();journal.baselineJournal.bytes=Buffer.from('[]\n');journal.baselineJournal.sha256=forwardHash(journal.baselineJournal.bytes);expect(()=>verifyForwardResetRetirementSources(input,journal)).toThrow();
  const branch=changed();branch.baseline=bundle.native;expect(()=>verifyForwardResetRetirementSources(input,branch)).toThrow();
  const report=changed();Object.assign(report.report,{releaseEligible:true});expect(()=>verifyForwardResetRetirementSources(input,report)).toThrow();
},60000);
it('fences late original and derived source changes during verification',()=>{
  const output=changed();expect(()=>verifyForwardResetRetirementSources(input,output,()=>{output.identity.bytes[100]=output.identity.bytes[100]!^1;})).toThrow('output changed');
  const original={...input,members:{...input.members,music:{bytes:Buffer.from(input.members.music.bytes),sha256:input.members.music.sha256}}};expect(()=>verifyForwardResetRetirementSources(original,bundle,()=>{original.members.music.bytes[0]=original.members.music.bytes[0]!^1;})).toThrow('original source changed');
});
