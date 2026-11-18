import { resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openDatabase } from '@qgroup/database';
import { createApp, hash } from '../src/app';
import { fixture } from './fixture';
import { musicRoomFixture } from './music-room-fixture';
import { musicMatchingFixture } from './music-matching-fixture';
import { musicShoutFixture } from './music-shout-fixture';
import { adminCatalogFixture } from './admin-catalog-fixture';
import { musicCircleFixture } from './music-circle-fixture';
import { musicTrendFixture } from './music-trend-fixture';
import { musicClaimFixture } from './music-claim-fixture';
import { financeFixture, financeHistoryFixture } from './finance-fixture';
import { inboxFixture } from './inbox-fixture';
import { nicknameFixture } from './nickname-fixture';
import { settlementFixture } from './settlement-fixture';
import { timePollFixture } from './time-poll-fixture';
import { paymentFixture } from './payment-fixture';
import { botDeliveryFixture } from './bot-delivery-fixture';
import { legacyHistoryFixture } from './legacy-history-fixture';

// Synthetic preview only. This adapter and its redirect route never enter the runtime bundle.
const paymentRoot = (process.env.REBUILD_TEST_BACKUPS === '1'||process.env.REBUILD_TEST_PAYMENT === '1'||process.env.REBUILD_TEST_SETTLEMENT === '1') ? mkdtempSync(resolve(tmpdir(), 'qgroup-preview-payment-')) : null;
const legacyHistory=process.env.REBUILD_TEST_LEGACY_HISTORY==='1'?await legacyHistoryFixture():undefined;
const db = legacyHistory?.db ?? openDatabase(paymentRoot ? resolve(paymentRoot, 'state.db') : ':memory:'); if(!legacyHistory)fixture(db);
if (process.env.REBUILD_TEST_BACKUPS === '1') {
  const id='m_'+'d'.repeat(32);
  db.prepare("INSERT INTO music_profiles VALUES(?,'alice',0,'2026-11-17T00:00:00.000Z',NULL)").run(id);
  db.prepare("INSERT INTO music_profile_fields VALUES(?,'合成會員','合成私人留言',0,'',0,0,'synthetic')").run(id);
  db.prepare("INSERT INTO music_profile_contacts VALUES(?,'11111','self_reported',0,'synthetic')").run(id);
}
if (process.env.REBUILD_TEST_PAYMENT === '1') paymentFixture(db);
if (process.env.REBUILD_TEST_SETTLEMENT === '1') settlementFixture(db);
if (process.env.REBUILD_TEST_POLLS === '1') timePollFixture(db);
if (process.env.REBUILD_TEST_BOT_DELIVERIES === '1') botDeliveryFixture(db);
if (process.env.REBUILD_TEST_ADMIN_CATALOG !== '1'&&!legacyHistory) musicClaimFixture(db);
if (process.env.REBUILD_TEST_MUSIC_SHOUTS === '1') musicShoutFixture(db);
if (process.env.REBUILD_TEST_ADMIN_CATALOG === '1') adminCatalogFixture(db);
if (process.env.REBUILD_TEST_MUSIC_CIRCLES === '1') musicCircleFixture(db);
if (process.env.REBUILD_TEST_MUSIC_TREND === '1') musicTrendFixture(db);
if (process.env.REBUILD_TEST_MUSIC_ROOMS === '1') musicRoomFixture(db);
if (process.env.REBUILD_TEST_MUSIC_MATCHES === '1') musicMatchingFixture(db);
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
const app = createApp({ db, origin, legacyHistory:legacyHistory?.config, adminCredentialHash: () => hash('synthetic-admin-rescue-' + 'x'.repeat(32)), staticRoot: resolve('.rebuild-dist/web'), qq: {
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
async function stop() { await app.close(); if(legacyHistory)legacyHistory.close();else db.close(); if (paymentRoot) rmSync(paymentRoot, { recursive: true, force: true }); }
process.once('SIGTERM', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });
