import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '@qgroup/database';
import { PRIVACY_VERSION } from '@qgroup/contracts';
import { createApp, accountScope } from './app';
import { fixture } from '../testsupport/fixture';

it('preserves synthetic roster, money, bot policy and delivery states while legacy Python reads the new auth result', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qgroup-auth-bot-'));
  const path = join(directory, 'synthetic.sqlite3'); const db = openDatabase(path); fixture(db);
  const origin = 'http://localhost:5080';
  const app = createApp({ db, origin, qq: { clientId: '12345', authorize: state => 'https://example.test/?state=' + state,
    exchange: async code => ({ subject: (code === 'bob' ? 'B' : 'A').repeat(32), nickname: 'QQ nickname', avatarUrl: '', unionId: 'synthetic-union-' + code }) } });
  try {
    db.prepare("UPDATE events SET bot_enabled=1 WHERE id='listen'").run();
    db.prepare("INSERT INTO roster_parties(id,event_id,manager_id,queue_mode,created_at) VALUES('party','listen','alice','together','before')").run();
    for (const [id, user, status] of [['person-alice', 'alice', 'confirmed'], ['person-bob', 'bob', 'waiting']]) db.prepare(`INSERT INTO attendees(id,event_id,manager_id,user_id,party_id,name,payer_kind,status,created_at,updated_at)
      VALUES(?,'listen','alice',?,'party','synthetic name','self',?,'before','before')`).run(id, user, status);
    db.prepare(`INSERT INTO finance_entries(id,event_id,kind,payload_json,occurred_at,actor_id,actor_name,created_at)
      VALUES('ledger','listen','expense','{"amount_cents":12345}','before','alice','小青','before')`).run();
    db.prepare("INSERT INTO bot_settings VALUES(1,4,'{\"enabled\":false,\"dry_run\":true}','before')").run();
    for (const [index, status] of ['pending', 'sending', 'sent', 'failed', 'skipped'].entries()) db.prepare(`INSERT INTO bot_outbox(event_id,kind,dedupe_key,target,payload_json,status,attempts,claim_token,simulated_at,created_at)
      VALUES('listen','synthetic',?,'synthetic-group','{"template_version":1}',?,2,?,'simulation-only','before')`).run('key-' + index, status, 'claim-' + index);
    db.prepare("INSERT INTO external_identities VALUES('qq','12345',?,'bob','QQ bob','before')").run('B'.repeat(32));
    db.prepare("INSERT INTO user_admin_roles VALUES('alice',1,1,'before')").run();
    const preserved = ['events', 'attendees', 'roster_parties', 'finance_entries', 'bot_settings', 'bot_outbox'];
    const snapshot = () => preserved.map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all());
    const before = snapshot();
    const probe = () => JSON.parse(execFileSync('python3', ['tools/rebuild/probe-auth-bot.py', path], { encoding: 'utf8' }));
    const previous = probe();
    expect(previous.counts).toMatchObject({ confirmed: 1, waiting: 1 }); expect(previous.shareable).toBe(true);
    let cookie = 'kanban_session=fixture-alice';
    async function session() { return (await app.inject({ url: '/api/v2/session', headers: { cookie } })).json(); }
    async function post(url: string, payload: object) {
      const viewer = await session();
      return app.inject({ method: 'POST', url: '/api/v2' + url, headers: { cookie, origin, 'x-account-scope': viewer.scope, 'x-csrf-token': viewer.csrf }, payload });
    }
    async function oauth(mode: string, code: string) {
      const start = await post('/auth/qq/start', { mode, confirm: true, acceptPrivacy: true, privacyVersion: PRIVACY_VERSION });
      const state = new URL(start.json().authorizeUrl).searchParams.get('state')!;
      await app.inject({ url: '/auth/qq/callback?' + new URLSearchParams({ state, code }), headers: { cookie } });
      const viewer = await session();
      const status = (await app.inject({ url: '/api/v2/auth/qq/status', headers: { cookie, 'x-account-scope': viewer.scope } })).json();
      const done = await post('/auth/qq/finish', { confirm: true, attemptId: status.attemptId });
      expect(done.statusCode).toBe(200); cookie = String(done.headers['set-cookie']).split(';')[0]!;
    }
    async function registrationSetting(enabled: boolean) {
      const viewer = await session();
      const settings = (await app.inject({ url: '/api/v2/admin/registration', headers: { cookie, 'x-account-scope': viewer.scope } })).json();
      const result = await app.inject({ method: 'POST', url: '/api/v2/admin/registration', headers: { cookie, origin, 'x-account-scope': viewer.scope, 'x-csrf-token': viewer.csrf, 'x-admin-csrf': settings.adminCsrf }, payload: { enabled, revision: settings.revision, confirm: true } });
      expect(result.statusCode).toBe(200);
    }
    await registrationSetting(true); expect(probe().name_registration).toBe(true);
    const originalCookie = cookie;
    const visitor = await app.inject('/api/v2/session'); cookie = String(visitor.headers['set-cookie']).split(';')[0]!;
    expect((await post('/auth/register-name', { nickname: '隔離名稱帳號', confirm: true, acceptPrivacy: true, privacyVersion: PRIVACY_VERSION })).statusCode).toBe(200);
    cookie = originalCookie; await registrationSetting(false);
    await oauth('bind', 'alice'); await oauth('login', 'bob');
    expect((await session()).scope).toBe(accountScope('bob'));
    expect((await post('/me/accounts/switch', { confirm: true, scope: accountScope('alice') })).statusCode).toBe(200);
    const sourceCookie = cookie;
    const link = (await post('/me/devices/link', { confirm: true, authorizeOwnDevice: true })).json();
    cookie = 'kanban_session=fixture-bob';
    expect((await post('/device-links/accept', { token: link.token, confirm: true, acceptAccess: true })).statusCode).toBe(200);
    expect((await session()).scope).toBe(accountScope('bob'));
    expect((await post('/me/accounts/switch', { confirm: true, scope: accountScope('alice') })).statusCode).toBe(200);
    cookie = sourceCookie;
    const viewer = await session();
    const devices = (await app.inject({ url: '/api/v2/me/devices', headers: { cookie, 'x-account-scope': viewer.scope } })).json().devices as { id: string; current: boolean }[];
    const remote = devices.find(device => !device.current)!;
    expect((await post('/me/devices/revoke', { deviceId: remote.id, confirm: true })).statusCode).toBe(200);
    cookie = 'kanban_session=fixture-bob'; expect((await session()).scope).toBe(accountScope('bob'));
    cookie = sourceCookie;
    expect((await post('/auth/logout', { confirm: true })).statusCode).toBe(200);
    expect(snapshot()).toEqual(before);
    const after = probe();
    expect({ ...after, linked: [] }).toEqual(previous);
    expect(after.linked).toEqual([{ provider: 'qq', display_name: 'QQ nickname', unionid_bound: true }]);
    expect(after.scope).toBe(accountScope('alice'));
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally { await app.close(); db.close(); rmSync(directory, { recursive: true }); }
});
