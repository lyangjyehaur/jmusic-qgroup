import { resolve } from 'node:path';
import { openDatabase } from '@qgroup/database';
import { createApp } from '../src/app';
import { fixture } from './fixture';

// Synthetic preview for browser tests only; no fixture login endpoint.
const db = openDatabase(':memory:'); fixture(db);
const port = Number(process.env.REBUILD_TEST_PORT ?? 5082);
const app = createApp({ db, origin: `http://127.0.0.1:${port}`, staticRoot: resolve('.rebuild-dist/web') });
await app.listen({ host: '127.0.0.1', port });
async function stop() { await app.close(); db.close(); }
process.once('SIGTERM', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });
