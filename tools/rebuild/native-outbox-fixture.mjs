import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';

const [database, mode, origin, fault = 'success'] = process.argv.slice(2);
assert(process.argv.length === 5 || process.argv.length === 6);
assert(['plain', 'rich', 'dry-run'].includes(mode));
assert(['success', 'transient', 'unconfirmed'].includes(fault));
assert(fault === 'success' || mode !== 'dry-run');
assert(origin.startsWith('http://127.0.0.1:'));
const path = realpathSync(database), parent = dirname(path);
assert.equal(basename(path), 'synthetic.sqlite3');
assert(basename(parent).startsWith('qgroup-retained-python-') || parent === '/var/lib/qgroup');
globalThis.fetch = () => { throw Error('Native outbox fixture cannot use HTTP transport'); };
globalThis.WebSocket = class { constructor() { throw Error('Native outbox fixture cannot open a gateway'); } };
const inputs = ['api/database.mjs', 'bot/transport.mjs', 'bot/outbox.mjs'];
const pins = () => inputs.map(path => ({ path, sha256: createHash('sha256').update(readFileSync(new URL('../../.rebuild-dist/' + path, import.meta.url))).digest('hex') }));
const runtimePins = pins();
const { openDatabase } = await import(new URL('../../.rebuild-dist/api/database.mjs', import.meta.url));
const { loadBotConfig } = await import(new URL('../../.rebuild-dist/bot/transport.mjs', import.meta.url));
const { BotOutboxWorker } = await import(new URL('../../.rebuild-dist/bot/outbox.mjs', import.meta.url));
const config = loadBotConfig({ KANBAN_DB: path, KANBAN_BOT_BASE_URL: origin,
  KANBAN_BOT_GROUP: 'synthetic-group', KANBAN_BOT_DRY_RUN: mode === 'dry-run' ? '1' : '0',
  KANBAN_BOT_MARKDOWN: mode === 'plain' ? '0' : '1' });
Object.assign(config, { batch: 100, maxAttempts: 5, claimTimeout: 600, allowedLinkHosts: ['127.0.0.1'], logDirectory: join(parent, 'native-synthetic-logs') });
const calls = [], api = { async post(path, body, signal, beforeSend) {
  assert.equal(path, '/v2/groups/synthetic-group/messages'); assert(!signal?.aborted);
  beforeSend?.(); calls.push({ path, body });
  return fault === 'transient' ? { ok: false, code: null, status: 503, kind: 'transient', data: {}, platformTrace: null }
    : fault === 'unconfirmed' ? { ok: false, code: 0, status: 202, kind: 'unconfirmed', data: { id: 'SYNTHETIC_UNCONFIRMED', _unconfirmed_http: 202 }, platformTrace: null }
    : { ok: true, code: 0, status: 200, kind: 'ok', data: { id: 'SYNTHETIC_NATIVE_ONLY' }, platformTrace: null };
} };
const db = openDatabase(path);
try {
  const consumer = new BotOutboxWorker(db, config, api, { composition: { baseURL: origin, keyboard: true } });
  const first = await consumer.pollOnce(), second = await consumer.pollOnce();
  assert.deepEqual(pins(), runtimePins);
  console.log(JSON.stringify({ first, second, calls, runtimePins, runtime: 'compiled-typescript', networkTransport: 'denied', actualQQ: false }));
} finally { db.close(); }
