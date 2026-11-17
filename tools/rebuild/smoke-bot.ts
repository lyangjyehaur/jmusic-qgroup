import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../packages/database/src/index';
import { localPlatform, until } from '../../apps/bot/testsupport/platform';

const directory = mkdtempSync(join(tmpdir(), 'qgroup-built-bot-'));
const cwd = process.cwd(),
  nativeFetch = globalThis.fetch,
  nativeSocket = globalThis.WebSocket;
let bot: typeof import('../../apps/bot/src/index');
let outbox: typeof import('../../apps/bot/src/worker');
let replies: typeof import('../../apps/bot/src/public');
try {
  process.chdir(directory);
  globalThis.fetch = async () => {
    throw Error('Bot import must not perform HTTP requests');
  };
  globalThis.WebSocket = class {
    constructor() {
      throw Error('Bot import must not open a gateway');
    }
  } as unknown as typeof WebSocket;
  const environment = JSON.stringify(process.env);
  bot = await import(new URL('../../.rebuild-dist/bot/transport.mjs', import.meta.url).href);
  outbox = await import(new URL('../../.rebuild-dist/bot/outbox.mjs', import.meta.url).href);
  replies = await import(new URL('../../.rebuild-dist/bot/public.mjs', import.meta.url).href);
  assert.deepEqual(readdirSync(directory), []);
  assert.equal(JSON.stringify(process.env), environment);
} finally {
  process.chdir(cwd);
  globalThis.fetch = nativeFetch;
  globalThis.WebSocket = nativeSocket;
  rmSync(directory, { recursive: true, force: true });
}
const replyDirectory=mkdtempSync(join(tmpdir(),'qgroup-built-replies-'));
try {
  const path=join(replyDirectory,'space ? state.sqlite3'),db=openDatabase(path);
  try {
    db.exec("INSERT INTO users(id,token_hash,nickname,created_at) VALUES('synthetic-user','synthetic-hash','synthetic','before'); INSERT INTO events(id,owner_id,title,category,location,starts_at,deadline,capacity,description,status,created_at,visibility,lifecycle,timezone,bot_enabled) VALUES('abcdef1234567890','synthetic-user','built public reply','其他','synthetic location','2099-11-19T10:00:00Z','2099-11-18T10:00:00Z',10,'','open','before','public','scheduled','Asia/Taipei',0)");
    assert.deepEqual(replies!.parseBotCommand('<@synthetic> /名額 abcdef12'),['名额','abcdef12']);
    const reply=replies!.readPublicBotReply(path,'名额','abcdef12',{baseURL:'https://example.test'});
    assert.match(reply.text,/built public reply/);assert.match(reply.text,/上限 10/);
    assert.match(reply.markdown!,/## \/名额/);assert.equal(reply.keyboard,null);
    assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM bot_outbox').get(),{n:0});
    db.exec('UPDATE rebuild_storage SET recovery_required=1');
    assert.throws(()=>replies!.readPublicBotReply(path,'帮助'),/Recovery candidate/);
  } finally {db.close();}
} finally {rmSync(replyDirectory,{recursive:true,force:true});}
let posts = 0;
let outboxPosts = 0;
const platform = await localPlatform((request, response) => {
  let text = '';
  request.on('data', (chunk) => {
    text += chunk;
  });
  request.on('end', () => {
    const body = text ? JSON.parse(text) : null;
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/app/getAppAccessToken') {
      assert.deepEqual(body, { appId: 'synthetic-app', clientSecret: 'synthetic-secret' });
      response.end(JSON.stringify({ access_token: 'synthetic-token', expires_in: 7200 }));
    } else if (request.url === '/gateway') response.end(JSON.stringify({ url: platform.ws }));
    else if (request.url === '/v2/groups/synthetic-group/messages') {
      posts++;
      assert.equal(request.headers.authorization, 'QQBot synthetic-token');
      assert.deepEqual(body, { msg_type: 0, content: 'synthetic', msg_id: 'synthetic-message', msg_seq: 1 });
      response.writeHead(202);
      response.end('{"id":"unconfirmed"}');
    } else if (request.url === '/v2/groups/outbox-group/messages') {
      outboxPosts++;
      assert.deepEqual(body, { msg_type: 0, content: 'built outbox synthetic' });
      response.writeHead(202);
      response.end('{"id":"unconfirmed-outbox"}');
    } else {
      response.writeHead(404);
      response.end('{}');
    }
  });
});
const config = bot!.loadBotConfig({
  QQBOT_APP_ID: 'synthetic-app',
  QQBOT_APP_SECRET: 'synthetic-secret',
  KANBAN_BOT_API_BASE: platform.base,
});
const api = new bot!.QQBotAPI(config, { tokenHosts: [platform.base] });
const stop = new AbortController(),
  events: string[] = [];
const gateway = new bot!.QQGateway({
  api,
  intents: 0,
  allowLoopback: true,
  onDispatch: async (event) => {
    events.push(event.t);
  },
});
const work = gateway.run(stop.signal);
void work.catch(() => {});
try {
  await until(() => platform.peers.length === 1);
  platform.peers[0]!.send({ op: 10, d: { heartbeat_interval: 1000 } });
  await until(() => platform.peers[0]!.frames.length === 1);
  assert.equal(platform.peers[0]!.frames[0]!.op, 2);
  platform.peers[0]!.send({ op: 0, t: 'READY', s: 1, d: { session_id: 'synthetic-session' } });
  await until(() => gateway.state().connected);
  platform.peers[0]!.send({ op: 1 });
  await until(() => platform.peers[0]!.frames.some((frame) => frame.op === 1));
  platform.peers[0]!.send({ op: 11 });
  await until(() => gateway.state().last_ack !== null);
  assert.equal(
    (await api.replyGroup('synthetic-group', 'synthetic', { msgId: 'synthetic-message' })).kind,
    'unconfirmed',
  );
  assert.equal(posts, 1);
  platform.peers[0]!.close(4009);
  await until(() => platform.peers.length === 2, 5000);
  platform.peers[1]!.send({ op: 10, d: { heartbeat_interval: 1000 } });
  await until(() => platform.peers[1]!.frames.length === 1);
  assert.deepEqual(platform.peers[1]!.frames[0], {
    op: 6,
    d: { token: 'QQBot synthetic-token', session_id: 'synthetic-session', seq: 1 },
  });
  platform.peers[1]!.send({ op: 0, t: 'RESUMED', s: 2, d: {} });
  await until(() => gateway.state().sequence === 2);
  assert.deepEqual(events, ['READY', 'RESUMED']);
  const outboxDirectory = mkdtempSync(join(tmpdir(), 'qgroup-built-outbox-'));
  const db = openDatabase(join(outboxDirectory, 'synthetic.sqlite3'));
  try {
    db.exec(`INSERT INTO users(id,token_hash,nickname,created_at) VALUES('owner','synthetic-token','合成使用者','before');
      INSERT INTO events(id,owner_id,title,category,location,starts_at,deadline,capacity,description,status,created_at,bot_enabled)
      VALUES('event','owner','合成活動','其他','合成地點','2099-01-01','2098-12-31',10,'','open','before',1)`);
    const policy = {
      enabled: true,
      groups: [{ id: 'outbox-group', name: '', replies: true, broadcast: true }],
    };
    db.prepare('UPDATE bot_settings SET config_json=?').run(JSON.stringify(policy));
    const enqueue = db.prepare(
      "INSERT INTO bot_outbox(event_id,kind,dedupe_key,channel,target,payload_json,status,created_at) VALUES('event','activity_published',?,'group','outbox-group',?,'pending','before')",
    );
    enqueue.run('real', JSON.stringify({ text: 'built outbox synthetic' }));
    const consumer = new outbox!.BotOutboxWorker(
      db,
      { ...config, group: 'outbox-group', dryRun: false, logDirectory: join(outboxDirectory, 'logs') },
      api,
    );
    assert.equal((await consumer.pollOnce()).skipped, 1);
    assert.equal((await consumer.pollOnce()).claimed, 0);
    assert.equal(outboxPosts, 1);
    assert.match(
      (db.prepare('SELECT last_error FROM bot_outbox').get() as { last_error: string }).last_error,
      /未确认/,
    );
    db.prepare('UPDATE bot_settings SET config_json=?').run(JSON.stringify({ ...policy, dry_run: true }));
    enqueue.run('simulation', JSON.stringify({ text: 'built outbox synthetic' }));
    assert.equal((await consumer.pollOnce()).simulated, 1);
    assert.equal(outboxPosts, 1);
    const simulation = db
      .prepare(
        "SELECT status,sent_at,simulated_at,delivered_payload_json FROM bot_outbox WHERE dedupe_key='simulation'",
      )
      .get() as {
      status: string;
      sent_at: string | null;
      simulated_at: string | null;
      delivered_payload_json: string;
    };
    assert.equal(simulation.status, 'skipped');
    assert.equal(simulation.sent_at, null);
    assert(simulation.simulated_at);
    assert.equal(JSON.parse(simulation.delivered_payload_json).content, 'built outbox synthetic');
    db.exec('UPDATE rebuild_storage SET recovery_required=1');
    await assert.rejects(consumer.pollOnce(), /Recovery candidate requires offline review/);
  } finally {
    db.close();
    rmSync(outboxDirectory, { recursive: true, force: true });
  }
  console.log(
    'Built TS bot transport/outbox/public replies: inert imports + local native HTTP/WebSocket + ACK + Resume + durable unconfirmed/simulation + read-only public query + recovery block passed; no production worker or QQ delivery started',
  );
} finally {
  stop.abort();
  await work;
  api.close();
  await platform.close();
}
