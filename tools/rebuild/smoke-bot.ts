import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localPlatform, until } from '../../apps/bot/testsupport/platform';

const directory = mkdtempSync(join(tmpdir(), 'qgroup-built-bot-'));
const cwd = process.cwd(),
  nativeFetch = globalThis.fetch,
  nativeSocket = globalThis.WebSocket;
let bot: typeof import('../../apps/bot/src/index');
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
  assert.deepEqual(readdirSync(directory), []);
  assert.equal(JSON.stringify(process.env), environment);
} finally {
  process.chdir(cwd);
  globalThis.fetch = nativeFetch;
  globalThis.WebSocket = nativeSocket;
  rmSync(directory, { recursive: true, force: true });
}
let posts = 0;
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
  console.log(
    'Built TS bot transport: inert import + local native HTTP/WebSocket + ACK + Resume + unconfirmed-send preservation passed; no worker or real delivery started',
  );
} finally {
  stop.abort();
  await work;
  api.close();
  await platform.close();
}
