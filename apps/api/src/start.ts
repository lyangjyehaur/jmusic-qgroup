import { runtimeInfo,webRuntimeConfig } from '@qgroup/runtime';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { openDatabase,openServiceDatabase } from '@qgroup/database';
import { createApp } from './app';
import { qqProvider } from './qq-provider';
import { LegacyHistoryConfig } from './legacy-music-history';
import {createRetainedErasureJournal,RetainedErasureConfig} from './retained-erasure-journal';

const version=runtimeInfo('web');
if(process.argv.length>2){if(process.argv.length!==3||process.argv[2]!=='--version')throw Error('Unsupported web argument');process.stdout.write(JSON.stringify(version)+'\n');process.exit(0);}
const {port,host,origin,database,production}=webRuntimeConfig(process.env);
const authorityRoot=process.env.REBUILD_ERASURE_AUTHORITY_ROOT,authorityPin=process.env.REBUILD_ERASURE_AUTHORITY_MANIFEST_SHA256,authorityCheckpoint=process.env.REBUILD_ERASURE_AUTHORITY_CHECKPOINT;
const authorityConfig=[authorityRoot,authorityPin,authorityCheckpoint].some(value=>value!==undefined)?RetainedErasureConfig.parse({root:authorityRoot,manifestSha256:authorityPin,sourceCheckpoint:authorityCheckpoint}):undefined;
const staticRoot = resolve('.rebuild-dist/web');
if(production&&!existsSync(staticRoot))throw Error('Production web assets are missing');
const historyRoot=process.env.REBUILD_LEGACY_HISTORY_ROOT,historyPin=process.env.REBUILD_LEGACY_HISTORY_MANIFEST_SHA256;
const legacyHistory=historyRoot!==undefined||historyPin!==undefined?LegacyHistoryConfig.parse({root:historyRoot,manifestSha256:historyPin}):undefined;
const db = (production?openServiceDatabase:openDatabase)(resolve(database));
let retained:Awaited<ReturnType<typeof createRetainedErasureJournal>>|undefined;
let app:ReturnType<typeof createApp>;
try {
retained=authorityConfig?await createRetainedErasureJournal(db,authorityConfig):undefined;
app = createApp({ db, origin,runtimeInfo:version, legacyHistory, erasureJournal:retained, qq: qqProvider(origin), logger: true, musicTrendSampling: true, adminCredentialHash: () => process.env.REBUILD_ADMIN_KEY_HASH ?? '', botEnabledDefault: process.env.REBUILD_BOT_ENABLED === '1',
  activityBot:{enabled:process.env.REBUILD_BOT_ENABLED==='1',scheduleEnabled:process.env.REBUILD_BOT_SCHEDULE!=='0',keyboard:process.env.REBUILD_BOT_KEYBOARD==='1',personalQueue:process.env.REBUILD_BOT_PERSONAL_QUEUE==='1',baseURL:process.env.REBUILD_BOT_BASE_URL??origin,...(process.env.REBUILD_BOT_BROADCAST_KINDS?.trim()?{broadcastKinds:process.env.REBUILD_BOT_BROADCAST_KINDS.split(',').map(kind=>kind.trim()).filter(Boolean)}:{})},
  ...(existsSync(staticRoot) ? { staticRoot } : {}) });
} catch(error) {db.close();await retained?.close();throw error;}
async function stop() { try {await app.close();} finally {db.close();await retained?.close();} }
process.once('SIGTERM', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });
try { await app.listen({ port, host }); }
catch (error) { app.log.error(error); await stop(); process.exitCode = 1; }
