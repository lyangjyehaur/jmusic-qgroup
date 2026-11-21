import { randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { createApp, hash } from '../src/app';
import { shoutActors, shoutAuthorityFixture, shoutOrigin, shoutProfileId, shoutRescueKey, shoutSnapshot, shoutStamp, shoutToken } from './shout-authority-fixture';

type Headers = Record<string, string>;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'qgroup-shout-authority-')), path = join(root, 'owned.sqlite3');
  cleanup.push(async () => { rmSync(root, { recursive: true, force: true }); });
  const db = openDatabase(path); cleanup.push(async () => { db.close(); }); shoutAuthorityFixture(db);
  let clock = new Date(shoutStamp), credential = hash(shoutRescueKey);
  const app = createApp({ db, origin: shoutOrigin, now: () => clock, botEnabledDefault: false, adminCredentialHash: () => credential });
  cleanup.push(async () => { await app.close(); }); await app.ready();
  const headers = new Map<string, Headers>();
  async function access(id: string) {
    const h = headers.get(id)!;
    const response = await app.inject({ url: '/api/v2/admin/session', headers: h });
    expect(response.statusCode, response.body).toBe(200);
    h['x-admin-csrf'] = response.json().adminCsrf; h['x-admin-scope'] = response.json().scope;
  }
  async function rescue(id: string, key = shoutRescueKey) {
    const h = headers.get(id)!;
    const response = await app.inject({ method: 'POST', url: '/api/v2/admin/login', headers: h, payload: { key, confirm: true } });
    expect(response.statusCode, response.body).toBe(200);
    h.cookie = h.cookie!.split(';')[0] + '; ' + String(response.headers['set-cookie']).split(';')[0]; await access(id);
  }
  for (const a of shoutActors) {
    if (a.id === 'anonymous') { headers.set(a.id, {}); continue; }
    const cookie = a.member ? 'kanban_session=' + shoutToken(a.id) : '';
    const response = await app.inject({ url: '/api/v2/session', headers: { cookie } }); expect(response.statusCode).toBe(200);
    headers.set(a.id, { cookie: cookie || String(response.headers['set-cookie']).split(';')[0]!, origin: shoutOrigin, 'x-account-scope': response.json().scope, 'x-csrf-token': response.json().csrf });
    if (a.admin) { if (a.member) await access(a.id); else await rescue(a.id); }
  }
  const get = (id: string, url: string, patch: Headers = {}) => app.inject({ url, headers: { ...headers.get(id)!, ...patch } });
  const post = (id: string, url: string, payload: object, key = randomUUID(), patch: Headers = {}) => app.inject({ method: 'POST', url, payload, headers: { ...headers.get(id)!, 'idempotency-key': key, ...patch } });
  const publishInput = (id: string, text = 'Synthetic shout') => ({ profileId: shoutProfileId(id), musicEpoch: 0, text, confirm: true });
  const revision = (id: string) => hash(JSON.stringify(db.prepare('SELECT * FROM music_shouts WHERE id=?').get(id)));
  const deleteInput = (id: string) => ({ revision: revision(id), confirm: true });
  return { db, path, app, headers, get, post, publishInput, revision, deleteInput, access, rescue, clock: (value: string) => { clock = new Date(value); }, credential: (value: string) => { credential = hash(value); } };
}
function unchangedExcept(before: ReturnType<typeof shoutSnapshot>, after: ReturnType<typeof shoutSnapshot>, allowed: string[]) {
  expect(Object.keys(after)).toEqual(Object.keys(before));
  for (const name of Object.keys(before)) if (!allowed.includes(name)) expect(after[name], name).toEqual(before[name]);
}
const privateFields = /PRIVATE_|user_id|legacy_key|note|gender|credential|token_hash/;

describe('shout member and moderation identity matrix', () => {
  for (const a of shoutActors) for (const state of ['active', 'history', 'orphan', 'removed'] as const) it(a.id + ' / ' + state + ': member visibility and moderation use separate current authority', async () => {
    const s = await setup(), id = 'matrix-' + state, before = shoutSnapshot(s.db), allowedMember = a.member && a.music;
    const memberStatus = !a.member ? 401 : !a.music ? 403 : 200;
    for (const url of ['/api/v2/music/shouts', '/api/v2/music/shouts/history', '/api/v2/music/shouts/' + id]) {
      const r = await s.get(a.id, url), expected = allowedMember && state === 'removed' && url.endsWith(id) ? 404 : memberStatus;
      expect(r.statusCode, r.body).toBe(expected); expect(r.body).not.toMatch(privateFields);
      if (expected === 200 && url.endsWith(id)) {
        expect(r.json()).toMatchObject({ id, text: 'CONTENT_' + state, mine: a.id === 'bob' && state !== 'orphan' });
        expect(r.json().author).toEqual(state === 'orphan' ? null : { id: shoutProfileId('bob'), name: 'Music bob', contactQQ: '130001', contactSource: 'self_reported' });
        expect(r.json().name).toBe(state === 'orphan' ? 'Original author' : 'Music bob');
      }
    }
    const adminStatus = a.admin ? 200 : a.id === 'anonymous' || !a.member ? 401 : 403;
    for (const url of ['/api/v2/admin/shouts', '/api/v2/admin/shouts?period=history', '/api/v2/admin/shouts/' + id]) {
      const r = await s.get(a.id, url);
      expect(r.statusCode, r.body).toBe(a.admin && state === 'removed' && url.endsWith(id) ? 404 : adminStatus); expect(r.body).not.toMatch(privateFields);
    }
    expect(shoutSnapshot(s.db)).toEqual(before);
    const key = randomUUID(), input = state === 'removed' ? { revision: '0'.repeat(64), confirm: true } : s.deleteInput(id);
    const deleted = await s.post(a.id, '/api/v2/admin/shouts/' + id + '/delete', input, key);
    expect(deleted.statusCode, deleted.body).toBe(a.admin && state === 'removed' ? 404 : adminStatus);
    if (!a.admin || state === 'removed') { expect(shoutSnapshot(s.db)).toEqual(before); return; }
    expect(deleted.json()).toEqual({ ok: true });
    const after = shoutSnapshot(s.db);
    unchangedExcept(before, after, ['music_shouts', 'music_documents', 'migration_map', 'music_shout_deletions', 'auth_requests']);
    expect(s.db.prepare('SELECT * FROM music_shouts WHERE id=?').get(id)).toBeUndefined();
    expect(s.db.prepare("SELECT * FROM music_documents WHERE json_extract(payload_json,'$.id')=?").all(id)).toEqual([]);
    expect(s.db.prepare("SELECT status FROM migration_map WHERE target_id=?").all(id)).toEqual([{ status: 'deleted' }, { status: 'deleted' }]);
    expect(after.music_shout_deletions).toHaveLength(1); expect(after.auth_requests).toHaveLength(1);
    expect(JSON.stringify([after.music_shout_deletions, after.auth_requests])).not.toMatch(/CONTENT_|Original author|Music bob|130001|PRIVATE_/);
    expect((await s.get(a.id, '/api/v2/admin/operations/' + key)).json()).toEqual({ committed: true });
    const other = a.id === 'admin-empty' ? 'admin' : 'admin-empty';
    expect((await s.get(other, '/api/v2/admin/operations/' + key)).json()).toEqual({ committed: false });
    if (a.id === 'rescue') expect((await s.get('rescue-second', '/api/v2/admin/operations/' + key)).json()).toEqual({ committed: false });
    expect((await s.get('bob', '/api/v2/me/operations/' + key)).json()).toEqual({ committed: false });
    expect((await s.post(a.id, '/api/v2/admin/shouts/' + id + '/delete', input, key)).json()).toEqual({ ok: true });
    const conflict = await s.post(a.id, '/api/v2/admin/shouts/' + id + '/delete', { ...input, revision: '0'.repeat(64) }, key);
    expect(conflict.statusCode).toBe(409); expect(conflict.json().code).toBe('REQUEST_CONFLICT');
    expect((await s.post(a.id, '/api/v2/admin/shouts/' + id + '/delete', input)).statusCode).toBe(404);
    expect(shoutSnapshot(s.db)).toEqual(after);
  });
});

describe('shout publication authority and receipts', () => {
  for (const a of shoutActors) it(a.id + ': only current members with saved music may publish their own content', async () => {
    const s = await setup(), before = shoutSnapshot(s.db), key = randomUUID(), input = s.publishInput(a.id), r = await s.post(a.id, '/api/v2/me/music/shouts', input, key);
    const expected = !a.member ? 401 : !a.music ? 403 : a.id === 'bob' ? 429 : 200;
    expect(r.statusCode, r.body).toBe(expected);
    if (expected !== 200) { expect(r.json().code).toBe(expected === 401 ? 'LOGIN_REQUIRED' : expected === 403 ? 'MUSIC_PROFILE_REQUIRED' : 'SHOUT_COOLDOWN'); expect(shoutSnapshot(s.db)).toEqual(before); return; }
    const after = shoutSnapshot(s.db);
    unchangedExcept(before, after, ['music_shouts', 'music_shout_authors', 'request_results', 'music_profile_receipts']);
    expect(s.db.prepare('SELECT profile_id,body FROM music_shouts WHERE id=?').get(r.json().id)).toEqual({ profile_id: input.profileId, body: input.text });
    expect((await s.get(a.id, '/api/v2/me/operations/' + key)).json()).toEqual({ committed: true });
    expect((await s.get('bob', '/api/v2/me/operations/' + key)).json()).toEqual({ committed: false });
    expect((await s.post(a.id, '/api/v2/me/music/shouts', input, key)).json()).toEqual(r.json());
    const conflict = await s.post(a.id, '/api/v2/me/music/shouts', { ...input, text: 'Other content' }, key);
    expect(conflict.statusCode).toBe(409); expect(conflict.json().code).toBe('REQUEST_CONFLICT');
    expect((await s.post(a.id, '/api/v2/me/music/shouts', input)).statusCode).toBe(429);
    expect(shoutSnapshot(s.db)).toEqual(after);
  });
  for (const boundary of [
    { name: 'missing scope', patch: { 'x-account-scope': '' }, status: 409, code: 'ACCOUNT_CHANGED' },
    { name: 'foreign scope', patch: { 'x-account-scope': 'other' }, status: 409, code: 'ACCOUNT_CHANGED' },
    { name: 'missing origin', patch: { origin: '' }, status: 403, code: 'ORIGIN_REJECTED' },
    { name: 'foreign origin', patch: { origin: 'https://outside.example' }, status: 403, code: 'ORIGIN_REJECTED' },
    { name: 'invalid CSRF', patch: { 'x-csrf-token': '0'.repeat(64) }, status: 403, code: 'CSRF_REJECTED' },
  ] as { name: string; patch: Headers; status: number; code: string }[]) for (const operation of ['publish', 'delete'] as const) it(operation + ' / ' + boundary.name + ': rejects before creating content, receipt or audit', async () => {
    const s = await setup(), before = shoutSnapshot(s.db), r = operation === 'publish' ? await s.post('alice', '/api/v2/me/music/shouts', s.publishInput('alice'), randomUUID(), boundary.patch) : await s.post('admin-empty', '/api/v2/admin/shouts/matrix-active/delete', s.deleteInput('matrix-active'), randomUUID(), boundary.patch);
    expect(r.statusCode, r.body).toBe(boundary.status); expect(r.json().code).toBe(boundary.code); expect(shoutSnapshot(s.db)).toEqual(before);
  });
  it('requires current administrative CSRF even for an exact successful deletion retry', async () => {
    const s = await setup(), input = s.deleteInput('matrix-active'), key = randomUUID(), url = '/api/v2/admin/shouts/matrix-active/delete';
    expect((await s.post('admin', url, input, key)).statusCode).toBe(200); const before = shoutSnapshot(s.db);
    for (const token of ['', '0'.repeat(64), s.headers.get('rescue')!['x-admin-csrf']!]) {
      const r = await s.post('admin', url, input, key, { 'x-admin-csrf': token }); expect(r.statusCode).toBe(403); expect(r.json().code).toBe('ADMIN_CHANGED');
    }
    expect(shoutSnapshot(s.db)).toEqual(before);
  });
});

describe('shout current author projection and transaction rollback', () => {
  for (const change of ['contact', 'unlink', 'erase'] as const) it(change + ': projects current author authority without retaining hidden fields in active or historical responses', async () => {
    const s = await setup(), id = shoutProfileId('bob');
    if (change === 'contact') {
      s.db.prepare("UPDATE music_profile_fields SET name='Updated author',note='PRIVATE_UPDATED_NOTE',gender='PRIVATE_UPDATED_GENDER' WHERE profile_id=?").run(id);
      s.db.prepare("UPDATE music_profile_contacts SET contact_qq='987654',source='legacy' WHERE profile_id=?").run(id);
    } else s.db.prepare('UPDATE music_profiles SET user_id=NULL,erased_at=? WHERE id=?').run(change === 'erase' ? shoutStamp : null, id);
    const before = shoutSnapshot(s.db);
    for (const state of ['active', 'history']) {
      const result = await s.get('alice', '/api/v2/music/shouts/matrix-' + state);
      // Privacy erasure removes both active and historical rows via the schema
      // trigger; unlinking an account keeps the music identity and content.
      expect(result.statusCode, result.body).toBe(change === 'erase' ? 404 : 200); expect(result.body).not.toMatch(privateFields);
      if (result.statusCode === 200) expect(result.json().author).toEqual(change === 'erase' ? null : { id, name: change === 'contact' ? 'Updated author' : 'Music bob', contactQQ: change === 'contact' ? '987654' : '130001', contactSource: change === 'contact' ? 'legacy' : 'self_reported' });
    }
    expect(shoutSnapshot(s.db)).toEqual(before);
  });
  for (const operation of ['publish', 'delete'] as const) it(operation + ': a failed receipt insert rolls back every business, archive, migration and audit write', async () => {
    const s = await setup(), table = operation === 'publish' ? 'request_results' : 'auth_requests', key = randomUUID(), input = operation === 'publish' ? s.publishInput('alice') : s.deleteInput('matrix-active');
    s.db.exec('CREATE TRIGGER synthetic_shout_receipt BEFORE INSERT ON ' + table + " BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END");
    const before = shoutSnapshot(s.db), r = await s.post(operation === 'publish' ? 'alice' : 'admin', operation === 'publish' ? '/api/v2/me/music/shouts' : '/api/v2/admin/shouts/matrix-active/delete', input, key);
    expect(r.statusCode).toBe(500); expect(shoutSnapshot(s.db)).toEqual(before);
    s.db.exec('DROP TRIGGER synthetic_shout_receipt');
    expect((await s.post(operation === 'publish' ? 'alice' : 'admin', operation === 'publish' ? '/api/v2/me/music/shouts' : '/api/v2/admin/shouts/matrix-active/delete', input, key)).statusCode).toBe(200);
  });
});

describe('moderation receipts after authority changes', () => {
  for (const change of ['device', 'role', 'regrant', 'expiry', 'rotation', 'renewal'] as const) it(change + ': a saved receipt does not restore revoked or replaced management authority', async () => {
    const s = await setup(), who = ['expiry', 'rotation', 'renewal'].includes(change) ? 'rescue' : 'admin', key = randomUUID(), input = s.deleteInput('matrix-active'), url = '/api/v2/admin/shouts/matrix-active/delete';
    expect((await s.post(who, url, input, key)).statusCode).toBe(200); const oldScope = s.headers.get(who)!['x-admin-scope']!;
    if (change === 'device') s.db.prepare('DELETE FROM browser_sessions WHERE user_id=?').run(who);
    if (change === 'role' || change === 'regrant') s.db.prepare('UPDATE user_admin_roles SET is_admin=?,revision=revision+1 WHERE user_id=?').run(change === 'role' ? 0 : 1, who);
    if (change === 'expiry') s.clock('2026-11-17T09:00:00.000Z');
    if (change === 'rotation') s.credential('synthetic-replacement-' + 'y'.repeat(32));
    if (change === 'renewal') await s.rescue(who);
    const before = shoutSnapshot(s.db), r = await s.post(who, url, input, key);
    const expected = change === 'role' || change === 'regrant' || change === 'renewal' ? 403 : 401;
    // A renewed rescue carries fresh CSRF, so it sees missing business content,
    // never the old session's successful receipt.
    expect(r.statusCode, r.body).toBe(change === 'renewal' ? 404 : expected);
    expect(r.json().code).toBe(change === 'device' ? 'SESSION_EXPIRED' : change === 'role' || change === 'expiry' || change === 'rotation' ? 'ADMIN_REQUIRED' : change === 'renewal' ? 'SHOUT_NOT_FOUND' : 'ADMIN_CHANGED');
    const status = await s.get(who, '/api/v2/admin/operations/' + key, { 'x-admin-scope': oldScope });
    expect(status.statusCode, status.body).toBe(change === 'regrant' || change === 'renewal' ? 409 : expected);
    if (change === 'regrant' || change === 'renewal') {
      await s.access(who); expect((await s.get(who, '/api/v2/admin/operations/' + key)).json()).toEqual({ committed: false });
      expect((await s.post(who, url, input, key)).statusCode).toBe(404);
    }
    expect(shoutSnapshot(s.db)).toEqual(before);
  });
  it('revoked publisher devices cannot retrieve or replay their earlier successful publication', async () => {
    const s = await setup(), key = randomUUID(), input = s.publishInput('alice'); expect((await s.post('alice', '/api/v2/me/music/shouts', input, key)).statusCode).toBe(200);
    s.db.prepare("DELETE FROM browser_sessions WHERE user_id='alice'").run(); const before = shoutSnapshot(s.db);
    for (const r of [await s.post('alice', '/api/v2/me/music/shouts', input, key), await s.get('alice', '/api/v2/me/operations/' + key)]) { expect(r.statusCode).toBe(401); expect(r.json().code).toBe('LOGIN_REQUIRED'); }
    expect(shoutSnapshot(s.db)).toEqual(before);
  });
});

type ChildResult = { status: number; body: { id?: string; ok?: boolean; code?: string } };
function concurrentClient(path: string, token: string, command: 'publish' | 'delete', target: string, key: string, input: object) {
  const child = fork(fileURLToPath(new URL('./shout-concurrent-client.ts', import.meta.url)), [path, token, command, target, key, JSON.stringify(input)], {
    execPath: process.execPath, execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { PATH: process.env.PATH, TMPDIR: tmpdir(), NODE_ENV: 'test', TZ: 'UTC' },
  });
  let stderr = ''; child.stderr!.on('data', chunk => { stderr += chunk.toString(); });
  let readyResolve: () => void, readyReject: (e: Error) => void, resultResolve: (r: ChildResult) => void, resultReject: (e: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const result = new Promise<ChildResult>((resolve, reject) => { resultResolve = resolve; resultReject = reject; });
  // Attach rejection handlers now; assertions await the original promises.
  void ready.catch(() => {}); void result.catch(() => {});
  let reported = false;
  child.on('message', message => {
    const m = message as { type: string; pid?: number; status: number; body: ChildResult['body'] };
    if (m.type === 'ready') { expect(m.pid).toBe(child.pid); readyResolve(); }
    if (m.type === 'result') { reported = true; resultResolve({ status: m.status, body: m.body }); }
  });
  const exit = new Promise<void>((resolve, reject) => {
    child.once('error', error => { readyReject(error); resultReject(error); reject(error); });
    child.once('exit', (code, signal) => {
      if (code === 0 && !signal && reported) resolve();
      else { const error = new Error('Synthetic child failed: ' + code + '/' + signal + ' ' + stderr); readyReject(error); resultReject(error); reject(error); }
    });
  });
  void exit.catch(() => {});
  return { child, ready, result, exit };
}
async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGKILL'); await done;
}

describe('shouts across two independent API processes', () => {
  for (const scenario of ['distinct publish', 'exact publish', 'conflicting publish', 'exact delete', 'distinct delete'] as const) it(scenario + ': serializes the shared file DB and commits business effects once', async () => {
    const s = await setup(), key = randomUUID(), deleting = scenario.includes('delete'), command = deleting ? 'delete' : 'publish', target = 'matrix-active';
    const input = deleting ? s.deleteInput(target) : s.publishInput('alice'), secondKey = scenario.startsWith('distinct') ? randomUUID() : key;
    const before = shoutSnapshot(s.db);
    const clients = [
      concurrentClient(s.path, shoutToken(deleting ? 'admin-empty' : 'alice'), command, target, key, input),
      concurrentClient(s.path, shoutToken(deleting ? 'admin-empty' : 'alice'), command, target, secondKey, scenario === 'conflicting publish' ? { ...input, text: 'Competing content' } : input),
    ];
    cleanup.push(async () => { await Promise.all(clients.map(c => stopChild(c.child))); });
    await Promise.all(clients.map(c => c.ready)); expect(clients[0]!.child.pid).not.toBe(clients[1]!.child.pid);
    // No await between releases: both already-running apps compete for the DB.
    for (const client of clients) client.child.send('execute');
    const results = await Promise.all(clients.map(c => c.result)); await Promise.all(clients.map(c => c.exit));
    const status = results.map(r => r.status).sort((a, b) => a - b);
    expect(status).toEqual(scenario === 'distinct publish' ? [200, 429] : scenario === 'conflicting publish' ? [200, 409] : scenario === 'distinct delete' ? [200, 404] : [200, 200]);
    const rejected = results.find(r => r.status !== 200);
    if (rejected) expect(rejected.body.code).toBe(scenario === 'distinct publish' ? 'SHOUT_COOLDOWN' : scenario === 'conflicting publish' ? 'REQUEST_CONFLICT' : 'SHOUT_NOT_FOUND');
    const after = shoutSnapshot(s.db);
    if (deleting) {
      unchangedExcept(before, after, ['music_shouts', 'music_documents', 'migration_map', 'music_shout_deletions', 'auth_requests']);
      expect(after.music_shout_deletions).toHaveLength(1); expect(after.auth_requests).toHaveLength(1);
      expect(s.db.prepare('SELECT * FROM music_shouts WHERE id=?').get(target)).toBeUndefined();
      expect(s.db.prepare("SELECT * FROM music_documents WHERE json_extract(payload_json,'$.id')=?").all(target)).toEqual([]);
      expect(s.db.prepare('SELECT status FROM migration_map WHERE target_id=?').all(target)).toEqual([{ status: 'deleted' }, { status: 'deleted' }]);
      if (scenario === 'exact delete') expect(results[0]!.body).toEqual(results[1]!.body);
    } else {
      unchangedExcept(before, after, ['music_shouts', 'music_shout_authors', 'request_results', 'music_profile_receipts']);
      const winner = results.find(r => r.status === 200)!;
      const rows = s.db.prepare('SELECT id,body FROM music_shouts WHERE profile_id=?').all(shoutProfileId('alice')) as { id: string; body: string }[];
      expect(rows).toHaveLength(1); expect(rows[0]!.id).toBe(winner.body.id);
      expect(rows[0]!.body).toBe(scenario === 'conflicting publish' && results[1]!.status === 200 ? 'Competing content' : 'Synthetic shout');
      expect(after.request_results).toHaveLength(1); expect(after.music_profile_receipts).toHaveLength(1); expect(after.music_shout_authors).toHaveLength(1);
      if (scenario === 'exact publish') expect(results[0]!.body).toEqual(results[1]!.body);
    }
    expect(clients.every(c => c.child.exitCode === 0)).toBe(true);
  }, 30_000);
});
