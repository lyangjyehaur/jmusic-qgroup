import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readRollbackBotRestore} from './rollback-bot-restore';
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [root,pin,...extra]=process.argv.slice(2);
  if(!root||!pin||extra.length){process.stderr.write('Usage: npm run verify:rollback-bot -- <private-bot-restore-directory> <external-manifest-sha256>\n');process.exitCode=1;}
  else try{const result=readRollbackBotRestore(root,pin);result.assertUnchanged();process.stdout.write(JSON.stringify({status:'verified_private_bot_restore',files:result.manifest.files.length,sourcePackageSha256:result.manifest.sourcePackageSha256,sourceBotStateSha256:result.manifest.sourceBotStateSha256,rollbackEligible:false})+'\n');}
  catch{process.stderr.write('Bot restore verification rejected; preserve the private directory and original external pins. No service was activated.\n');process.exitCode=1;}
}
