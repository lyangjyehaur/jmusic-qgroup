import {resolve} from 'node:path';
import {z} from 'zod';

export const RetainedErasureConfig=z.object({root:z.string().refine(path=>resolve(path)===path),manifestSha256:z.string().regex(/^[a-f0-9]{64}$/),sourceCheckpoint:z.string().refine(path=>resolve(path)===path)}).strict();
/** Parse before opening service storage. Production cannot fall back to a
 * rolling local ledger when the separately retained authority is omitted. */
export function retainedErasureConfig(env:NodeJS.ProcessEnv,production:boolean){
  const root=env.REBUILD_ERASURE_AUTHORITY_ROOT,manifestSha256=env.REBUILD_ERASURE_AUTHORITY_MANIFEST_SHA256,sourceCheckpoint=env.REBUILD_ERASURE_AUTHORITY_CHECKPOINT;
  if([root,manifestSha256,sourceCheckpoint].every(value=>value===undefined)){
    if(production)throw Error('Production web requires retained erasure authority and checkpoint');
    return undefined;
  }
  return RetainedErasureConfig.parse({root,manifestSha256,sourceCheckpoint});
}
