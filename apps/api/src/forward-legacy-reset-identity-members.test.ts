import {afterAll,afterEach,beforeAll,expect,it} from 'vitest';
import Database from 'better-sqlite3';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {legacyResetRecoveryFixture} from '../testsupport/legacy-reset-recovery-fixture';
import {prepareForwardLegacyResetIdentityMembers,verifyForwardLegacyResetIdentityMembers,type LegacyResetIdentityMemberInput} from '../../../tools/migration/forward-legacy-reset-identity-members';
import {reconstructForwardLegacyResetRecovery,verifyForwardLegacyResetRecovery,type LegacyResetRecoveryBundle} from '../../../tools/migration/forward-legacy-reset-recovery';
import {forwardHash,forwardRows} from '../../../tools/migration/forward-board-storage';
import {readForwardLegacyResetVault} from '../../../tools/migration/forward-legacy-reset-vault';
import {profileId} from '../../../tools/migration/music-codec';
import {assertDatabaseUsable} from '@qgroup/database';
let s:Awaited<ReturnType<typeof legacyResetRecoveryFixture>>,input:LegacyResetIdentityMemberInput,candidate:LegacyResetRecoveryBundle;
const cleanup:(()=>void)[]=[];afterEach(()=>cleanup.splice(0).reverse().forEach(close=>close()));
beforeAll(async()=>{s=await legacyResetRecoveryFixture(true,true);input={vault:{authorityRoot:s.authority,manifestSha256:s.pin,vaultRoot:s.vault,vaultManifestSha256:s.recoveryInput.erasures.resetSourceVault!.vaultManifestSha256},music:s.recoveryInput.latestMusic,identity:s.recoveryInput.latestIdentity};candidate=reconstructForwardLegacyResetRecovery(s.recoveryInput);},60000);
afterAll(()=>s?.close());
const pin=(bytes:Buffer)=>({bytes:Buffer.from(bytes),sha256:forwardHash(bytes)});
function image(change:(db:Database.Database)=>void){const db=new Database(input.identity.bytes);try{change(db);return pin(db.serialize());}finally{db.close();}}
it('recovers a genuinely persisted but unloaded old native profile after two real resets with its original authority, contact, choices and pending rows',()=>{
  const vault=readForwardLegacyResetVault(input.vault),persisted=JSON.parse(vault.sources.resets[0]!.persisted.bytes.toString()),loaded=JSON.parse(vault.sources.resets[0]!.loaded.bytes.toString());expect(persisted.members).toHaveProperty(s.persistedNativeKey);expect(loaded.members).not.toHaveProperty(s.persistedNativeKey);expect(JSON.parse(input.music.bytes.toString()).members).not.toHaveProperty(s.persistedNativeKey);
  const result=prepareForwardLegacyResetIdentityMembers(input),member=JSON.parse(result.music.bytes.toString()).members[s.persistedNativeKey];expect(member).toMatchObject({qq:s.persistedNativeKey,name:'persisted native member',boardUserId:'contact-owner',contactQQ:'54321',selection:[]});expect(result.report.recoveredKeys).toEqual([s.persistedNativeKey]);expect(verifyForwardLegacyResetIdentityMembers(input,result)).toEqual(result.report);expect(readFileSync(join(s.music,'data.json'))).toEqual(input.music.bytes);expect(readFileSync(join(s.music,'identity.sqlite3'))).toEqual(input.identity.bytes);
},30000);
it('carries the recovered original identity member through generation IDs, business, proofs and source rebase while retaining bot/history and blocking activation',()=>{
  const result=candidate,db=new Database(result.rebased.nativeImage);cleanup.push(()=>db.close());const id=profileId(s.persistedNativeKey),entry=result.generation.mapping.entries.find(row=>row.originalKey==='e')!.derivedId;
  expect(db.prepare('SELECT user_id FROM music_profiles WHERE id=?').get(id)).toEqual({user_id:'contact-owner'});expect(db.prepare('SELECT entry_id,level FROM music_selections WHERE profile_id=?').all(id)).toEqual([]);expect(db.prepare('SELECT 1 FROM music_entries WHERE id=?').get(entry)).toBeDefined();expect(result.identityRows.bindings.some(row=>row.table==='native_profiles'&&row.qq===s.persistedNativeKey)).toBe(true);expect(db.prepare('SELECT contact_qq FROM music_profile_contacts WHERE profile_id=?').get(id)).toEqual({contact_qq:'54321'});
  expect(db.prepare("SELECT count(*) AS n FROM music_legacy_identity WHERE table_name IN ('sessions','entry_intents')").get()).toEqual({n:2});expect(db.prepare('SELECT 1 FROM music_legacy_erasures WHERE legacy_key=?').get(s.persistedNativeKey)).toBeUndefined();expect(db.prepare('SELECT 1 FROM browser_sessions WHERE user_id=\'contact-owner\'').get()).toBeDefined();
  for(const table of ['bot_outbox','bot_settings','bot_settings_history','bot_runtime','privacy_receipts','event_audit','finance_entries','settlement_history'])expect([...forwardRows(db,table)]).toEqual([...forwardRows(s.native,table)]);
  expect(verifyForwardLegacyResetRecovery(s.recoveryInput,result).allCandidateRowsVerified).toBe(true);expect(result.report.projectedMusicSha256).toBe(result.startup.music.sha256);expect(result.report.releaseEligible).toBe(false);expect(()=>assertDatabaseUsable(db)).toThrow('offline review');
},30000);
it.each(['content','representation','order','mapping','flag','pin'] as const)('independently rejects %s corruption even after repinning the runtime source',kind=>{
  const original=prepareForwardLegacyResetIdentityMembers(input),result={music:pin(original.music.bytes),report:{...original.report,recoveredKeys:[...original.report.recoveredKeys]}};
  if(['content','representation','order'].includes(kind)){
    const control=execFileSync('python3',['-c',"import json,sys;sys.stdout.write(json.dumps(json.load(sys.stdin),ensure_ascii=False,separators=(',',':'))+'\\n')"],{input:original.music.bytes});expect(control).toEqual(original.music.bytes);
    const bytes=execFileSync('python3',['-c',`import json,sys
value=json.load(sys.stdin);kind,key=sys.argv[1:]
if kind=='content':value['members'][key]['name']='forged'
if kind=='representation':value['members'][key]['createdAt']=str(value['members'][key]['createdAt'])
if kind=='order':value={key:value[key] for key in reversed(value)}
sys.stdout.write(json.dumps(value,ensure_ascii=False,separators=(',',':'))+'\\n')`,kind,s.persistedNativeKey],{input:original.music.bytes});result.music=pin(bytes);
  }
  if(kind==='mapping')result.report.recoveredKeys=[];
  if(kind==='flag')(result.report as unknown as {releaseEligible:boolean}).releaseEligible=true;
  if(kind==='pin')result.music.sha256='a'.repeat(64);
  expect(()=>verifyForwardLegacyResetIdentityMembers(input,result)).toThrow();
},30000);
it('rejects a stale original identity image that would recover an actually erased loaded member',()=>{
  const identity=image(db=>db.prepare('INSERT INTO native_profiles VALUES(?,?)').run('10001',JSON.stringify({qq:'10001',name:'stale erased'})));expect(()=>prepareForwardLegacyResetIdentityMembers({...input,identity})).toThrow('relation failed');
});
it('preserves unknown original root values and Python scalar types rather than trimming content during member recovery',()=>{
  const music=pin(Buffer.from(input.music.bytes.toString().replace(/}\s*$/,' ,"unclassified":{"float":1.0,"negative":-0.0,"unknown":[true,null]}}'))),source={...input,music},result=prepareForwardLegacyResetIdentityMembers(source);expect(result.music.bytes.toString()).toContain('"float":1.0');expect(result.music.bytes.toString()).toContain('"negative":-0.0');expect(verifyForwardLegacyResetIdentityMembers(source,result).originalValuesTypesAndOrderVerified).toBe(true);
});
it.each(['music','identity','vault'] as const)('fences original %s mutation after initial snapshot',key=>{
  const changed={vault:{...input.vault},music:pin(input.music.bytes),identity:pin(input.identity.bytes)};let calls=0;expect(()=>prepareForwardLegacyResetIdentityMembers(changed,()=>{if(++calls!==2)return;if(key==='vault')changed.vault.vaultManifestSha256='a'.repeat(64);else changed[key].bytes[0]=changed[key].bytes[0]!^1;})).toThrow('changed');expect(calls).toBe(2);
});
it('fences late output changes and rejects asynchronous boundaries',()=>{
  const result=prepareForwardLegacyResetIdentityMembers(input);let calls=0;expect(()=>verifyForwardLegacyResetIdentityMembers(input,result,()=>{if(++calls===2)result.report.recoveredKeys=[];})).toThrow('output changed');expect(()=>prepareForwardLegacyResetIdentityMembers(input,(()=>Promise.resolve()) as unknown as ()=>void)).toThrow('synchronous');
});

function copy<T>(value:T):T{if(Buffer.isBuffer(value))return Buffer.from(value) as T;if(Array.isArray(value))return value.map(item=>copy(item)) as T;if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,copy(item)])) as T;return value;}
it.each(['startup-content','startup-report','identity-row','identity-binding','identity-report'] as const)('whole-candidate verification rejects re-pinned %s corruption',kind=>{
  const result=copy(candidate);
  if(kind==='startup-content'){result.startup.music=pin(Buffer.from(result.startup.music.bytes.toString().replace('persisted native member','forged member')));result.report.projectedMusicSha256=result.startup.music.sha256;}
  if(kind==='startup-report')result.startup.report.recoveredKeys=[];
  if(kind==='identity-row'){const db=new Database(result.identityRows.identity.bytes);try{expect(db.prepare("UPDATE prelinks SET user_id='forged' WHERE qq=?").run(s.persistedNativeKey).changes).toBe(1);result.identityRows.identity=pin(db.serialize());result.sources.oldIdentity=pin(result.identityRows.identity.bytes);result.report.projectedIdentitySha256=result.identityRows.identity.sha256;}finally{db.close();}}
  if(kind==='identity-binding')result.identityRows.bindings[0]!.derivedRowid='999';
  if(kind==='identity-report')(result.identityRows.report as unknown as {releaseEligible:boolean}).releaseEligible=true;
  expect(()=>verifyForwardLegacyResetRecovery(s.recoveryInput,result)).toThrow();
},30000);
