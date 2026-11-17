import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import sharp from 'sharp';
const rescueKey='synthetic-built-wallpaper-rescue-'+randomUUID();
const directory = realpathSync(mkdtempSync(join(tmpdir(), 'qgroup-built-')));
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
  const configure=await fetch(base+'/api/v2/admin/appearance',{method:'POST',headers:{...headers,Cookie:cookie,'X-Admin-CSRF':access.adminCsrf,'Idempotency-Key':randomUUID()},body:JSON.stringify({command:'config',revision:after.revision,confirm:true,rotateSeconds:30})});assert.equal(configure.status,200);await configure.arrayBuffer();
  const readHeaders={Cookie:cookie,'X-Account-Scope':viewer.scope};
  const backups=await(await fetch(base+'/api/v2/admin/backups',{headers:readHeaders})).json();assert.equal(backups.available,true);assert.equal(backups.backups.length,3);
  const id=backups.backups[0].id;
  const proof=JSON.parse(readFileSync(join(directory,'paired-backups',id,'manifest.json'),'utf8'));assert.equal(proof.restoreEligible,false);assert.equal(proof.version,2);assert.equal(proof.schema,14);assert.match(proof.lineageId,/^[a-f0-9]{32}$/);assert(proof.files.some(file=>file.path==='state.sqlite3'));
  for(const path of ['/api/v2/admin/music-export','/api/v2/admin/music-export?backup='+id]){const exported=await fetch(base+path,{headers:readHeaders});assert.equal(exported.status,200);assert.equal(exported.headers.get('cache-control'),'no-store');const data=await exported.json();assert.deepEqual({...data,trend:[]},{entries:{},members:{},settings:{},shouts:[],shoutHistory:[],trend:[]});assert.equal(data.trend.length,1);assert.deepEqual(data.trend[0].counts,{});assert(Number.isSafeInteger(data.trend[0].t));}
  const callback = await fetch(base + '/auth/qq/callback?state=invalid&code=synthetic', { redirect: 'manual' });
  assert.equal(callback.status, 303); assert.equal(callback.headers.get('location'), '/auth/confirm?status=invalid');
  child.kill('SIGTERM'); await closed;
  // Only immutable native archives and new synthetic evidence are passed to the
  // offline CLI after the synthetic server has stopped. No bot runs here.
  const evidence=join(directory,'evidence'),candidate=join(directory,'candidate');mkdirSync(evidence);writeFileSync(join(directory,'empty.erasures.jsonl'),'');
  const archive=join(directory,'paired-backups',id);
  const recovered=spawnSync(process.execPath,['--import','tsx','tools/rebuild/restore-backup.ts',archive,archive,join(directory,'empty.erasures.jsonl'),evidence,candidate,'--quiescent-copy'],{encoding:'utf8'});
  assert.equal(recovered.status,0,recovered.stderr);assert.equal(JSON.parse(recovered.stdout).recoveryRequired,true);
  const blocked=spawnSync(process.execPath,['.rebuild-dist/api/start.mjs'],{env:{...process.env,REBUILD_DB:join(candidate,'unified.sqlite3'),REBUILD_PORT:String(port)},encoding:'utf8',timeout:10000});
  assert.equal(blocked.status,1);assert.match(blocked.stderr,/Recovery candidate requires offline review/);
  console.log('Built API + blocked recovery startup + native SQLite/sharp wallpaper + paired backup/current and historical export + TS workspace bundle + SPA assets: passed on an empty isolated DB');
} finally {
  child.kill('SIGTERM'); await closed; rmSync(directory, { recursive: true, force: true });
}
