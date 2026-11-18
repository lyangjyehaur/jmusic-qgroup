import { runtimeInfo,webRuntimeConfig } from '@qgroup/runtime';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { openDatabase,openServiceDatabase } from '@qgroup/database';
import { createApp } from './app';
import { qqProvider } from './qq-provider';

const version=runtimeInfo('web');
if(process.argv.length>2){if(process.argv.length!==3||process.argv[2]!=='--version')throw Error('Unsupported web argument');process.stdout.write(JSON.stringify(version)+'\n');process.exit(0);}
const {port,host,origin,database,production}=webRuntimeConfig(process.env);
const staticRoot = resolve('.rebuild-dist/web');
if(production&&!existsSync(staticRoot))throw Error('Production web assets are missing');
const db = (production?openServiceDatabase:openDatabase)(resolve(database));
const app = createApp({ db, origin,runtimeInfo:version, qq: qqProvider(origin), logger: true, musicTrendSampling: true, adminCredentialHash: () => process.env.REBUILD_ADMIN_KEY_HASH ?? '', botEnabledDefault: process.env.REBUILD_BOT_ENABLED === '1',
  activityBot:{enabled:process.env.REBUILD_BOT_ENABLED==='1',scheduleEnabled:process.env.REBUILD_BOT_SCHEDULE!=='0',keyboard:process.env.REBUILD_BOT_KEYBOARD==='1',personalQueue:process.env.REBUILD_BOT_PERSONAL_QUEUE==='1',baseURL:process.env.REBUILD_BOT_BASE_URL??origin,...(process.env.REBUILD_BOT_BROADCAST_KINDS?.trim()?{broadcastKinds:process.env.REBUILD_BOT_BROADCAST_KINDS.split(',').map(kind=>kind.trim()).filter(Boolean)}:{})},
  ...(existsSync(staticRoot) ? { staticRoot } : {}) });
async function stop() { await app.close(); db.close(); }
process.once('SIGTERM', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });
try { await app.listen({ port, host }); }
catch (error) { app.log.error(error); await stop(); process.exitCode = 1; }
