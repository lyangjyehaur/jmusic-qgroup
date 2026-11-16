import { resolve } from 'node:path';
import { openDatabase } from '@qgroup/database';
import { createApp, hash } from '../src/app';
import { fixture } from './fixture';

// Synthetic preview only. This adapter and its redirect route never enter the runtime bundle.
const db = openDatabase(':memory:'); fixture(db);
const port = Number(process.env.REBUILD_TEST_PORT ?? 5082);
const origin = `http://127.0.0.1:${port}`;
db.prepare("INSERT INTO users VALUES('auth-owner',?,'舊帳號','synthetic')").run(hash('fixture-auth-owner'));
db.prepare("INSERT INTO browser_sessions VALUES(?,'auth-owner','synthetic')").run(hash('fixture-auth-owner'));
db.prepare("INSERT INTO external_identities VALUES('qq','synthetic-qq',?,'auth-owner','原 QQ','synthetic')").run(hash('auth-original').slice(0, 32).toUpperCase());
const app = createApp({ db, origin, staticRoot: resolve('.rebuild-dist/web'), qq: {
  clientId: 'synthetic-qq',
  authorize: state => origin + '/__test/qq?state=' + state,
  exchange: async code => ({ subject: hash(code).slice(0, 32).toUpperCase(), nickname: '測試帳號 ' + code, avatarUrl: '', unionId: 'synthetic-' + code }),
} });
app.get('/__test/qq', async (request, reply) => {
  const { state, code = 'browser-default' } = request.query as Record<string, string>;
  if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || !/^[A-Za-z0-9_-]{1,80}$/.test(code)) return reply.code(400).send({ error: 'invalid synthetic authorization' });
  return reply.header('Cache-Control', 'no-store').redirect('/auth/qq/callback?' + new URLSearchParams({ state, code }), 303);
});
await app.listen({ host: '127.0.0.1', port });
async function stop() { await app.close(); db.close(); }
process.once('SIGTERM', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });
