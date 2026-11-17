import { afterEach, describe, expect, it, vi } from 'vitest';
import { QQBotAPI, fetchBotJSON, type BotRequest, type HTTPResult } from './api';
import { loadBotConfig } from './config';
import { createBotObserver, type LogFields } from './observability';
import { localPlatform } from '../testsupport/platform';
const config = loadBotConfig({
  QQBOT_APP_ID: 'synthetic-app',
  QQBOT_APP_SECRET: 'synthetic-secret',
  KANBAN_BOT_API_BASE: 'https://primary.invalid',
});
const token = { status: 200, data: { access_token: 'synthetic-token', expires_in: 7200 } };
const clients: QQBotAPI[] = [];
function client(request: BotRequest, options: ConstructorParameters<typeof QQBotAPI>[1] = {}) {
  const api = new QQBotAPI(
    { ...config, legacyApiBase: 'https://legacy.invalid' },
    { request, tokenHosts: ['https://token1.invalid', 'https://token2.invalid'], ...options },
  );
  clients.push(api);
  return api;
}
afterEach(() => {
  for (const api of clients.splice(0)) api.close();
  vi.restoreAllMocks();
});
describe('isolated QQ OpenAPI transport', () => {
  it('coalesces token refreshes, keeps a cancelled waiter separate and respects early expiry/minimum lifetime', async () => {
    let now = 0,
      resolve!: (result: HTTPResult) => void;
    const request = vi.fn<BotRequest>(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      ),
      api = client(request, { now: () => now });
    const cancel = new AbortController();
    const one = api.token(),
      cancelled = api.token(false, cancel.signal);
    cancel.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    resolve({ status: 200, data: { access_token: 'synthetic-token', expires_in: '180' } });
    expect(await one).toBe('synthetic-token');
    expect(await api.auth()).toBe('QQBot synthetic-token');
    expect(request).toHaveBeenCalledTimes(1);
    now = 59999;
    await api.token();
    expect(request).toHaveBeenCalledTimes(1);
    now = 60000;
    const expired = api.token();
    await new Promise((done) => setImmediate(done));
    resolve({ ...token, data: { access_token: 'next-token', expires_in: 30 } });
    expect(await expired).toBe('next-token');
    now = 119999;
    await api.token();
    expect(request).toHaveBeenCalledTimes(2);
    now = 120000;
    const minimum = api.token();
    await new Promise((done) => setImmediate(done));
    resolve(token);
    await minimum;
    expect(request).toHaveBeenCalledTimes(3);
  });
  it('falls back between token and gateway hosts, retains resolved API base and has a fixed gateway fallback', async () => {
    const calls: string[] = [];
    const api = client(async (_, url) => {
      calls.push(url);
      if (url.startsWith('https://token1')) return { status: 503, data: { code: 1 } };
      if (url.startsWith('https://token2')) return token;
      if (url.startsWith('https://primary')) return { status: 404, data: {} };
      return { status: 200, data: { url: 'wss://gateway.invalid/ws' } };
    });
    expect(await api.gateway()).toBe('wss://gateway.invalid/ws');
    expect(api.base).toBe('https://legacy.invalid');
    expect(calls).toEqual([
      'https://token1.invalid/app/getAppAccessToken',
      'https://token2.invalid/app/getAppAccessToken',
      'https://primary.invalid/gateway',
      'https://legacy.invalid/gateway',
    ]);
    const failed = client(async (_, url) => (url.includes('/app/') ? token : { status: 502, data: { raw: true } }));
    expect(await failed.gateway()).toBe('wss://api.bot.qq.com/websocket/');
    expect(failed.base).toBe('https://legacy.invalid');
  });
  it('retries authentication only once, and does not retry permanent, quota, transport or unconfirmed sends', async () => {
    for (const failure of [
      { status: 401, data: {} },
      { status: 200, data: { err_code: 11241 } },
      { status: 200, data: { code: 11242 } },
    ]) {
      let tokens = 0,
        sends = 0;
      const api = client(async (_, url) => {
        if (url.includes('/app/')) return { status: 200, data: { access_token: 'token-' + ++tokens } };
        return ++sends === 1 ? failure : { status: 200, data: { id: 'sent' } };
      });
      expect((await api.sendGroup('synthetic-group', { content: 'private message' })).ok).toBe(true);
      expect([tokens, sends]).toEqual([2, 2]);
    }
    const repeated = vi.fn<BotRequest>(async (_, url) =>
      url.includes('/app/') ? token : { status: 401, data: { err_code: 11241 } },
    );
    expect((await client(repeated).post('/test', {})).ok).toBe(false);
    expect(repeated).toHaveBeenCalledTimes(4);
    for (const [response, kind] of [
      [{ status: 200, data: { err_code: 40054010 } }, 'permanent'],
      [{ status: 429, data: {} }, 'rate_limit'],
      [{ status: 0, data: { error_type: 'TimeoutError' } }, 'transient'],
      [{ status: 202, data: { id: 'not-confirmed' } }, 'unconfirmed'],
    ] as const) {
      const request = vi.fn<BotRequest>(async (_, url) => (url.includes('/app/') ? token : response));
      const result = await client(request).post('/test', {});
      expect(result).toMatchObject({ ok: false, kind });
      expect(request).toHaveBeenCalledTimes(2);
    }
  });
  it('accepts only confirmed object responses and valid PUT ACKs, preferring nonzero err_code', async () => {
    const responses: HTTPResult[] = [
      { status: 200, data: {} },
      { status: 200, data: { code: 0 } },
      { status: 200, data: { code: 0, err_code: 40054010 } },
      { status: 200, data: [] },
      { status: 200, data: { raw: true } },
      { status: 204, data: {} },
      { status: 500, data: { code: 0 } },
    ];
    const api = client(async (_, url) => (url.includes('/app/') ? token : responses.shift()!));
    const results = [];
    for (let i = 0; i < 7; i++) results.push((await api.post('/test', {})).ok);
    expect(results).toEqual([true, true, false, false, false, false, false]);
    const request = vi.fn<BotRequest>(async (_, url) => (url.includes('/app/') ? token : { status: 204, data: {} }));
    const ack = client(request);
    expect((await ack.ackInteraction('bad/path')).ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect((await ack.ackInteraction('synthetic-interaction')).ok).toBe(true);
    expect(request.mock.calls[1]?.slice(0, 3)).toEqual([
      'PUT',
      'https://primary.invalid/interactions/synthetic-interaction',
      { code: 0 },
    ]);
    await expect(ack.post('//other.invalid', {})).rejects.toThrow();
  });
  it('keeps passive Markdown/plain payloads exclusive and uses the current group-panel schema without duplicates', async () => {
    const calls: { method: string; url: string; body: unknown }[] = [];
    let exists = false;
    const api = client(async (method, url, body) => {
      calls.push({ method, url, body });
      if (url.includes('/app/')) return token;
      if (method === 'GET') return { status: 200, data: { records: exists ? [{ scope: 'group' }] : [] } };
      return { status: 200, data: {} };
    });
    await api.replyGroup('synthetic-group', 'fallback', {
      msgId: 'source',
      eventId: 'event',
      seq: 3,
      markdown: '**synthetic**',
      keyboard: { content: { rows: [] } },
    });
    expect(calls.at(-1)?.body).toEqual({
      msg_type: 2,
      markdown: { content: '**synthetic**' },
      msg_id: 'source',
      msg_seq: 3,
      keyboard: { content: { rows: [] } },
    });
    await api.replyGroup('synthetic-group', 'plain', { eventId: 'event' });
    expect(calls.at(-1)?.body).toEqual({ msg_type: 0, content: 'plain', event_id: 'event' });
    const commands = Array.from({ length: 25 }, (_, i) => ({ name: 'cmd' + i, desc: 'description' }));
    await api.setupPanels(commands, 'synthetic-group');
    expect(calls.at(-1)?.body).toEqual({
      scope: 'group',
      panel: { items: commands.slice(0, 20).map((row) => ({ type: 'command', ...row })) },
      target_type: 'specific',
      group_openids: ['synthetic-group'],
    });
    exists = true;
    const before = calls.length;
    expect(await api.setupPanels(commands)).toBe(true);
    expect(calls.slice(before)).toHaveLength(1);
    expect(calls.at(-1)?.method).toBe('GET');
  });
  it('bounds a non-cooperative transport and stops cancelled/closed requests without a second send', async () => {
    const request = vi.fn<BotRequest>(async (_, url) => (url.includes('/app/') ? token : new Promise(() => {})));
    const api = client(request, { timeoutMs: 25 });
    const result = await api.post('/test', {});
    expect(result).toMatchObject({ ok: false, status: 0, kind: 'transient', data: { error_type: 'TimeoutError' } });
    expect(request).toHaveBeenCalledTimes(2);
    const cancel = new AbortController(),
      pending = api.post('/test', {}, cancel.signal);
    await new Promise((resolve) => setImmediate(resolve));
    cancel.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const closed = api.post('/test', {});
    await new Promise((resolve) => setImmediate(resolve));
    api.close();
    await expect(closed).rejects.toMatchObject({ name: 'AbortError' });
    await expect(api.token()).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('uses native fetch against a real local HTTP server; refuses redirects, oversized/malformed bodies and leaks no request content', async () => {
    const rows: LogFields[] = [],
      requests: { url: string; body: unknown; auth: string | undefined }[] = [];
    const server = await localPlatform((request, response) => {
      let raw = '';
      request.on('data', (data) => (raw += data));
      request.on('end', () => {
        requests.push({ url: request.url!, body: raw ? JSON.parse(raw) : null, auth: request.headers.authorization });
        response.setHeader('Content-Type', 'application/json');
        response.setHeader('X-Tps-trace-ID', 'synthetic-trace');
        if (request.url === '/app/getAppAccessToken') response.end(JSON.stringify(token.data));
        else if (request.url === '/redirect') {
          response.writeHead(302, { Location: '/should-not-follow' });
          response.end('{}');
        } else if (request.url === '/large') response.end('x'.repeat(1024 * 1024 + 1));
        else if (request.url === '/malformed') response.end('private text should not enter logs');
        else if (request.url?.startsWith('/interactions/')) {
          response.writeHead(204);
          response.end();
        } else response.end(JSON.stringify({ id: 'private-sent-id', trace_id: 'synthetic-trace' }));
      });
    });
    const api = new QQBotAPI(
      { ...config, apiBase: server.base },
      { tokenHosts: [server.base], observer: createBotObserver((row) => rows.push(row)) },
    );
    clients.push(api);
    try {
      expect((await api.replyGroup('private-group', 'private-body')).ok).toBe(true);
      expect((await api.ackInteraction('private-interaction')).ok).toBe(true);
      expect((await api.post('/malformed', {})).ok).toBe(false);
      expect((await api.post('/large', {})).ok).toBe(false);
      expect((await fetchBotJSON('GET', server.base + '/redirect', null, {}, AbortSignal.timeout(3000))).status).toBe(
        302,
      );
      expect(requests.map((row) => row.url)).not.toContain('/should-not-follow');
      expect(requests[0]?.body).toEqual({ appId: 'synthetic-app', clientSecret: 'synthetic-secret' });
      expect(requests[1]?.auth).toBe('QQBot synthetic-token');
      const logs = JSON.stringify(rows);
      for (const secret of [
        'synthetic-secret',
        'synthetic-token',
        'private-group',
        'private-interaction',
        'private-body',
        'private-sent-id',
        'private text',
      ])
        expect(logs).not.toContain(secret);
      expect(rows.some((row) => row.platform_trace === 'synthetic-trace')).toBe(true);
    } finally {
      api.close();
      await server.close();
    }
  });
});

// A reply may wait for token refresh; permission must be checked afterwards.
it('checks optional reply policy immediately before each HTTP attempt, including auth retry', async () => {
  const calls: string[] = [];
  let permitted = true;
  const api = new QQBotAPI({ appId: 'synthetic', appSecret: 'synthetic', apiBase: 'https://synthetic.invalid', legacyApiBase: 'https://synthetic.invalid' }, {
    request: async (_method, url) => {
      if (url.endsWith('/app/getAppAccessToken')) { calls.push('token'); return { status: 200, data: { access_token: 'synthetic', expires_in: 7200 } }; }
      calls.push('post'); permitted = false; return { status: 401, data: { code: 11241 } };
    },
  });
  try {
    await expect(api.replyGroup('group', 'text', { msgId: 'message', beforeSend: () => { calls.push('policy'); if (!permitted) throw Error('Policy revoked'); } })).rejects.toThrow('Policy revoked');
    expect(calls).toEqual(['token', 'policy', 'post', 'token', 'policy']);
  } finally { api.close(); }
});
