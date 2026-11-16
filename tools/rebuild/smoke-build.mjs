import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const directory = mkdtempSync(join(tmpdir(), 'qgroup-built-'));
const port = 5084;
const child = spawn(process.execPath, ['.rebuild-dist/api/start.mjs'], { env: { ...process.env, REBUILD_QQ_APP_ID: '', REBUILD_QQ_APP_KEY: '', REBUILD_DB: join(directory, 'empty.sqlite3'), REBUILD_PORT: String(port), REBUILD_ORIGIN: `http://127.0.0.1:${port}` }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
const closed = new Promise(resolve => child.once('exit', resolve));
try {
  const base = `http://127.0.0.1:${port}`;
  let healthy = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { healthy = (await fetch(base + '/api/v2/health')).ok; } catch { /* Wait for socket. */ }
    if (healthy) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(healthy, logs);
  const page = await fetch(base + '/me/music'); assert.equal(page.status, 200);
  assert(page.headers.get('content-security-policy')?.includes("script-src 'self'"));
  const html = await page.text();
  const asset = html.match(/src="([^"]+\.js)"/)[1];
  const bundle = await fetch(base + asset); assert.equal(bundle.status, 200); assert(bundle.headers.get('content-type')?.includes('javascript'));
  const unknown = await fetch(base + '/api/v2/missing'); assert.equal(unknown.status, 404);
  const activities = await fetch(base + '/api/v2/activities'); assert.equal(activities.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await activities.json()).events, []);
  const session = await fetch(base + '/api/v2/session');
  assert.equal((await session.json()).qqEnabled, false);
  assert(session.headers.get('set-cookie')?.includes('HttpOnly'));
  const callback = await fetch(base + '/auth/qq/callback?state=invalid&code=synthetic', { redirect: 'manual' });
  assert.equal(callback.status, 303); assert.equal(callback.headers.get('location'), '/auth/confirm?status=invalid');
  console.log('Built API + native SQLite + TS workspace bundle + SPA assets: passed on an empty isolated DB');
} finally {
  child.kill('SIGTERM'); await closed; rmSync(directory, { recursive: true, force: true });
}
