import {afterAll,afterEach,beforeAll,expect,it} from 'vitest';
import Database from 'better-sqlite3';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {legacyResetRecoveryFixture} from '../testsupport/legacy-reset-recovery-fixture';
import {reconstructForwardLegacyResetRecovery,verifyForwardLegacyResetRecovery,type LegacyResetRecoveryBundle} from '../../../tools/migration/forward-legacy-reset-recovery';
import {forwardRows,forwardHash} from '../../../tools/migration/forward-board-storage';
import {profileId,jsonObjectKeys,jsonObjectFromEntries} from '../../../tools/migration/music-codec';
import {getProfile} from './repositories';
import {assertDatabaseUsable} from '@qgroup/database';

const cleanup:(()=>void)[]=[];afterEach(()=>cleanup.splice(0).reverse().forEach(close=>close()));
let fixture:Awaited<ReturnType<typeof legacyResetRecoveryFixture>>,candidate:LegacyResetRecoveryBundle;
beforeAll(async()=>{fixture=await legacyResetRecoveryFixture();candidate=reconstructForwardLegacyResetRecovery(fixture.recoveryInput);},60000);
afterAll(()=>fixture?.close());
function copy<T>(value:T):T{
  if(Buffer.isBuffer(value))return Buffer.from(value) as T;
  if(Array.isArray(value))return value.map(item=>copy(item)) as T;
  if(value&&typeof value==='object')return jsonObjectFromEntries(jsonObjectKeys(value).map(key=>[key,copy((value as Record<string,unknown>)[key])])) as T;
  return value;
}
function changeImage(bytes:Buffer,change:(db:Database.Database)=>{changes:number}){const db=new Database(bytes);try{expect(change(db).changes).toBe(1);return db.serialize();}finally{db.close();}}
const pin=(bytes:Buffer)=>({bytes:Buffer.from(bytes),sha256:forwardHash(bytes)});

it('reconstructs both actual post-reset old and native generations through business, proofs and source rebase without losing bot or historical rows',()=>{
  const s=fixture,head=readFileSync(join(s.authority,'authority-head.json')),result=candidate,db=new Database(result.rebased.nativeImage);cleanup.push(()=>db.close());
  const oldEntry=result.generation.mapping.entries.find(row=>row.originalKey==='e')!.derivedId,oldShout=result.generation.mapping.shouts.find(row=>row.originalKey==='reused-shout')!.derivedId;
  expect(db.prepare('SELECT name FROM music_entries WHERE id=?').get(oldEntry)).toEqual({name:'later old catalog'});expect(db.prepare("SELECT name FROM music_entries WHERE id='native-added-entry'").get()).toEqual({name:'later native catalog'});expect(db.prepare("SELECT 1 FROM music_entries WHERE id='e'").get()).toBeUndefined();
  expect(db.prepare('SELECT body FROM music_shouts WHERE id=?').get(oldShout)).toEqual({body:'later old shout'});expect(db.prepare("SELECT body FROM music_shouts WHERE id='native-added-shout'").get()).toEqual({body:'native body'});
  expect(db.prepare('SELECT level,entry_id FROM music_selections WHERE profile_id=?').all(profileId('38888'))).toEqual([{level:4,entry_id:oldEntry}]);expect(getProfile(db,'later-native-user')).toEqual(getProfile(s.native,'later-native-user'));
  for(const table of ['bot_outbox','bot_settings','bot_settings_history','bot_runtime','privacy_receipts','music_catalog_actions','music_shout_deletions','event_audit','finance_entries','settlement_history'])expect([...forwardRows(db,table)],table).toEqual([...forwardRows(s.native,table)]);
  expect(db.prepare("SELECT payload_json FROM music_documents WHERE kind='trend_sample' ORDER BY position").all()).toEqual([{payload_json:'{"t":8,"counts":{"native-added-entry":1}}'},{payload_json:JSON.stringify({t:5,counts:{[oldEntry]:1}})}]);
  expect(result.business.musicSources.data.members).toHaveProperty('38888');expect((result.business.musicSources.data.members as Record<string,unknown>)['38888']).not.toHaveProperty('contactQQ');
  expect(result.report).toMatchObject({resetRecoveryCandidatePrepared:true,latestSourceAncestryVerified:false,allResetGenerationsReconciled:false,recoveryRequired:true,releaseEligible:false});expect(()=>assertDatabaseUsable(db)).toThrow('offline review');
  expect(verifyForwardLegacyResetRecovery(s.recoveryInput,result).allCandidateRowsVerified).toBe(true);expect(s.db.serialize()).toEqual(s.before);expect(readFileSync(join(s.music,'data.json'))).toEqual(s.latest);expect(readFileSync(join(s.authority,'authority-head.json'))).toEqual(head);expect(forwardHash(result.rebased.nativeImage)).toBe(result.report.finalNativeImageSha256);
},30000);
it('reconstructs the actual post-reset old generation with no subsequent native branch and preserves raw implicit contacts',async()=>{
  const s=await legacyResetRecoveryFixture(false);cleanup.push(()=>s.close());const result=reconstructForwardLegacyResetRecovery(s.recoveryInput),db=new Database(result.rebased.nativeImage);cleanup.push(()=>db.close());
  expect(db.prepare('SELECT count(*) AS n FROM music_entries').get()).toEqual({n:1});expect(db.prepare('SELECT count(*) AS n FROM music_shouts').get()).toEqual({n:2});expect(verifyForwardLegacyResetRecovery(s.recoveryInput,result).allCandidateRowsVerified).toBe(true);
},30000);
it('is repeatable against the same original source environment without rewriting the authority, vault or originals',()=>{
  const again=reconstructForwardLegacyResetRecovery(fixture.recoveryInput);expect(again).toEqual(candidate);expect(verifyForwardLegacyResetRecovery(fixture.recoveryInput,again).allCandidateRowsVerified).toBe(true);
},30000);

it.each(['latestMusic','latestIdentity','latestBoard'] as const)('rejects a changed original %s pin before reconstruction',key=>{
  const input=copy(fixture.recoveryInput);input[key].bytes[0]=input[key].bytes[0]!^1;expect(()=>reconstructForwardLegacyResetRecovery(input)).toThrow('pin');
});
it.each(['nativeImage','nativeJournal'] as const)('rejects a changed original %s pin',key=>{
  const input=copy(fixture.recoveryInput);input.erasures[key]=Buffer.from('changed');expect(()=>reconstructForwardLegacyResetRecovery(input)).toThrow();
});
it('requires a complete private vault and chronological operation times',()=>{
  const input=copy(fixture.recoveryInput);delete input.erasures.resetSourceVault;expect(()=>reconstructForwardLegacyResetRecovery(input)).toThrow('complete private vault');
  const times=copy(fixture.recoveryInput);times.reconciledAt='2026-11-20T00:00:00.000Z';expect(()=>reconstructForwardLegacyResetRecovery(times)).toThrow('out of order');
});
it.each(['latestMusic','latestIdentity','latestBoard','checkpoint','nativeImage','nativeJournal','authorityRoot','manifestSha256','vaultRoot','vaultManifestSha256','reconstructedAt','reconciledAt','rebasedAt'] as const)('fences original %s changes during reconstruction',key=>{
  const input=copy(fixture.recoveryInput);let calls=0;
  expect(()=>reconstructForwardLegacyResetRecovery(input,()=>{
    if(++calls!==2)return;
    if(key==='latestMusic'||key==='latestIdentity'||key==='latestBoard')input[key].bytes[0]=input[key].bytes[0]!^1;
    else if(key==='checkpoint'||key==='nativeImage'||key==='nativeJournal')input.erasures[key]=Buffer.from('changed');
    else if(key==='authorityRoot'||key==='manifestSha256')input.erasures[key]='changed';
    else if(key==='vaultRoot'||key==='vaultManifestSha256')input.erasures.resetSourceVault![key]='changed';
    else input[key]='2026-11-22T00:00:00.000Z';
  })).toThrow(/changed|differs/);expect(calls).toBe(2);
});
it('rejects asynchronous caller boundaries in both reconstruction and verification',()=>{
  const boundary=(()=>Promise.resolve()) as unknown as ()=>void;expect(()=>reconstructForwardLegacyResetRecovery(fixture.recoveryInput,boundary)).toThrow('synchronous');expect(()=>verifyForwardLegacyResetRecovery(fixture.recoveryInput,candidate,boundary)).toThrow('synchronous');
});
it('retains and rejects an unsupported original document instead of silently dropping its content',()=>{
  const input=copy(fixture.recoveryInput),data=JSON.parse(input.latestMusic.bytes.toString());data.unclassified={mustRetain:true};input.latestMusic=pin(Buffer.from(JSON.stringify(data)));const original=Buffer.from(input.latestMusic.bytes);expect(()=>reconstructForwardLegacyResetRecovery(input)).toThrow();expect(input.latestMusic.bytes).toEqual(original);
},30000);

it.each(['generation','source-environment','business-row','business-journal','proof-row','proof-retained','rebase-row','rebase-retained','source-inventory'] as const)('independently rejects re-pinned intermediate %s corruption',kind=>{
  const result=copy(candidate);
  if(kind==='generation'){const data=JSON.parse(result.generation.derivedMusic.bytes.toString());data.entries[Object.keys(data.entries)[0]!].text='forged';result.generation.derivedMusic=pin(Buffer.from(JSON.stringify(data)));}
  if(kind==='source-environment')result.sources.oldBoard=pin(changeImage(result.sources.oldBoard.bytes,db=>db.prepare("UPDATE users SET nickname='forged' WHERE id='alice'").run()));
  if(kind==='business-row')result.business.nativeImage=changeImage(result.business.nativeImage,db=>db.prepare("UPDATE music_entries SET name='forged' WHERE id='native-added-entry'").run());
  if(kind==='business-journal')result.business.nativeJournal=Buffer.from('forged journal');
  if(kind==='proof-row')result.proof.nativeImage=changeImage(result.proof.nativeImage,db=>db.prepare("UPDATE bot_settings SET config_json='forged'").run());
  if(kind==='proof-retained')result.proof.retainedBusinessImage[0]=result.proof.retainedBusinessImage[0]!^1;
  if(kind==='rebase-row')result.rebased.nativeImage=changeImage(result.rebased.nativeImage,db=>db.prepare("UPDATE music_entries SET name='forged' WHERE id='native-added-entry'").run());
  if(kind==='rebase-retained')result.rebased.retainedProofImage[0]=result.rebased.retainedProofImage[0]!^1;
  if(kind==='source-inventory')(result.sources as unknown as Record<string,unknown>).extra=pin(Buffer.from('extra'));
  result.report.finalNativeImageSha256=forwardHash(result.rebased.nativeImage);
  expect(()=>verifyForwardLegacyResetRecovery(fixture.recoveryInput,result)).toThrow();
},30000);
it.each(['top-release','top-source-pin','top-final-pin','generation-report','business-report','proof-report','rebase-report'] as const)('rejects forged report authorization or source identity: %s',kind=>{
  const result=copy(candidate);
  if(kind==='top-release')(result.report as unknown as {releaseEligible:boolean}).releaseEligible=true;
  if(kind==='top-source-pin')result.report.latestSourcePins.music='a'.repeat(64);
  if(kind==='top-final-pin')result.report.finalNativeImageSha256='a'.repeat(64);
  for(const stage of ['generation','business','proof','rebased'] as const)if(kind===(stage==='rebased'?'rebase-report':stage+'-report'))(result[stage].report as unknown as {releaseEligible:boolean}).releaseEligible=true;
  expect(()=>verifyForwardLegacyResetRecovery(fixture.recoveryInput,result)).toThrow('report differs');
},30000);
it.each(['business-journal','report','final-image','member-order'] as const)('fences late %s output mutation at the final verification boundary',kind=>{
  const result=copy(candidate);let calls=0,last=0;verifyForwardLegacyResetRecovery(fixture.recoveryInput,candidate,()=>last++);
  expect(()=>verifyForwardLegacyResetRecovery(fixture.recoveryInput,result,()=>{if(++calls!==last)return;if(kind==='business-journal')result.business.nativeJournal=Buffer.from('changed');else if(kind==='member-order'){const members=result.business.musicSources.data.members as Record<string,unknown>;result.business.musicSources.data.members=jsonObjectFromEntries(jsonObjectKeys(members).reverse().map(key=>[key,members[key]])) as NonNullable<typeof result.business.musicSources.data.members>;}else if(kind==='report')(result.report as unknown as {releaseEligible:boolean}).releaseEligible=true;else result.rebased.nativeImage[0]=result.rebased.nativeImage[0]!^1;})).toThrow('output bundle changed');expect(calls).toBe(last);
},30000);
it('fences original authority tree mutation without touching its live SQLite locks',async()=>{
  const s=await legacyResetRecoveryFixture(false);cleanup.push(()=>s.close());const path=join(s.authority,'authority-head.json'),original=readFileSync(path);let calls=0;
  try{expect(()=>reconstructForwardLegacyResetRecovery(s.recoveryInput,()=>{if(++calls===2)writeFileSync(path,Buffer.concat([original,Buffer.from(' ')]));})).toThrow();}finally{writeFileSync(path,original);}
},30000);
