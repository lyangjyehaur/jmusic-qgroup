import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { createApp, hash } from './app';
import { fixture } from '../testsupport/fixture';
import { nicknameFixture } from '../testsupport/nickname-fixture';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const origin = 'https://rebuild.example'; const stamp = '2026-11-17T08:00:00.000Z';
async function setup() {
  const db = openDatabase(':memory:'); fixture(db); nicknameFixture(db);
  const app = createApp({ db, origin, now: () => new Date(stamp) }); await app.ready();
  cleanup.push(async () => { await app.close(); db.close(); });
  const viewer = (await app.inject({ url: '/api/v2/session', headers: { cookie: 'kanban_session=fixture-alice' } })).json();
  const headers = { cookie: 'kanban_session=fixture-alice', origin, 'x-account-scope': viewer.scope, 'x-csrf-token': viewer.csrf, 'idempotency-key': randomUUID() };
  const save = (payload: object = { nickname: '新稱呼', revision: 0 }, extra: Record<string, string> = {}) => app.inject({ method: 'PUT', url: '/api/v2/me/profile', headers: { ...headers, ...extra }, payload });
  const read = () => app.inject({ url: '/api/v2/me/profile', headers });
  return { db, app, headers, viewer, save, read };
}
describe('stable account nickname, exact roster history and retry receipts', () => {
  it('keeps account, QQ identity, frozen attendance and money while updating current display and per-event audit', async () => {
    const s = await setup();
    const frozen = ['attendees', 'finance_entries', 'settlements', 'roster_parties'];
    const before = frozen.map(table => s.db.prepare('SELECT * FROM ' + table).all());
    expect((await s.read()).json()).toEqual({ nickname: '小青', revision: 0 });
    const result = await s.save(); expect(result.statusCode).toBe(200); expect(result.json()).toMatchObject({ nickname: '新稱呼' }); expect(result.json().revision).toBeGreaterThan(0);
    expect(frozen.map(table => s.db.prepare('SELECT * FROM ' + table).all())).toEqual(before);
    expect(s.db.prepare("SELECT revision FROM events WHERE id='karaoke'").get()).toEqual({ revision: 0 });
    const rows = s.db.prepare('SELECT actor_name,before_json,after_json FROM event_audit').all() as { actor_name: string; before_json: string; after_json: string }[];
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.actor_name).toBe('小青');
      expect(JSON.parse(row.before_json).participants).toHaveLength(3);
      expect(JSON.parse(row.after_json).participants).toHaveLength(3);
      expect(JSON.parse(row.after_json).participants.every((p: { manager_name: string }) => p.manager_name === '新稱呼')).toBe(true);
    }
    expect((await s.app.inject({ url: '/api/v2/session', headers: s.headers })).json()).toMatchObject({ nickname: '新稱呼', scope: s.viewer.scope });
    expect(s.db.pragma('foreign_key_check')).toEqual([]);
  });
  it('deduplicates retries, rejects key conflicts, detects stale/ABA edits and preserves newer names on an old receipt', async () => {
    const s = await setup(); const one = await s.save();
    expect((await s.save()).json()).toEqual(one.json());
    expect((await s.save({ nickname: '另一稱呼', revision: 0 })).statusCode).toBe(409);
    expect((await s.save({ nickname: '另一稱呼', revision: 0 }, { 'idempotency-key': randomUUID() })).json().code).toBe('PROFILE_CHANGED');
    const two = await s.save({ nickname: '小青', revision: one.json().revision }, { 'idempotency-key': randomUUID() });
    expect(two.statusCode).toBe(200); expect(two.json().revision).toBeGreaterThan(one.json().revision);
    expect((await s.save({ nickname: 'stale ABA', revision: 0 }, { 'idempotency-key': randomUUID() })).statusCode).toBe(409);
    expect((await s.save()).json()).toEqual(one.json());
    expect((await s.read()).json()).toEqual(two.json());
    expect(s.db.prepare("SELECT count(*) n FROM account_audit WHERE action='nickname_changed'").get()).toEqual({ n: 2 });
    expect(s.db.prepare('SELECT count(*) n FROM event_audit').get()).toEqual({ n: 10 });
  });
  it('makes unchanged names a no-op, counts Unicode code points and serializes competing revisions', async () => {
    const s = await setup(); expect((await s.save({ nickname: ' 小青 ', revision: 0 })).json()).toEqual({ nickname: '小青', revision: 0 });
    expect(s.db.prepare('SELECT count(*) n FROM event_audit').get()).toEqual({ n: 0 });
    const results = await Promise.all([s.save({ nickname: '😀'.repeat(24), revision: 0 }, { 'idempotency-key': randomUUID() }), s.save({ nickname: '競爭稱呼', revision: 0 }, { 'idempotency-key': randomUUID() })]);
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 409]);
    expect((await s.read()).json().nickname).toBe('😀'.repeat(24));
  });
  it('rejects anonymous, wrong scope, cross-site, CSRF, invalid inputs and revoked receipt replay', async () => {
    const s = await setup();
    for (const extra of [{ cookie: '' }, { origin: 'https://evil.example' }, { 'x-csrf-token': '' }, { 'x-account-scope': 'stale' }] as Record<string, string>[]) expect((await s.save(undefined, extra)).statusCode).toBeGreaterThanOrEqual(400);
    for (const input of [{ nickname: '' }, { nickname: 'a\nb' }, { nickname: '😀'.repeat(25) }, { revision: -1 }, { is_admin: true }]) expect((await s.save({ nickname: '新稱呼', revision: 0, ...input })).statusCode).toBe(400);
    expect((await s.save(undefined, { 'idempotency-key': 'invalid' })).statusCode).toBe(400);
    expect((await s.save()).statusCode).toBe(200);
    s.db.prepare("UPDATE browser_sessions SET user_id='bob' WHERE token_hash=?").run(hash('fixture-alice'));
    expect((await s.save()).statusCode).toBe(409);
    s.db.prepare("UPDATE browser_sessions SET user_id='alice' WHERE token_hash=?").run(hash('fixture-alice'));
    s.db.prepare("INSERT INTO privacy_requests VALUES('closed','alice','pending','now','now','')").run();
    expect((await s.read()).statusCode).toBe(401); expect((await s.save()).statusCode).toBe(401);
  });
  it('rolls back account, roster versions, outbox changes and receipt when either required audit fails', async () => {
    for (const table of ['event_audit', 'account_audit']) {
      const s = await setup(); const tables = ['users', 'events', 'bot_outbox', 'event_audit', 'account_audit', 'request_results'];
      const before = tables.map(name => s.db.prepare('SELECT * FROM ' + name).all());
      s.db.exec(`CREATE TRIGGER reject_profile BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`);
      expect((await s.save()).statusCode).toBe(500);
      expect(tables.map(name => s.db.prepare('SELECT * FROM ' + name).all())).toEqual(before);
    }
  });
  it('preserves nickname writes if an optional bot policy or outbox hook fails', async () => {
    const s = await setup(); s.db.prepare("UPDATE bot_settings SET config_json='malformed' WHERE id=1").run();
    const before = s.db.prepare('SELECT * FROM bot_outbox').all();
    const result = await s.save(); expect(result.statusCode).toBe(200);
    expect(s.db.prepare('SELECT * FROM bot_outbox').all()).toEqual(before);
    expect(s.db.prepare('SELECT count(*) n FROM event_audit').get()).toEqual({ n: 5 });
    s.db.prepare("UPDATE bot_settings SET config_json='{\"enabled\":true}' WHERE id=1").run();
    s.db.exec("CREATE TRIGGER reject_bot BEFORE UPDATE ON bot_outbox BEGIN SELECT RAISE(ABORT,'synthetic bot failure'); END");
    expect((await s.save({ nickname: '再次改名', revision: result.json().revision }, { 'idempotency-key': randomUUID() })).statusCode).toBe(200);
    expect(s.db.prepare('SELECT * FROM bot_outbox').all()).toEqual(before);
  });
  it('matches legacy Python roster revisions, immutable facts and every delivery state for enabled, disabled and inherited policy', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'qgroup-nickname-'));
    try {
      for (const [index, policy] of [{ enabled: true }, { enabled: false }, {}, {}].entries()) {
        const legacyPath = join(directory, 'legacy-' + index + '.sqlite3'); const newPath = join(directory, 'new-' + index + '.sqlite3');
        for (const path of [legacyPath, newPath]) {
          const db = openDatabase(path); fixture(db); nicknameFixture(db); db.prepare('UPDATE bot_settings SET config_json=?').run(JSON.stringify(policy)); db.close();
        }
        const expected = JSON.parse(execFileSync('python3', ['tools/rebuild/compare-nickname.py', legacyPath, '新稱呼', stamp], { encoding: 'utf8', env: { ...process.env, KANBAN_BOT_ENABLED: index === 3 ? '1' : '0' } }));
        const db = openDatabase(newPath); const app = createApp({ db, origin, now: () => new Date(stamp), botEnabledDefault: index === 3 });
        try {
          const viewer = (await app.inject({ url: '/api/v2/session', headers: { cookie: 'kanban_session=fixture-alice' } })).json();
          const response = await app.inject({ method: 'PUT', url: '/api/v2/me/profile', headers: { cookie: 'kanban_session=fixture-alice', origin, 'x-account-scope': viewer.scope, 'x-csrf-token': viewer.csrf, 'idempotency-key': randomUUID() }, payload: { nickname: '新稱呼', revision: 0 } });
          expect(response.statusCode).toBe(200);
          const actual: Record<string, unknown> = {};
          for (const table of ['users', 'events', 'attendees', 'roster_parties', 'finance_entries', 'settlements', 'bot_settings', 'bot_outbox']) actual[table] = db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all();
          actual.event_audit = (db.prepare('SELECT * FROM event_audit ORDER BY event_id,version').all() as Record<string, unknown>[]).map(({ id: _id, ...row }) => ({ ...row, before_json: JSON.parse(String(row.before_json)), after_json: JSON.parse(String(row.after_json)) }));
          expect(actual).toEqual(expected);
        } finally { await app.close(); db.close(); }
      }
    } finally { rmSync(directory, { recursive: true }); }
  });
});
