import {beforeAll,afterAll,expect,it} from 'vitest';
import Database from 'better-sqlite3';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {legacyResetRecoveryFixture} from '../testsupport/legacy-reset-recovery-fixture';
import {readForwardLegacyResetVault} from '../../../tools/migration/forward-legacy-reset-vault';
import {prepareForwardLegacyResetIdentityMembers,verifyForwardLegacyResetIdentityMembers,type LegacyResetIdentityMemberInput,type LegacyResetIdentityMemberBundle} from '../../../tools/migration/forward-legacy-reset-identity-members';
import {reconstructForwardLegacyResetRecovery,verifyForwardLegacyResetRecovery} from '../../../tools/migration/forward-legacy-reset-recovery';
import {forwardHash,forwardRows} from '../../../tools/migration/forward-board-storage';
import {assertDatabaseUsable} from '@qgroup/database';
let s:Awaited<ReturnType<typeof legacyResetRecoveryFixture>>,input:LegacyResetIdentityMemberInput;
const missing='Original persisted-only reset members require explicit membership reconciliation';
const source=(f:typeof s):LegacyResetIdentityMemberInput=>({vault:f.input.vault,music:f.recoveryInput.latestMusic,identity:f.recoveryInput.latestIdentity});
beforeAll(async()=>{s=await legacyResetRecoveryFixture(true,false,'persisted-only');input=source(s);},60000);
afterAll(()=>s?.close());
function originalRows(bytes:Buffer,table:string){const db=new Database(bytes);try{return [...forwardRows(db,table)];}finally{db.close();}}
it('observes the real numeric persisted/loaded difference, surviving credentials and actual original restart without inventing a native payload',()=>{
  const vault=readForwardLegacyResetVault(input.vault),first=vault.sources.resets[0]!;
  expect(JSON.parse(first.persisted.bytes.toString()).members).toHaveProperty('10001');expect(JSON.parse(first.loaded.bytes.toString()).members).not.toHaveProperty('10001');
  expect(JSON.parse(input.music.bytes.toString()).members).not.toHaveProperty('10001');
  for(const table of ['prelinks','sessions','entry_intents'])expect(originalRows(input.identity.bytes,table).some(row=>row.qq==='10001')).toBe(true);
  expect(originalRows(input.identity.bytes,'native_profiles').some(row=>row.qq==='10001')).toBe(false);
  expect(readFileSync(join(s.music,'erasures.jsonl'),'utf8').split('\n').filter(Boolean).map(row=>JSON.parse(row).qq)).not.toContain('10001');
  const observed=JSON.parse(execFileSync('python3',['-I','-c',`import base64,json,sys,tempfile
from pathlib import Path
sys.path.insert(0,sys.argv[1]);from music_site.identity_store import Store
value=json.load(sys.stdin);data=json.loads(base64.b64decode(value['music']))
with tempfile.TemporaryDirectory() as root:
 path=Path(root)/'identity.sqlite3';path.write_bytes(base64.b64decode(value['identity']));store=Store(path);store.recover_profiles(data)
 print(json.dumps(dict(memberPresent='10001' in data['members'],mapping=store.link_for_qq('10001')['user_id'])))
`,process.cwd()],{input:JSON.stringify({music:input.music.bytes.toString('base64'),identity:input.identity.bytes.toString('base64')}),encoding:'utf8',timeout:10000}));
  expect(observed).toEqual({memberPresent:false,mapping:'alice'});
});
it('rejects both startup projection and the whole candidate before silently losing an unloaded numeric member, retaining all sources and bot work',()=>{
  const original={music:Buffer.from(input.music.bytes),identity:Buffer.from(input.identity.bytes),native:Buffer.from(s.recoveryInput.erasures.nativeImage),bot:[...forwardRows(s.native,'bot_outbox')]};
  expect(()=>prepareForwardLegacyResetIdentityMembers(input)).toThrow(missing);expect(()=>reconstructForwardLegacyResetRecovery(s.recoveryInput)).toThrow(missing);
  expect(readFileSync(join(s.music,'data.json'))).toEqual(original.music);expect(readFileSync(join(s.music,'identity.sqlite3'))).toEqual(original.identity);expect(s.recoveryInput.erasures.nativeImage).toEqual(original.native);expect([...forwardRows(s.native,'bot_outbox')]).toEqual(original.bot);
});
it('independent verification rejects an otherwise exact, re-pinned original startup projection that omitted the verified reset-member scope',()=>{
  const erased=readFileSync(join(s.music,'erasures.jsonl'),'utf8').split('\n').filter(Boolean).map(row=>JSON.parse(row).qq);
  // Deliberately bypass the scope in a disposable writer, then pass its exact
  // output to the public verifier which derives scope from the pinned vault.
  const result=JSON.parse(execFileSync('python3',['-I','-c',`import base64,json,sys
sys.path.insert(0,sys.argv[1]);from tools.migration.rollback_music_identity_members import prepare_identity_members,verify_identity_members
v=json.load(sys.stdin);raw=base64.b64decode(v['music']);image=base64.b64decode(v['identity']);erased=set(v['erased']);derived=prepare_identity_members(raw,image,erased)
print(json.dumps(dict(bytes=base64.b64encode(derived).decode(),report=verify_identity_members(raw,image,erased,derived))))
`,process.cwd()],{input:JSON.stringify({music:input.music.bytes.toString('base64'),identity:input.identity.bytes.toString('base64'),erased}),encoding:'utf8',timeout:30000}));
  const bytes=Buffer.from(result.bytes,'base64'),bundle:LegacyResetIdentityMemberBundle={music:{bytes,sha256:forwardHash(bytes)},report:result.report};
  expect(bundle.report.originalValuesTypesAndOrderVerified).toBe(true);expect(()=>verifyForwardLegacyResetIdentityMembers(input,bundle)).toThrow(missing);
});
it.each(['loaded-only','persisted-only-then-erased'] as const)('uses actual %s authority evidence rather than widening deletion from persisted membership',async mode=>{
  const f=await legacyResetRecoveryFixture(true,false,mode);
  try{
    const authority=readFileSync(join(f.music,'erasures.jsonl'),'utf8').split('\n').filter(Boolean).map(row=>JSON.parse(row).qq);expect(authority).toContain('10001');
    for(const table of ['prelinks','sessions','entry_intents'])expect(originalRows(f.recoveryInput.latestIdentity.bytes,table).some(row=>row.qq==='10001')).toBe(false);
    const prepared=prepareForwardLegacyResetIdentityMembers(source(f));expect(prepared.report.unloadedResetKeys).toEqual([]);expect(prepared.report.unloadedResetMembersCovered).toBe(true);
    const candidate=reconstructForwardLegacyResetRecovery(f.recoveryInput),db=new Database(candidate.rebased.nativeImage);
    try{expect(db.prepare("SELECT 1 FROM music_legacy_erasures WHERE legacy_key='10001'").get()).toBeDefined();expect(verifyForwardLegacyResetRecovery(f.recoveryInput,candidate).allCandidateRowsVerified).toBe(true);expect(()=>assertDatabaseUsable(db)).toThrow('offline review');for(const table of ['bot_outbox','bot_settings','bot_runtime'])expect([...forwardRows(db,table)]).toEqual([...forwardRows(f.native,table)]);}finally{db.close();}
  }finally{f.close();}
},60000);
it('reports a genuinely recoverable unloaded native key and rejects forged coverage metadata',async()=>{
  const f=await legacyResetRecoveryFixture(true,true);
  try{const supplied=source(f),bundle=prepareForwardLegacyResetIdentityMembers(supplied);expect(bundle.report.unloadedResetKeys).toEqual([f.persistedNativeKey]);expect(bundle.report.unloadedResetMembersCovered).toBe(true);bundle.report.unloadedResetKeys=[];expect(()=>verifyForwardLegacyResetIdentityMembers(supplied,bundle)).toThrow('report differs');}finally{f.close();}
},60000);
