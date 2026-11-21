import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '@qgroup/database';
import { createApp } from './app';
import { registerHttpResponseValidation } from './http-responses';
import { fixture } from '../testsupport/fixture';

async function wire(url: string, body: string | Buffer, mime: string, status = 200, disposition?: string) {
  const app = Fastify();
  registerHttpResponseValidation(app);
  app.setErrorHandler((_error, _request, reply) => reply.code(500).send({ code: 'INTERNAL_ERROR' }));
  app.get(url, async (_request, reply) => {
    if (disposition) reply.header('Content-Disposition', disposition);
    return reply.code(status).type(mime).send(body);
  });
  try { return await app.inject({ url: url.replace(/:[^/]+/g, 'synthetic') }); }
  finally { await app.close(); }
}

it('validates the actual JSON wire without replacing whitespace, extensions or user text', async () => {
  const raw = '  { "nickname": "后台發 · 帐号後臺", "revision": 7, "legacyField": {"raw":"帳號"} }\n';
  const response = await wire('/api/v2/me/profile', raw, 'application/json; charset=utf-8');
  expect(response.statusCode).toBe(200);expect(response.body).toBe(raw);
});
it.each([
  ['{"nickname":7,"revision":1}', 'application/json'],
  ['{"nickname":"valid","revision":-1}', 'application/json'],
  ['<html>private diagnostic</html>', 'application/json'],
  ['{"nickname":"valid","revision":1}', 'text/plain'],
])('treats an invalid success representation as a server error without exposing it (%s)', async (body, mime) => {
  const response = await wire('/api/v2/me/profile', body, mime);
  expect(response.statusCode).toBe(500);expect(response.json()).toEqual({ code: 'INTERNAL_ERROR' });
  expect(response.body).not.toContain('private diagnostic');
});
it('accepts an absent music profile and preserves rejected responses and unrelated provider endpoints', async () => {
  expect((await wire('/api/v2/me/music', 'null', 'application/json')).body).toBe('null');
  const failure = '{"code":"FORBIDDEN","message":"原錯誤"}';
  const rejected = await wire('/api/v2/me/profile', failure, 'application/json', 403);
  expect(rejected.statusCode).toBe(403);expect(rejected.body).toBe(failure);
  const unrelated = await wire('/api/public/v1/fixture', 'provider wire', 'text/plain');
  expect(unrelated.statusCode).toBe(200);expect(unrelated.body).toBe('provider wire');
});
it('preserves image bytes and media type while rejecting an empty or mislabeled success', async () => {
  const raw = Buffer.from([137, 80, 78, 71, 0, 255]);
  const response = await wire('/api/v2/me/payment-codes/:codeId/image', raw, 'image/png');
  expect(response.statusCode).toBe(200);expect(response.rawPayload).toEqual(raw);
  expect(response.headers['content-type']).toBe('image/png');
  expect((await wire('/api/v2/me/payment-codes/:codeId/image', raw, 'image/svg+xml')).statusCode).toBe(500);
  expect((await wire('/api/v2/me/payment-codes/:codeId/image', Buffer.alloc(0), 'image/png')).statusCode).toBe(500);
});
it('keeps a JSON attachment byte-for-byte and checks its syntax and attachment disposition', async () => {
  const raw = '{\n  "legacy": {"arbitrary": "original user extension"}\n}\n';
  const response = await wire('/api/v2/admin/music-export', raw, 'application/json', 200, 'attachment; filename="fixture.json"');
  expect(response.statusCode).toBe(200);expect(response.body).toBe(raw);
  expect(response.headers['content-disposition']).toBe('attachment; filename="fixture.json"');
  expect((await wire('/api/v2/admin/music-export', raw, 'application/json')).statusCode).toBe(500);
  expect((await wire('/api/v2/admin/music-export', '<html>', 'application/json', 200, 'attachment')).statusCode).toBe(500);
});
it('retains completed business records and the original receipt when its stored response is invalid', async () => {
  const db = openDatabase(':memory:');fixture(db);
  const origin = 'https://fixture.invalid', app = createApp({ db, origin, now: () => new Date('2026-11-17T08:00:00Z'), musicTrendSampling: false, pairedBackupScheduling: false });
  try {
    await app.ready();
    const viewer = (await app.inject({ url: '/api/v2/session', headers: { cookie: 'kanban_session=fixture-alice' } })).json();
    const key = randomUUID(), headers = { cookie: 'kanban_session=fixture-alice', origin, 'x-account-scope': viewer.scope, 'x-csrf-token': viewer.csrf, 'idempotency-key': key };
    const payload = { nickname: '原操作稱呼', revision: 0 }, send = () => app.inject({ method: 'PUT', url: '/api/v2/me/profile', headers, payload });
    const saved = await send();expect(saved.statusCode).toBe(200);
    db.prepare('UPDATE request_results SET response_json=? WHERE user_id=? AND request_key=?').run('{"nickname":7,"revision":1}', 'alice', key);
    const before = ['users', 'account_audit', 'request_results'].map(table => db.prepare('SELECT * FROM ' + table).all());
    const replay = await send();expect(replay.statusCode).toBe(500);expect(replay.json()).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(['users', 'account_audit', 'request_results'].map(table => db.prepare('SELECT * FROM ' + table).all())).toEqual(before);
    const current = await app.inject({ url: '/api/v2/me/profile', headers });expect(current.statusCode).toBe(200);expect(current.json().nickname).toBe(payload.nickname);
    const denied = await app.inject({ method: 'PUT', url: '/api/v2/me/profile', headers: { ...headers, 'x-csrf-token': 'wrong' }, payload });
    expect(denied.statusCode).toBe(403);expect(['users', 'account_audit', 'request_results'].map(table => db.prepare('SELECT * FROM ' + table).all())).toEqual(before);
  } finally { await app.close();db.close(); }
});
