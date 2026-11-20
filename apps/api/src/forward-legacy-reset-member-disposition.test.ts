import {beforeAll,afterAll,expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {legacyResetRecoveryFixture} from '../testsupport/legacy-reset-recovery-fixture';
import {forwardHash,forwardRows} from '../../../tools/migration/forward-board-storage';
import {prepareForwardLegacyResetMemberDisposition,verifyForwardLegacyResetMemberDisposition,type LegacyResetMemberDispositionBundle} from '../../../tools/migration/forward-legacy-reset-member-disposition';
import {prepareForwardLegacyResetIdentityMembers,type LegacyResetIdentityMemberInput} from '../../../tools/migration/forward-legacy-reset-identity-members';
import {reconstructForwardLegacyResetRecovery} from '../../../tools/migration/forward-legacy-reset-recovery';
let s:Awaited<ReturnType<typeof legacyResetRecoveryFixture>>,input:LegacyResetIdentityMemberInput,bundle:LegacyResetMemberDispositionBundle;
const source=(f:typeof s):LegacyResetIdentityMemberInput=>({vault:f.input.vault,music:f.recoveryInput.latestMusic,identity:f.recoveryInput.latestIdentity});
beforeAll(async()=>{s=await legacyResetRecoveryFixture(true,false,'persisted-only-opaque-repeated');input=source(s);bundle=prepareForwardLegacyResetMemberDisposition(input);},60000);
afterAll(()=>s?.close());
function copy(){return {...bundle,dispositions:structuredClone(bundle.dispositions),retainedResets:bundle.retainedResets.map(row=>({...row,persisted:{...row.persisted,bytes:Buffer.from(row.persisted.bytes)},loaded:{...row.loaded,bytes:Buffer.from(row.loaded.bytes)},completion:{...row.completion,bytes:Buffer.from(row.completion.bytes)}})),report:structuredClone(bundle.report)};}
it('retains both real reset preimages of a vanished numeric member without resurrecting membership or inventing deletion authority',()=>{
  expect(bundle.report.retainedHistoryKeys).toEqual(['10001']);expect(bundle.report.retainedOccurrences).toBe(2);expect(bundle.dispositions[0]!.occurrences.map(row=>row.sequence)).toEqual(bundle.retainedResets.map(row=>row.sequence));
  expect(JSON.parse(bundle.projectedMusic.bytes.toString()).members).not.toHaveProperty('10001');
  expect(bundle.retainedMusic.bytes).toEqual(input.music.bytes);expect(bundle.retainedIdentity.bytes).toEqual(input.identity.bytes);
  expect(bundle.report).toMatchObject({authoritySha256:input.vault.manifestSha256,vaultManifestSha256:input.vault.vaultManifestSha256,checkpointSha256:s.input.checkpoint.sha256,originalSourcesAndIdentityRetained:true,currentMembershipUnchanged:true,authenticationActive:false,nativeDispositionApplied:false,latestSourceAncestryVerified:false,releaseEligible:false});
  expect(readFileSync(join(s.music,'erasures.jsonl'),'utf8').split('\n').filter(Boolean).map(row=>JSON.parse(row).qq)).not.toContain('10001');
  expect(verifyForwardLegacyResetMemberDisposition(input,bundle)).toEqual(bundle.report);
});
it('preserves every unknown member field, scalar type, negative zero and key order independently of the JavaScript JSON parser',()=>{
  const observed=JSON.parse(execFileSync('python3',['-I','-c',`import base64,json,math,sys
v=json.load(sys.stdin);rows=[json.loads(base64.b64decode(row['member']['bytes'])) for row in v['occurrences']]
for row in rows:
 x=row['unknownFields'];assert list(x)==['integer','floating','negative','small','nested'];assert type(x['integer']) is int and type(x['floating']) is float;assert math.copysign(1,x['negative'])==-1;assert list(x['nested'][0])==['z','a'];assert x['nested'][0]==dict(z='原始',a=False)
assert rows[0]['name']!=rows[1]['name'];print(json.dumps(dict(verified=True,rows=len(rows))))
`],{input:JSON.stringify(bundle.dispositions[0]),encoding:'utf8',timeout:10000}));expect(observed).toEqual({verified:true,rows:2});
});
it('keeps surviving credential references with their original rowids while leaving bot work, native data and all original files unchanged',()=>{
  const rows=bundle.dispositions[0]!.identityRows;for(const table of ['prelinks','sessions','entry_intents'])expect(rows.some(row=>row.table===table)).toBe(true);
  const original={native:Buffer.from(s.recoveryInput.erasures.nativeImage),bot:[...forwardRows(s.native,'bot_outbox')]};prepareForwardLegacyResetMemberDisposition(input);
  expect(readFileSync(join(s.music,'data.json'))).toEqual(input.music.bytes);expect(readFileSync(join(s.music,'identity.sqlite3'))).toEqual(input.identity.bytes);expect(s.recoveryInput.erasures.nativeImage).toEqual(original.native);expect([...forwardRows(s.native,'bot_outbox')]).toEqual(original.bot);
  expect(()=>prepareForwardLegacyResetIdentityMembers(input)).toThrow('require explicit membership reconciliation');expect(()=>reconstructForwardLegacyResetRecovery(s.recoveryInput)).toThrow('require explicit membership reconciliation');
});
it.each(['payload','occurrence','credential','source','completion','coverage'] as const)('independent verification rejects re-pinned or omitted %s evidence',kind=>{
  const changed=copy(),member=changed.dispositions[0]!;
  if(kind==='payload'){const occurrence=member.occurrences[0]!,bytes=Buffer.from(occurrence.member.bytes,'base64'),altered=Buffer.from(bytes.toString().replace('"floating":1.0','"floating":1'));expect(altered.equals(bytes)).toBe(false);occurrence.member={bytes:altered.toString('base64'),sha256:forwardHash(altered)};}
  if(kind==='occurrence')member.occurrences.pop();
  if(kind==='credential')member.identityRows[0]!.rowid='9223372036854775807';
  if(kind==='source'){const reset=changed.retainedResets[0]!,bytes=Buffer.from(reset.persisted.bytes.toString().replace('"floating":1.0','"floating":1'));expect(bytes.equals(reset.persisted.bytes)).toBe(false);reset.persisted={bytes,sha256:forwardHash(bytes)};member.occurrences[0]!.persistedSha256=reset.persisted.sha256;}
  if(kind==='completion')member.occurrences[0]!.completionSha256='a'.repeat(64);
  if(kind==='coverage'){changed.dispositions=[];changed.report.retainedHistoryKeys=[];changed.report.retainedOccurrences=0;}
  expect(()=>verifyForwardLegacyResetMemberDisposition(input,changed)).toThrow('disposition relation failed');
});
it('rejects forged coverage metadata and synchronous-boundary source changes',()=>{
  const forged=copy();forged.report.retainedHistoryKeys=[];expect(()=>verifyForwardLegacyResetMemberDisposition(input,forged)).toThrow('report differs');
  const wrongAuthority=copy();wrongAuthority.report.authoritySha256='a'.repeat(64);expect(()=>verifyForwardLegacyResetMemberDisposition(input,wrongAuthority)).toThrow('report differs');
  const supplied={...input,music:{...input.music,bytes:Buffer.from(input.music.bytes)}};expect(()=>prepareForwardLegacyResetMemberDisposition(supplied,()=>{supplied.music.bytes[0]=32;})).toThrow('source changed');
  expect(()=>verifyForwardLegacyResetMemberDisposition(input,bundle,()=>Promise.resolve() as unknown as void)).toThrow('must be synchronous');
});
it('rejects a re-pinned startup output that resurrects an absent member, and never accepts active disposition flags',()=>{
  const changed=copy(),data=JSON.parse(bundle.projectedMusic.bytes.toString());data.members['10001']=JSON.parse(Buffer.from(bundle.dispositions[0]!.occurrences[0]!.member.bytes,'base64').toString());const bytes=Buffer.from(JSON.stringify(data));changed.projectedMusic={bytes,sha256:forwardHash(bytes)};changed.report.projectedMusicSha256=changed.projectedMusic.sha256;
  expect(()=>verifyForwardLegacyResetMemberDisposition(input,changed)).toThrow('disposition relation failed');
  const flags=copy();Object.assign(flags.report,{authenticationActive:true,nativeDispositionApplied:true,releaseEligible:true});expect(()=>verifyForwardLegacyResetMemberDisposition(input,flags)).toThrow();
});
it('classifies a numeric member genuinely present again in the latest source as current rather than retiring its earlier reset preimages',()=>{
  const data=JSON.parse(input.music.bytes.toString());data.members['10001']=JSON.parse(Buffer.from(bundle.dispositions[0]!.occurrences[0]!.member.bytes,'base64').toString());const bytes=Buffer.from(JSON.stringify(data)),supplied={...input,music:{bytes,sha256:forwardHash(bytes)}};
  const result=prepareForwardLegacyResetMemberDisposition(supplied);expect(result.report.recoveredOrCurrentKeys).toEqual(['10001']);expect(result.dispositions).toEqual([]);expect(result.report.retainedHistoryKeys).toEqual([]);expect(verifyForwardLegacyResetMemberDisposition(supplied,result)).toEqual(result.report);
});
it.each(['loaded-only','persisted-only-then-erased'] as const)('does not create a new inactive payload copy for actually erased %s members',async mode=>{
  const f=await legacyResetRecoveryFixture(true,false,mode);try{const result=prepareForwardLegacyResetMemberDisposition(source(f));expect(result.dispositions).toEqual([]);expect(result.report.retainedHistoryKeys).toEqual([]);expect(result.report.authorityErasedKeys).toEqual(mode==='loaded-only'?[]:['10001']);expect(verifyForwardLegacyResetMemberDisposition(source(f),result)).toEqual(result.report);}finally{f.close();}
},60000);
it('retains a genuinely recoverable native persisted-only member in current membership without classifying it as removed',async()=>{
  const f=await legacyResetRecoveryFixture(true,true);try{const result=prepareForwardLegacyResetMemberDisposition(source(f));expect(result.dispositions).toEqual([]);expect(result.report.recoveredOrCurrentKeys).toEqual([f.persistedNativeKey]);expect(JSON.parse(result.projectedMusic.bytes.toString()).members[f.persistedNativeKey].selection).toEqual([]);expect(verifyForwardLegacyResetMemberDisposition(source(f),result).currentMembershipUnchanged).toBe(true);}finally{f.close();}
},60000);
