import {resolve} from 'node:path';
import {z} from 'zod';

const absolute=z.string().refine(path=>resolve(path)===path),sha=z.string().regex(/^[a-f0-9]{64}$/);
export const RetainedErasureConfig=z.object({root:absolute,manifestSha256:sha,sourceCheckpoint:absolute,recoveryActivation:z.object({root:absolute,manifestSha256:sha}).strict().optional()}).strict();
/** Parse before opening service storage. Production cannot fall back to a
 * rolling local ledger when the separately retained authority is omitted. */
export function retainedErasureConfig(env:NodeJS.ProcessEnv,production:boolean){
  const root=env.REBUILD_ERASURE_AUTHORITY_ROOT,manifestSha256=env.REBUILD_ERASURE_AUTHORITY_MANIFEST_SHA256,sourceCheckpoint=env.REBUILD_ERASURE_AUTHORITY_CHECKPOINT;
  const activationRoot=env.REBUILD_RECOVERY_ACTIVATION_ROOT,activationPin=env.REBUILD_RECOVERY_ACTIVATION_MANIFEST_SHA256;
  const recoveryActivation=[activationRoot,activationPin].every(value=>value===undefined)?undefined:{root:activationRoot,manifestSha256:activationPin};
  if([root,manifestSha256,sourceCheckpoint,recoveryActivation].every(value=>value===undefined)){
    if(production)throw Error('Production web requires retained erasure authority and checkpoint');
    return undefined;
  }
  return RetainedErasureConfig.parse({root,manifestSha256,sourceCheckpoint,recoveryActivation});
}
