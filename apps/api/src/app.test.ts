import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { randomUUID } from 'node:crypto';
import { createApp, hash } from './app';
import { fixture } from '../testsupport/fixture';

const resources: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close(); });
async function setup() {
  const db = openDatabase(':memory:'); fixture(db);
  const app = createApp({ db, origin: 'http://localhost:5080', now: () => new Date('2026-11-17T08:00:00Z') });
  await app.ready(); resources.push(async () => { await app.close(); db.close(); });
  const session = (await app.inject({ url: '/api/v2/session', headers: { cookie: 'kanban_session=fixture-alice' } })).json();
  const headers = { cookie: 'kanban_session=fixture-alice', origin: 'http://localhost:5080', 'x-account-scope': session.scope, 'x-csrf-token': session.csrf, 'idempotency-key': randomUUID() };
  const payload = { profileId: null, musicEpoch: 0, revision: 0, selections: [{ entryId: 'main-0', level: 3 }] };
  const save = (body: unknown = payload, override: Record<string, string> = {}) => app.inject({ method: 'PUT', url: '/api/v2/me/music', payload: body as object, headers: { ...headers, ...override } });
  return { app, db, headers, payload, save };
}
describe('unified public and music API', () => {
  it('browses without creating accounts; hides private/draft/deleted details consistently', async () => {
    const { app, db } = await setup();
    const count = db.prepare('SELECT count(*) n FROM users').get();
    const session = await app.inject('/api/v2/session'); expect(session.json()).toMatchObject({ authenticated: false, qqEnabled: false, privacyAccepted: false });
    expect(session.headers['set-cookie']).toContain('HttpOnly');
    expect(db.prepare('SELECT count(*) n FROM visitor_sessions').get()).toEqual({ n: 1 });
    expect(session.headers['cache-control']).toBe('no-store');
    const listing = (await app.inject('/api/v2/activities')).json();
    expect(listing.events.map((e: { id: string }) => e.id)).toEqual(['karaoke', 'listen']);
    for (const id of ['invite', 'draft', 'deleted', 'missing']) {
      const response = await app.inject('/api/v2/activities/' + id);
      expect(response.statusCode).toBe(404); expect(response.json()).toEqual({ code: 'NOT_FOUND', message: '找不到活動或尚未公開', messageDisplay: {hans:'找不到活动或尚未公开',hant:'找不到活動或尚未公開'} });
    }
    expect((await app.inject('/api/v2/activities?period=history')).json().events.map((e: { id: string }) => e.id)).toEqual(['past']);
    expect(JSON.stringify(listing)).not.toMatch(/owner_id|token|user_id/);
    expect(db.prepare('SELECT count(*) n FROM users').get()).toEqual(count);
    expect((await app.inject('/api/v2/activities?page=1.1')).statusCode).toBe(400);
  });
  it('uses one session and atomically saves profile, history and retry result', async () => {
    const { app, db, save, headers, payload } = await setup();
    const first = await save(); expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ revision: 1, selections: payload.selections });
    expect((await save()).json()).toEqual(first.json());
    expect(db.prepare('SELECT count(*) n FROM music_profile_audit').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT count(*) n FROM request_results').get()).toEqual({ n: 1 });
    expect((await app.inject({ url: '/api/v2/me/music', headers })).json()).toEqual(first.json());
    const bob = (await app.inject({ url: '/api/v2/session', headers: { cookie: 'kanban_session=fixture-bob' } })).json();
    expect((await app.inject({ url: '/api/v2/me/music', headers: { cookie: 'kanban_session=fixture-bob', 'x-account-scope': bob.scope } })).json()).toBeNull();
    expect((await app.inject({ url: '/api/v2/me/music', headers: { ...headers, cookie: 'kanban_session=fixture-bob' } })).statusCode).toBe(409);
    expect((await save({ ...payload, selections: [{ entryId: 'main-1', level: 4 }] })).statusCode).toBe(409);
    expect((await save(payload, { 'idempotency-key': randomUUID() })).statusCode).toBe(409);
    expect((await save({ profileId: first.json().id, musicEpoch: 0, revision: 1, selections: [{ entryId: 'sub-1', level: 4 }] }, { 'idempotency-key': randomUUID() })).json().revision).toBe(2);
    expect(() => db.prepare('DELETE FROM music_profile_audit').run()).toThrow('append-only');
  });
  it('rejects anonymous, forged cross-site, stale account, expired CSRF and revoked replay', async () => {
    const { save, db } = await setup();
    expect((await save(undefined, { cookie: '' })).statusCode).toBe(401);
    expect((await save(undefined, { origin: 'http://evil.test' })).statusCode).toBe(403);
    expect((await save(undefined, { 'x-csrf-token': 'a'.repeat(64) })).statusCode).toBe(403);
    expect((await save(undefined, { 'x-account-scope': 'another-account' })).statusCode).toBe(409);
    expect((await save()).statusCode).toBe(200);
    db.prepare('DELETE FROM browser_sessions WHERE token_hash=?').run(hash('fixture-alice'));
    expect((await save()).statusCode).toBe(401);
    expect(db.prepare('SELECT count(*) n FROM music_profiles').get()).toEqual({ n: 1 });
  });
  it('blocks erased identity and switched account even for a previously successful request', async () => {
    const { save, db } = await setup();
    expect((await save()).statusCode).toBe(200);
    db.prepare("UPDATE browser_sessions SET user_id='bob' WHERE token_hash=?").run(hash('fixture-alice'));
    expect((await save()).statusCode).toBe(409);
    db.prepare("UPDATE browser_sessions SET user_id='alice' WHERE token_hash=?").run(hash('fixture-alice'));
    db.prepare("INSERT INTO privacy_requests VALUES('erased','alice','pending','now','now','')").run();
    expect((await save()).statusCode).toBe(401);
  });
  it('validates exact limits, duplicate/unknown entries and levels before writing', async () => {
    const { save, db } = await setup();
    for (const selections of [[], [{ entryId: 'unknown', level: 3 }], [{ entryId: 'main-0', level: 0 }], [{ entryId: 'main-0', level: 3 }, { entryId: 'main-0', level: 4 }], Array.from({ length: 6 }, (_, i) => ({ entryId: 'main-' + i, level: 3 })), Array.from({ length: 16 }, (_, i) => ({ entryId: 'sub-' + i, level: 3 }))]) {
      expect((await save({ profileId: null, musicEpoch: 0, revision: 0, selections })).statusCode).toBe(400);
    }
    expect(db.prepare('SELECT count(*) n FROM music_profiles').get()).toEqual({ n: 0 });
    const selections = [...Array.from({ length: 5 }, (_, i) => ({ entryId: 'main-' + i, level: 4 })), ...Array.from({ length: 15 }, (_, i) => ({ entryId: 'sub-' + i, level: 1 }))];
    expect((await save({ profileId: null, musicEpoch: 0, revision: 0, selections })).statusCode).toBe(200);
  });
  it('rolls back the mutation if audit fails; two competing revisions yield one winner', async () => {
    const { save, db } = await setup();
    db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON music_profile_audit BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
    const failed = await save(); expect(failed.statusCode).toBe(500); expect(failed.body).not.toContain('synthetic');
    expect(db.prepare('SELECT count(*) n FROM music_profiles').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) n FROM request_results').get()).toEqual({ n: 0 });
    db.exec('DROP TRIGGER reject_audit');
    const responses = await Promise.all([save(undefined, { 'idempotency-key': randomUUID() }), save(undefined, { 'idempotency-key': randomUUID() })]);
    expect(responses.map(r => r.statusCode).sort()).toEqual([200, 409]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
