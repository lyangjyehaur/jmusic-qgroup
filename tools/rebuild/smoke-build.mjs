import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import sharp from 'sharp';
const rescueKey='synthetic-built-wallpaper-rescue-'+randomUUID();
const directory = mkdtempSync(join(tmpdir(), 'qgroup-built-'));
const port = 5084;
const child = spawn(process.execPath, ['.rebuild-dist/api/start.mjs'], { env: { ...process.env, REBUILD_ADMIN_KEY_HASH: createHash('sha256').update(rescueKey).digest('hex'), REBUILD_QQ_APP_ID: '', REBUILD_QQ_APP_KEY: '', REBUILD_DB: join(directory, 'empty.sqlite3'), REBUILD_PORT: String(port), REBUILD_ORIGIN: `http://127.0.0.1:${port}` }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  // Drain the large response before shutting down; an unread streamed bundle
  // can keep Fastify.close() waiting on an active socket indefinitely.
  assert((await bundle.arrayBuffer()).byteLength > 0);
  const unknown = await fetch(base + '/api/v2/missing'); assert.equal(unknown.status, 404);
  const activities = await fetch(base + '/api/v2/activities'); assert.equal(activities.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await activities.json()).events, []);
  const session = await fetch(base + '/api/v2/session');
  const viewer=await session.json(); assert.equal(viewer.qqEnabled, false);
  assert(session.headers.get('set-cookie')?.includes('HttpOnly'));
  let cookie=session.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
  const headers={Cookie:cookie,Origin:base,'X-Account-Scope':viewer.scope,'X-CSRF-Token':viewer.csrf,'Content-Type':'application/json'};
  const login=await fetch(base+'/api/v2/admin/login',{method:'POST',headers,body:JSON.stringify({key:rescueKey,confirm:true})});assert.equal(login.status,200);await login.arrayBuffer();
  cookie+='; '+login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
  const access=await(await fetch(base+'/api/v2/admin/session',{headers:{Cookie:cookie,'X-Account-Scope':viewer.scope}})).json();
  const manifest=await(await fetch(base+'/api/v2/appearance')).json();
  const raw=await sharp({create:{width:3,height:2,channels:3,background:'#286f83'}}).png().toBuffer();
  const upload=await fetch(base+'/api/v2/admin/appearance',{method:'POST',headers:{...headers,Cookie:cookie,'X-Admin-CSRF':access.adminCsrf,'Idempotency-Key':randomUUID()},body:JSON.stringify({command:'upload',revision:manifest.revision,confirm:true,name:'合成圖片',mime:'image/png',data:raw.toString('base64')})});assert.equal(upload.status,200);await upload.arrayBuffer();
  const after=await(await fetch(base+'/api/v2/appearance')).json();assert.equal(after.items.length,1);
  const image=await fetch(base+after.items[0].url);assert.deepEqual(Buffer.from(await image.arrayBuffer()),raw);
  const callback = await fetch(base + '/auth/qq/callback?state=invalid&code=synthetic', { redirect: 'manual' });
  assert.equal(callback.status, 303); assert.equal(callback.headers.get('location'), '/auth/confirm?status=invalid');
  console.log('Built API + native SQLite/sharp wallpaper round trip + TS workspace bundle + SPA assets: passed on an empty isolated DB');
} finally {
  child.kill('SIGTERM'); await closed; rmSync(directory, { recursive: true, force: true });
}
