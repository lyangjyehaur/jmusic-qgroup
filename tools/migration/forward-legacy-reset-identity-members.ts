import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import Database from 'better-sqlite3';
import {readRollbackErasureAuthority} from '../../apps/api/src/erasure-authority-protocol';
import {pinRollbackTree} from '../../packages/runtime/src/private-source-files';
import {forwardHash,assertForwardImage,type PinnedForwardBytes} from './forward-board-storage';
import {assertForwardIdentity} from './forward-music-sources';
import {readForwardLegacyResetVault,type LegacyResetVaultInput} from './forward-legacy-reset-vault';
export type LegacyResetIdentityMemberInput={vault:LegacyResetVaultInput;music:PinnedForwardBytes;identity:PinnedForwardBytes};
const sha=z.string().regex(/^[a-f0-9]{64}$/),receiptSchema=z.object({originalMusicSha256:sha,originalIdentitySha256:sha,projectedMusicSha256:sha,recoveredKeys:z.array(z.string().regex(/^(?:[0-9]{4,12}|m_[a-f0-9]{24})$/)).max(100000),originalValuesTypesAndOrderVerified:z.literal(true),originalIdentityImageRetained:z.literal(true),authenticationActive:z.literal(false),latestSourceAncestryVerified:z.literal(false),releaseEligible:z.literal(false)}).strict();
const script=`import json,base64,sys
sys.path.insert(0,sys.argv[1])
from tools.migration.rollback_music_identity_members import prepare_identity_members,verify_identity_members
value=json.loads(sys.stdin.buffer.read());raw=base64.b64decode(value['music'],validate=True);image=base64.b64decode(value['identity'],validate=True);erased=set(value['erased'])
if value['mode']=='prepare':print(json.dumps(dict(derived=base64.b64encode(prepare_identity_members(raw,image,erased)).decode())))
else:print(json.dumps(verify_identity_members(raw,image,erased,base64.b64decode(value['derived'],validate=True))))
`;
function call(payload:unknown){try{return JSON.parse(execFileSync('python3',['-I','-c',script,fileURLToPath(new URL('../../',import.meta.url))],{input:JSON.stringify(payload),encoding:'utf8',timeout:30000,maxBuffer:192*1024*1024,stdio:['pipe','pipe','pipe']}));}catch{throw Error('Original reset identity member relation failed; retain original sources');}}
function held(input:LegacyResetIdentityMemberInput,boundary?:()=>void){
  const s={vault:{...input.vault},music:{bytes:Buffer.from(input.music.bytes),sha256:input.music.sha256},identity:{bytes:Buffer.from(input.identity.bytes),sha256:input.identity.sha256}};
  for(const row of [s.music,s.identity])if(!sha.safeParse(row.sha256).success||forwardHash(row.bytes)!==row.sha256)throw Error('Original identity member source pin differs');
  if(s.music.bytes.length>64*1024*1024||s.identity.bytes.length>512*1024*1024)throw Error('Original identity member source exceeds capacity');assertForwardImage(s.identity.bytes);
  const db=new Database(s.identity.bytes);try{assertForwardIdentity(db);}finally{db.close();}
  const authority=readRollbackErasureAuthority(s.vault.authorityRoot,s.vault.manifestSha256),tree=pinRollbackTree(s.vault.vaultRoot),vault=readForwardLegacyResetVault(s.vault);
  if(!authority.records.some(row=>row.version===2)||!vault.vaultEvidence.allRecordedResetCompletionsPresent)throw Error('Original identity member recovery requires complete resets');
  const erased=[...new Set(authority.ledgers.music.toString().split('\n').filter(row=>row.trim()).map(row=>(JSON.parse(row) as {qq:string}).qq))];
  const guard=()=>{const value:unknown=boundary?.();if(value!==null&&(typeof value==='object'||typeof value==='function')&&'then' in value)throw Error('Identity member recovery boundary must be synchronous');for(const key of Object.keys(s.vault) as (keyof LegacyResetVaultInput)[])if(input.vault[key]!==s.vault[key])throw Error('Identity member vault changed');for(const key of ['music','identity'] as const)if(input[key].sha256!==s[key].sha256||!Buffer.isBuffer(input[key].bytes)||!input[key].bytes.equals(s[key].bytes))throw Error('Identity member source changed');tree.assertUnchanged();authority.assertUnchanged();};
  guard();return {s,guard,payload:{music:s.music.bytes.toString('base64'),identity:s.identity.bytes.toString('base64'),erased}};
}
function relation(h:ReturnType<typeof held>,music:PinnedForwardBytes){
  if(!Buffer.isBuffer(music.bytes)||music.bytes.length>64*1024*1024||forwardHash(music.bytes)!==music.sha256)throw Error('Projected identity member pin differs');
  const report=receiptSchema.parse(call({...h.payload,mode:'verify',derived:music.bytes.toString('base64')}));
  if(report.originalMusicSha256!==h.s.music.sha256||report.originalIdentitySha256!==h.s.identity.sha256||report.projectedMusicSha256!==music.sha256)throw Error('Original identity member receipt pins differ');h.guard();return report;
}
/** Recover only the original runtime's identity projection on disposable copies.
 * The persisted source bytes stay intact; this is not a new erasure or login. */
export function prepareForwardLegacyResetIdentityMembers(input:LegacyResetIdentityMemberInput,boundary?:()=>void){
  const h=held(input,boundary),raw=z.object({derived:z.string().max(90*1024*1024)}).strict().parse(call({...h.payload,mode:'prepare'})),bytes=Buffer.from(raw.derived,'base64');if(bytes.toString('base64')!==raw.derived)throw Error('Original identity member encoding differs');const music={bytes,sha256:forwardHash(bytes)},report=relation(h,music);h.guard();return {music,report};
}
export type LegacyResetIdentityMemberBundle=ReturnType<typeof prepareForwardLegacyResetIdentityMembers>;
/** Independent SQL/JSON relation, never reruns the original projection writer. */
export function verifyForwardLegacyResetIdentityMembers(input:LegacyResetIdentityMemberInput,bundle:LegacyResetIdentityMemberBundle,boundary?:()=>void){
  const original=JSON.stringify([bundle.music.sha256,forwardHash(bundle.music.bytes),bundle.report]),h=held(input,()=>{const value:unknown=boundary?.();if(value!==null&&(typeof value==='object'||typeof value==='function')&&'then' in value)throw Error('Identity member recovery boundary must be synchronous');if(JSON.stringify([bundle.music.sha256,forwardHash(bundle.music.bytes),bundle.report])!==original)throw Error('Identity member output changed');});
  const report=relation(h,bundle.music);if(JSON.stringify(receiptSchema.parse(bundle.report))!==JSON.stringify(report))throw Error('Identity member report differs');h.guard();return report;
}
