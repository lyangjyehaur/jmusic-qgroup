import { resolve } from 'node:path';
import { openDatabase } from '@qgroup/database';
import { createApp, hash } from '../src/app';
import { fixture } from './fixture';
import { musicClaimFixture } from './music-claim-fixture';
import { financeFixture, financeHistoryFixture } from './finance-fixture';
import { inboxFixture } from './inbox-fixture';
import { nicknameFixture } from './nickname-fixture';

// Synthetic preview only. This adapter and its redirect route never enter the runtime bundle.
const db = openDatabase(':memory:'); fixture(db);
musicClaimFixture(db);
if (process.env.REBUILD_TEST_FINANCE === '1') { financeFixture(db); financeHistoryFixture(db); }
if (process.env.REBUILD_TEST_INBOX === '1') inboxFixture(db);
if (process.env.REBUILD_TEST_ROSTER === '1') {
  nicknameFixture(db);
  db.exec("INSERT INTO attendees(id,event_id,manager_id,name,note,payer_kind,status,created_at,updated_at) VALUES('guest-active','listen','alice','未認領同行','同行原文','manager','tentative','before','before'); INSERT INTO attendees(id,event_id,manager_id,name,payer_kind,status,invitation_token,created_at,updated_at) VALUES('hidden-invited','listen','alice','私人邀請','manager','invited','private-invitation-token','before','before');");
}
// Imported-history pagination uses a separate synthetic profile from ownership tests.
if (process.env.REBUILD_TEST_MUSIC_HISTORY === '1') for (let i = 0; i < 52; i++) db.prepare("INSERT INTO music_legacy_identity VALUES('link_audit',?,?)").run(i, JSON.stringify({ id: i + 100, qq: '10002', actor: 'credential:synthetic-private', before_user_id: i % 2 ? 'bob' : '', after_user_id: i % 2 ? '' : 'bob', created: 1794902400 + i }));
const port = Number(process.env.REBUILD_TEST_PORT ?? 5082);
const origin = `http://127.0.0.1:${port}`;
db.prepare("INSERT INTO users VALUES('auth-owner',?,'舊帳號','synthetic')").run(hash('fixture-auth-owner'));
db.prepare("INSERT INTO browser_sessions VALUES(?,'auth-owner','synthetic')").run(hash('fixture-auth-owner'));
db.prepare("INSERT INTO external_identities VALUES('qq','synthetic-qq',?,'auth-owner','原 QQ','synthetic')").run(hash('auth-original').slice(0, 32).toUpperCase());
db.prepare("INSERT INTO users VALUES('registration-admin',?,'註冊管理員','synthetic')").run(hash('fixture-registration-admin'));
db.prepare("INSERT INTO browser_sessions VALUES(?,'registration-admin','synthetic')").run(hash('fixture-registration-admin'));
db.prepare("INSERT INTO user_admin_roles VALUES('registration-admin',1,1,'synthetic')").run();
const app = createApp({ db, origin, adminCredentialHash: () => hash('synthetic-admin-rescue-' + 'x'.repeat(32)), staticRoot: resolve('.rebuild-dist/web'), qq: {
  clientId: 'synthetic-qq',
  authorize: state => origin + '/__test/qq?state=' + state,
  exchange: async code => ({ subject: hash(code === 'auth-original-no-union' ? 'auth-original' : code).slice(0, 32).toUpperCase(), nickname: '測試帳號 ' + code, avatarUrl: code === 'avatar-source' ? 'https://q1.qlogo.cn/synthetic-avatar.png' : '', unionId: code === 'auth-original-no-union' ? '' : 'synthetic-' + code }),
} });
app.get('/__test/qq', async (request, reply) => {
  const { state, code = 'browser-default' } = request.query as Record<string, string>;
  if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || !/^[A-Za-z0-9_-]{1,80}$/.test(code)) return reply.code(400).send({ error: 'invalid synthetic authorization' });
  return reply.header('Cache-Control', 'no-store').redirect('/auth/qq/callback?' + new URLSearchParams({ state, code }), 303);
});
await app.listen({ host: '127.0.0.1', port });
process.send?.('ready');
async function stop() { await app.close(); db.close(); }
process.once('SIGTERM', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });
