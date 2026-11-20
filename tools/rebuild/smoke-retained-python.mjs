import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { exerciseRetainedPython } from './retained-python-scenarios.mjs';
import { openDatabase } from '../../.rebuild-dist/api/database.mjs';

// This baseline is the original audited bot, not an assertion about the bot
// currently online. Nothing from the working-tree Python implementation loads.
const pythonCommit = '8da877857f163853c449474e168534e2e493121b';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'qgroup-retained-python-')));
try {
const pythonSource = join(root, 'original-python'), database = join(root, 'synthetic.sqlite3');
const fixture = resolve('tools/rebuild/retained-python-fixture.py');
const fixtureSha256 = hash(readFileSync(fixture));
const scenarioPath = resolve('tools/rebuild/retained-python-scenarios.mjs');
const scenarioSha256 = hash(readFileSync(scenarioPath));
const db = openDatabase(database);
try {
  for (const id of ['alice', 'bob']) {
    const token = hash('synthetic-retained-' + id);
    db.prepare('INSERT INTO users(id,token_hash,nickname,created_at) VALUES(?,?,?,?)').run(id, token, id, new Date().toISOString());
    db.prepare('INSERT INTO browser_sessions VALUES(?,?,?)').run(token, id, new Date().toISOString());
  }
} finally { db.close(); }
mkdirSync(pythonSource, { mode: 0o700 });
const archive = execFileSync('git', ['archive', pythonCommit, 'qgroup_core', 'qgroup_bot'], { maxBuffer: 32 * 1024 * 1024 });
execFileSync('tar', ['-xf', '-', '-C', pythonSource], { input: archive });
const sourceFiles = execFileSync('git', ['ls-tree', '-r', '--name-only', pythonCommit, '--', 'qgroup_core', 'qgroup_bot'], { encoding: 'utf8' }).trim().split('\n');
const pythonPins = sourceFiles.map(path => {
  const bytes = readFileSync(join(pythonSource, path));
  assert(bytes.equals(execFileSync('git', ['show', pythonCommit + ':' + path], { maxBuffer: 16 * 1024 * 1024 })));
  return { path, sha256: hash(bytes) };
});
const runtimePins = ['api/start.mjs', 'api/database.mjs'].map(path => ({ path, sha256: hash(readFileSync('.rebuild-dist/' + path)) }));
const portServer = createServer();
await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
const port = portServer.address().port;
await new Promise(resolve => portServer.close(resolve));
const origin = 'http://127.0.0.1:' + port, rescue = 'synthetic-rescue-' + randomUUID();
const environment = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
  REBUILD_DB: database, REBUILD_ORIGIN: origin, REBUILD_HOST: '127.0.0.1', REBUILD_PORT: String(port),
  REBUILD_BOT_ENABLED: '1', REBUILD_BOT_KEYBOARD: '1', REBUILD_BOT_PERSONAL_QUEUE: '1',
  REBUILD_ADMIN_KEY_HASH: hash(rescue), REBUILD_QQ_APP_ID: '', REBUILD_QQ_APP_KEY: '' };
const child = spawn(process.execPath, ['.rebuild-dist/api/start.mjs'], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '', stopped = false;
child.stdout.on('data', bytes => { logs = (logs + bytes).slice(-32768); });
child.stderr.on('data', bytes => { logs = (logs + bytes).slice(-32768); });
const closed = new Promise(resolve => child.once('exit', (code, signal) => { stopped = true; resolve({ code, signal }); }));
const rows = (sql, ...values) => { const db = new Database(database, { readonly: true }); try { return db.prepare(sql).all(...values); } finally { db.close(); } };
let httpCalls = 0, originalWorkerInvocations = 0;
const request = (...args) => { httpCalls++; return fetch(...args); };
const python = (mode, id) => {
  originalWorkerInvocations++;
  return JSON.parse(execFileSync('python3', [fixture, pythonSource, database, mode, id, origin], {
    env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1', KANBAN_BOT_BASE_URL: origin },
    encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024,
  }));
};
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    assert(!stopped, logs);
    try { ready = (await fetch(origin + '/api/v2/health', { signal: AbortSignal.timeout(1000) })).ok; } catch { /* startup */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, logs);
  const scenario = await exerciseRetainedPython({ origin, rescue, rows, python, fetch: request });
  child.kill('SIGTERM'); const exit = await closed; assert.equal(exit.code, 0, logs);
  const afterPins = sourceFiles.map(path => ({ path, sha256: hash(readFileSync(join(pythonSource, path))) })); assert.deepEqual(afterPins, pythonPins);
  assert.equal(hash(readFileSync(fixture)), fixtureSha256);
  assert.equal(hash(readFileSync(scenarioPath)), scenarioSha256);
  assert.deepEqual(runtimePins.map(({ path }) => ({ path, sha256: hash(readFileSync('.rebuild-dist/' + path)) })), runtimePins);
  console.log(JSON.stringify({ version: 1, pythonCommit, pythonSourcePins: pythonPins, runtimePins, fixtureSha256, scenarioSha256, ...scenario, httpCalls, originalWorkerInvocations,
    networkTransport: 'denied', actualQQ: false, actualProductionImageCombination: false, scope: 'none', releaseEligible: false, gracefulStop: true }));
} finally {
  if (!stopped) { child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 10000); try { await closed; } finally { clearTimeout(timer); } }
}
} finally {
  rmSync(root, { recursive: true, force: true });
}
