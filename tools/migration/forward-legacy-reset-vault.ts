import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {readRollbackErasureAuthority} from '../../apps/api/src/erasure-authority-protocol';
import {pinRollbackTree} from '../../packages/runtime/src/private-source-files';
import {forwardHash} from './forward-board-storage';
import {verifyForwardLegacyResetSources,type LegacyResetSourceInput} from './forward-legacy-reset-sources';

export type LegacyResetVaultInput={authorityRoot:string;manifestSha256:string;vaultRoot:string;vaultManifestSha256:string};
const sha=z.string().regex(/^[a-f0-9]{64}$/),receipt=z.object({version:z.literal(1),vaultSha256:sha,authoritySha256:sha,checkpointSha256:sha,
  sources:z.array(z.object({sequence:z.number().int().positive().safe().max(100000),persisted:z.string().max(90*1024*1024),loaded:z.string().max(90*1024*1024),snapshotSha256:sha,captureId:z.string().regex(/^[a-f0-9]{32}$/)}).strict()).max(1000),
  unboundOrDuplicateCapturesRetained:z.number().int().nonnegative().safe().max(1000),allRecordedResetSourcesPresent:z.literal(true),externalRetentionVerified:z.literal(false),releaseEligible:z.literal(false)}).strict();
const script=`import json,sys
sys.path.insert(0,sys.argv[1])
from tools.migration.rollback_reset_source_vault import _read_vault_offline
value=json.loads(sys.stdin.buffer.read())
print(json.dumps(_read_vault_offline(value['root'],value['pin'],value['view']),separators=(',',':')))
`;

/** Materialize original snapshots from an explicitly pinned private vault, then
 * run the independent original-source verifier. All raw reads occur in an
 * isolated child, so descriptor cleanup cannot release this parent's SQLite
 * POSIX locks. Parent checks are metadata-only; no service is activated. */
export function readForwardLegacyResetVault(input:LegacyResetVaultInput,boundary?:()=>void){
  const held={...input};sha.parse(held.vaultManifestSha256);
  const authority=readRollbackErasureAuthority(held.authorityRoot,held.manifestSha256),tree=pinRollbackTree(held.vaultRoot);
  const guard=()=>{
    const value:unknown=boundary?.();if(value!==null&&(typeof value==='object'||typeof value==='function')&&'then' in value)throw Error('Reset vault boundary must be synchronous');
    if(Object.keys(held).some(key=>input[key as keyof LegacyResetVaultInput]!==held[key as keyof LegacyResetVaultInput]))throw Error('Reset vault identity changed');
    tree.assertUnchanged();authority.assertUnchanged();
  };
  guard();const payload=JSON.stringify({root:held.vaultRoot,pin:held.vaultManifestSha256,view:{authoritySha256:held.manifestSha256,checkpointSha256:authority.manifest.checkpointSha256,records:authority.records.map((record,index)=>({record,recordSha256:authority.recordPins[index]!}))}});
  let result:z.infer<typeof receipt>;
  try{result=receipt.parse(JSON.parse(execFileSync('python3',['-I','-c',script,fileURLToPath(new URL('../../',import.meta.url))],{input:payload,encoding:'utf8',timeout:30000,maxBuffer:192*1024*1024,stdio:['pipe','pipe','pipe']})));}catch{throw Error('Original reset source vault verification failed; retain private captures');}
  if(result.vaultSha256!==held.vaultManifestSha256||result.authoritySha256!==held.manifestSha256||result.checkpointSha256!==authority.manifest.checkpointSha256)throw Error('Original reset vault receipt binding differs');
  let total=0;
  const sources:LegacyResetSourceInput={authorityRoot:held.authorityRoot,manifestSha256:held.manifestSha256,resets:result.sources.map(row=>({sequence:row.sequence,...Object.fromEntries((['persisted','loaded'] as const).map(key=>{
    const bytes=Buffer.from(row[key],'base64');total+=bytes.length;
    if(bytes.toString('base64')!==row[key]||bytes.length>64*1024*1024||total>128*1024*1024)throw Error('Original reset vault source bytes exceed supported scope');
    return [key,{bytes,sha256:forwardHash(bytes)}];
  }))})) as LegacyResetSourceInput['resets']};
  guard();const verification=verifyForwardLegacyResetSources(sources);guard();
  return {sources,verification,vaultEvidence:{version:1 as const,vaultSha256:held.vaultManifestSha256,authoritySha256:held.manifestSha256,captures:result.sources.map(row=>({sequence:row.sequence,captureId:row.captureId,snapshotSha256:row.snapshotSha256})),unboundOrDuplicateCapturesRetained:result.unboundOrDuplicateCapturesRetained,allRecordedResetSourcesPresent:true as const,externalRetentionVerified:false as const,releaseEligible:false as const}};
}
