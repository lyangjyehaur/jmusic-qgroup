import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { openDatabase } from '@qgroup/database';
import { createApp } from './app';
import { qqProvider } from './qq-provider';

// An isolated local development entry point. Production release wiring is still a parity gate.
const port = Number(process.env.REBUILD_PORT ?? '5081');
const db = openDatabase(resolve(process.env.REBUILD_DB ?? '.rebuild-data/unified.sqlite3'));
const staticRoot = resolve('.rebuild-dist/web');
const origin = process.env.REBUILD_ORIGIN ?? 'http://127.0.0.1:5080';
const app = createApp({ db, origin, qq: qqProvider(origin), logger: true, botEnabledDefault: process.env.REBUILD_BOT_ENABLED === '1',
  ...(existsSync(staticRoot) ? { staticRoot } : {}) });
async function stop() { await app.close(); db.close(); }
process.once('SIGTERM', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });
try { await app.listen({ port, host: '127.0.0.1' }); }
catch (error) { app.log.error(error); await stop(); process.exitCode = 1; }
