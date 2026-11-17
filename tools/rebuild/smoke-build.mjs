import { Worker } from 'node:worker_threads';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import sharp from 'sharp';
const botSmoke = spawnSync(process.execPath, ['--import', 'tsx', 'tools/rebuild/smoke-bot.ts'], {
  encoding: 'utf8', timeout: 15000, env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
});
assert.equal(botSmoke.status, 0, botSmoke.stderr || botSmoke.stdout);process.stdout.write(botSmoke.stdout);
const rescueKey='synthetic-built-wallpaper-rescue-'+randomUUID();
const partnerKey='synthetic_built_partner_'+randomUUID().replaceAll('-','');
const directory = realpathSync(mkdtempSync(join(tmpdir(), 'qgroup-built-')));
const port = 5084;
const child = spawn(process.execPath, ['.rebuild-dist/api/start.mjs'], { env: { ...process.env, KANBAN_PUBLIC_API_KEYS: partnerKey, REBUILD_ADMIN_KEY_HASH: createHash('sha256').update(rescueKey).digest('hex'), REBUILD_QQ_APP_ID: '', REBUILD_QQ_APP_KEY: '', REBUILD_DB: join(directory, 'empty.sqlite3'), REBUILD_PORT: String(port), REBUILD_ORIGIN: `http://127.0.0.1:${port}` }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  for(const alias of ['/music/index.html','/music/admin.html','/music/privacy.html','/privacy.html','/contact.html']){
    const response=await fetch(base+alias);assert.equal(response.status,200);assert.equal(await response.text(),html);
  }
  for(const path of ['/music/api/me','/music/api/admin/members','/music/api/export','/unknown.html']){
    const response=await fetch(base+path,{headers:{'X-Music-Proxy-Key':'forged','X-Music-Identity':'forged'}});assert.equal(response.status,404);assert.equal((await response.json()).code,'NOT_FOUND');
  }
  const worker = new Worker(new URL('../../.rebuild-dist/api/music-room-worker.mjs', import.meta.url), {
    workerData: {
      input: { command: 'split', sourceVersion: 'a'.repeat(64), selected: ['one', 'two', 'three'], config: { mode: 'sizes', sizes: [1, 2] }, sameGender: false },
      members: ['one', 'two', 'three'].map(id => ({ id, name: id, selections: [] })), entries: [],
    },
  });
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Built room worker timed out')), 5000);
      worker.once('message', message => { clearTimeout(timer); resolve(message); });
      worker.once('error', error => { clearTimeout(timer); reject(error); });
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.result.rooms.flatMap(room => room.members).sort(), ['one', 'three', 'two']);
    assert(result.result.rooms.every(room => room.members.length <= room.capacity));
  } finally { await worker.terminate(); }
  const unknown = await fetch(base + '/api/v2/missing'); assert.equal(unknown.status, 404);
  const activities = await fetch(base + '/api/v2/activities'); assert.equal(activities.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await activities.json()).events, []);
  const partnerHeaders={Authorization:'Bearer '+partnerKey};
  const partnerUnauthorized=await fetch(base+'/api/public/v1/events?disguised='+partnerKey);assert.equal(partnerUnauthorized.status,401);assert.equal(partnerUnauthorized.headers.get('www-authenticate'),'Bearer realm="qgroup-partner-api"');assert.equal(partnerUnauthorized.headers.get('set-cookie'),null);await partnerUnauthorized.arrayBuffer();
  const partnerIndex=await fetch(base+'/api/public/v1',{headers:partnerHeaders});assert.equal(partnerIndex.status,200);assert.equal((await partnerIndex.json()).identity.account,'user_id');
  const partner=await fetch(base+'/api/public/v1/events',{headers:{...partnerHeaders,Origin:'https://partner.example'}});assert.equal(partner.status,200);assert.equal(partner.headers.get('cache-control'),'no-store');assert.equal(partner.headers.get('access-control-allow-origin'),null);assert.equal(partner.headers.get('set-cookie'),null);assert.deepEqual(await partner.json(),{api_version:1,events:[],total:0,limit:20,offset:0,next_offset:null});
  const partnerHead=await fetch(base+'/api/public/v1/events',{method:'HEAD',headers:partnerHeaders});assert.equal(partnerHead.status,200);assert.equal(await partnerHead.text(),'');
  const partnerWrite=await fetch(base+'/api/public/v1/events',{method:'POST',headers:partnerHeaders});assert.equal(partnerWrite.status,405);assert.equal(partnerWrite.headers.get('allow'),'GET, HEAD, OPTIONS');await partnerWrite.arrayBuffer();
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
  const botPage=await fetch(base+'/admin/bot');assert.equal(botPage.status,200);await botPage.arrayBuffer();
  const policyResponse=await fetch(base+'/api/v2/admin/bot',{headers:readHeaders});assert.equal(policyResponse.status,200);assert.equal(policyResponse.headers.get('cache-control'),'no-store');
  const policy=await policyResponse.json();assert.equal(policy.revision,0);assert.equal(policy.config.enabled,false);assert.equal(policy.runtime.applied_revision,null);
  const deliveriesPage=await fetch(base+'/admin/bot/deliveries');assert.equal(deliveriesPage.status,200);await deliveriesPage.arrayBuffer();
  const deliveries=await fetch(base+'/api/v2/admin/bot/deliveries',{headers:readHeaders});assert.equal(deliveries.status,200);assert.equal(deliveries.headers.get('cache-control'),'no-store');assert.deepEqual(await deliveries.json(),{entries:[],nextBefore:null,mode:'inherit'});
  const forbiddenDeliveries=await fetch(base+'/api/v2/admin/bot/deliveries');assert.equal(forbiddenDeliveries.status,401);await forbiddenDeliveries.arrayBuffer();
  const syntheticPreview=await fetch(base+'/api/v2/admin/bot/preview',{method:'POST',headers:{...headers,Cookie:cookie,'X-Admin-CSRF':access.adminCsrf},body:JSON.stringify({config:policy.config,kind:'activity_published'})});
  assert.equal(syntheticPreview.status,200);assert((await syntheticPreview.json()).text.includes('周末聚餐'));
  const unchangedPolicy=await(await fetch(base+'/api/v2/admin/bot',{headers:readHeaders})).json();assert.deepEqual(unchangedPolicy,policy);
  const id=backups.backups[0].id;
  const proof=JSON.parse(readFileSync(join(directory,'paired-backups',id,'manifest.json'),'utf8'));assert.equal(proof.restoreEligible,false);assert.equal(proof.version,2);assert.equal(proof.schema,14);assert.match(proof.lineageId,/^[a-f0-9]{32}$/);assert(proof.files.some(file=>file.path==='state.sqlite3'));
  for(const path of ['/api/v2/admin/music-export','/api/v2/admin/music-export?backup='+id]){const exported=await fetch(base+path,{headers:readHeaders});assert.equal(exported.status,200);assert.equal(exported.headers.get('cache-control'),'no-store');const data=await exported.json();assert.deepEqual({...data,trend:[]},{entries:{},members:{},settings:{},shouts:[],shoutHistory:[],trend:[]});assert.equal(data.trend.length,1);assert.deepEqual(data.trend[0].counts,{});assert(Number.isSafeInteger(data.trend[0].t));}
  const callback = await fetch(base + '/auth/qq/callback?state=invalid&code=synthetic', { redirect: 'manual' });
  assert.equal(callback.status, 303); assert.equal(callback.headers.get('location'), '/auth/confirm?status=invalid');
  child.kill('SIGTERM'); await closed;
  assert(!logs.includes(partnerKey),'Partner credentials must not enter request logs');
  // Only immutable native archives and new synthetic evidence are passed to the
  // offline CLI after the synthetic server has stopped. No bot runs here.
  const evidence=join(directory,'evidence'),candidate=join(directory,'candidate');mkdirSync(evidence);writeFileSync(join(directory,'empty.erasures.jsonl'),'');
  const archive=join(directory,'paired-backups',id);
  const recovered=spawnSync(process.execPath,['--import','tsx','tools/rebuild/restore-backup.ts',archive,archive,join(directory,'empty.erasures.jsonl'),evidence,candidate,'--quiescent-copy'],{encoding:'utf8'});
  assert.equal(recovered.status,0,recovered.stderr);assert.equal(JSON.parse(recovered.stdout).recoveryRequired,true);
  const blocked=spawnSync(process.execPath,['.rebuild-dist/api/start.mjs'],{env:{...process.env,REBUILD_DB:join(candidate,'unified.sqlite3'),REBUILD_PORT:String(port)},encoding:'utf8',timeout:10000});
  assert.equal(blocked.status,1);assert.match(blocked.stderr,/Recovery candidate requires offline review/);
  console.log('Built API + bot policy/isolated preview + bounded room worker + blocked recovery startup + native SQLite/sharp wallpaper + paired backup/current and historical export + TS workspace bundle + SPA assets: passed on an empty isolated DB');
} finally {
  child.kill('SIGTERM'); await closed; rmSync(directory, { recursive: true, force: true });
}
