import { join,resolve } from 'node:path';
import { runtimeInfo,healthyBot,readBotHealth } from '@qgroup/runtime';
import { botPolicyDefaults } from '@qgroup/domain';
import { botEnvironment, loadBotConfig } from './config';
import { runBot } from './runtime';
import { BotMaintenanceError } from './maintenance';
import { safeError } from './observability';
const version=runtimeInfo('bot');
if(process.argv.length>2){
 if(process.argv.length!==3)throw Error('Unsupported bot argument');
 if(process.argv[2]==='--version'){process.stdout.write(JSON.stringify(version)+'\n');process.exit(0);}
 if(process.argv[2]==='--check-health'){let healthy=false;try{healthy=healthyBot(readBotHealth(join(resolve(process.env.KANBAN_BOT_LOG_DIR??'/var/lib/qgroup/bot-logs'),'bot-health.json')));}catch{}process.exit(healthy?0:1);}
 throw Error('Unsupported bot argument');
}
const environment=botEnvironment(process.env),config=loadBotConfig(environment),stop=new AbortController();
const shutdown=()=>stop.abort();
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
try{
  await runBot(config,stop.signal,{defaults:botPolicyDefaults(environment),composition:{baseURL:config.baseURL,keyboard:environment.KANBAN_BOT_KEYBOARD==='1',personalQueue:environment.KANBAN_BOT_PERSONAL_QUEUE==='1'}});
}catch(error){process.stderr.write(JSON.stringify({event:'bot_failed',...safeError(error),...(error instanceof BotMaintenanceError&&error.reason?{reason:error.reason}:{})})+'\n');process.exitCode=1;}
finally{process.removeListener('SIGINT',shutdown);process.removeListener('SIGTERM',shutdown);}
