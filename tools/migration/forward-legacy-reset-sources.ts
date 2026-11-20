import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {readRollbackErasureAuthority} from '../../apps/api/src/erasure-authority-protocol';
import {forwardHash,type PinnedForwardBytes} from './forward-board-storage';

export type LegacyResetSourceInput={authorityRoot:string;manifestSha256:string;resets:{sequence:number;persisted:PinnedForwardBytes;loaded:PinnedForwardBytes}[]};
const limit=64*1024*1024,sha=z.string().regex(/^[a-f0-9]{64}$/),containers=z.object({entries:z.number().int().nonnegative(),members:z.number().int().nonnegative(),shouts:z.number().int().nonnegative(),shoutHistory:z.number().int().nonnegative(),trend:z.number().int().nonnegative()}).strict();
const receipt=z.object({version:z.literal(1),persistedSha256:sha,loadedSha256:sha,persistedSize:z.number().int().nonnegative(),loadedSize:z.number().int().nonnegative(),persistedContainers:containers,loadedContainers:containers,bothOriginalSourcesVerified:z.literal(true),resetGenerationsReconciled:z.literal(false),releaseEligible:z.literal(false)}).strict();
const script=`import base64,json,sys
sys.path.insert(0,sys.argv[1])
from tools.migration.rollback_music_reset import verify_legacy_music_reset_sources
value=json.loads(sys.stdin.buffer.read())
result=verify_legacy_music_reset_sources(value['operation'],base64.b64decode(value['persisted'],validate=True),base64.b64decode(value['loaded'],validate=True))
print(json.dumps(result,separators=(',',':')))
`;

/** Bind both original JSON generations to every structured reset in the full
 * verified authority. Inputs are immutable byte copies; no DB/service/file
 * source is opened, restored, cleaned or activated. Scope hashes are verified
 * with the original Python encoding rather than JavaScript reserialization. */
export function verifyForwardLegacyResetSources(input:LegacyResetSourceInput,boundary?:()=>void){
  if(!Array.isArray(input.resets)||input.resets.length>1000)throw Error('Complete original reset source inventory required');
  const root=input.authorityRoot,pin=input.manifestSha256,authority=readRollbackErasureAuthority(root,pin),records=authority.records.filter(row=>row.version===2);
  if(input.resets.length!==records.length||new Set(input.resets.map(row=>row.sequence)).size!==input.resets.length||input.resets.some((row,index)=>row.sequence!==records[index]!.sequence))throw Error('Original reset source inventory differs from authority');
  let total=0;
  const held=input.resets.map(row=>({sequence:row.sequence,...Object.fromEntries((['persisted','loaded'] as const).map(key=>{
    const value=row[key];if(!value||!Buffer.isBuffer(value.bytes)||value.bytes.length>limit||!sha.safeParse(value.sha256).success||forwardHash(value.bytes)!==value.sha256)throw Error('Original reset source pin differs');
    total+=value.bytes.length;if(total>128*1024*1024)throw Error('Original reset source inventory exceeds supported size');
    return [key,{bytes:Buffer.from(value.bytes),sha256:value.sha256}];
  }))})) as LegacyResetSourceInput['resets'];
  const guard=()=>{
    const value:unknown=boundary?.();if(value!==null&&(typeof value==='object'||typeof value==='function')&&'then' in value)throw Error('Reset source boundary must be synchronous');
    if(input.authorityRoot!==root||input.manifestSha256!==pin||input.resets.length!==held.length)throw Error('Original reset source identity changed');
    for(const [index,row] of held.entries()){
      const actual=input.resets[index];if(!actual||actual.sequence!==row.sequence)throw Error('Original reset source order changed');
      for(const key of ['persisted','loaded'] as const)if(!actual[key]||actual[key].sha256!==row[key].sha256||!Buffer.isBuffer(actual[key].bytes)||!actual[key].bytes.equals(row[key].bytes))throw Error('Original reset source bytes changed');
    }
    authority.assertUnchanged();
  };
  guard();const verified=held.map((row,index)=>{
    const record=records[index]!;if(record.version!==2)throw Error('Original structured reset required');
    if(row.persisted.sha256!==record.operation.source.sha256||row.persisted.bytes.length!==record.operation.source.size||row.loaded.sha256!==record.operation.loadedSha256)throw Error('Original reset source does not match recorded generation');
    const payload=JSON.stringify({operation:record.operation,persisted:row.persisted.bytes.toString('base64'),loaded:row.loaded.bytes.toString('base64')});
    let result:z.infer<typeof receipt>;
    try{result=receipt.parse(JSON.parse(execFileSync('python3',['-I','-c',script,fileURLToPath(new URL('../../',import.meta.url))],{input:payload,encoding:'utf8',timeout:30000,maxBuffer:64*1024,stdio:['pipe','pipe','pipe']})));}catch{throw Error('Original reset source or Python container encoding verification failed');}
    if(result.persistedSha256!==row.persisted.sha256||result.loadedSha256!==row.loaded.sha256||result.persistedSize!==row.persisted.bytes.length||result.loadedSize!==row.loaded.bytes.length)throw Error('Original reset source receipt differs');
    for(const key of ['entries','members','shouts','shoutHistory','trend'] as const)if(result.persistedContainers[key]!==record.operation.scope[key].length||result.loadedContainers[key]!==record.operation.loadedScope[key].length)throw Error('Original reset container receipt differs');
    guard();return {sequence:row.sequence,recordSha256:authority.recordPins[row.sequence-1]!,...result};
  });
  guard();return {version:1 as const,authoritySha256:pin,checkpointSha256:authority.manifest.checkpointSha256,headSequence:authority.head.sequence,headRecordSha256:authority.head.recordSha256,resets:verified,allOriginalResetSourcesVerified:true as const,resetGenerationsReconciled:false as const,externalRetentionVerified:false as const,releaseEligible:false as const};
}
