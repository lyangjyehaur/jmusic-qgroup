import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readRollbackPackage} from './rollback-package';
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [root,pin,...extra]=process.argv.slice(2);
  if(!root||!pin||extra.length){process.stderr.write('Usage: npm run verify:rollback -- <private-package-directory> <external-manifest-sha256>\n');process.exitCode=1;}
  else try{const result=readRollbackPackage(root,pin);result.assertUnchanged();process.stdout.write(JSON.stringify({status:'verified_private_package',files:result.manifest.files.length,checkpointDigest:result.report.checkpointDigest,rollbackEligible:false,remaining:result.report.remaining})+'\n');}
  catch{process.stderr.write('Rollback package rejected; preserve the private directory and verify its external pin and complete sources. No service was activated.\n');process.exitCode=1;}
}
