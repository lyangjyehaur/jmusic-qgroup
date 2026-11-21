import { openDatabase } from '@qgroup/database';
import { createApp } from '../src/app';
import { shoutOrigin, shoutStamp } from './shout-authority-fixture';

// The parent owns this synthetic DB and releases both independent processes
// only after their apps and separate CSRF contexts are ready. No HTTP listener.
const [path, token, command, target, key, input] = process.argv.slice(2);
if (!path || !token || !key || !input || !['publish', 'delete'].includes(command ?? '') || !process.send) throw new Error('Missing synthetic child arguments');
const db = openDatabase(path), app = createApp({ db, origin: shoutOrigin, now: () => new Date(shoutStamp), botEnabledDefault: false });
await app.ready();
const cookie = 'kanban_session=' + token;
const session = await app.inject({ url: '/api/v2/session', headers: { cookie } });
if (session.statusCode !== 200 || !session.json().authenticated) throw new Error('Synthetic member session required');
const viewer = session.json(), headers: Record<string, string> = { cookie, origin: shoutOrigin, 'x-account-scope': viewer.scope, 'x-csrf-token': viewer.csrf, 'idempotency-key': key };
if (command === 'delete') {
  const access = await app.inject({ url: '/api/v2/admin/session', headers });
  if (access.statusCode !== 200 || access.json().authMethod !== 'account') throw new Error('Synthetic administrator required');
  headers['x-admin-csrf'] = access.json().adminCsrf;
}
await new Promise<void>((resolve, reject) => {
  process.once('message', message => message === 'execute' ? resolve() : reject(new Error('Unexpected barrier message')));
  process.once('disconnect', () => reject(new Error('Parent disconnected before release')));
  process.send!({ type: 'ready', pid: process.pid });
});
try {
  const response = await app.inject({ method: 'POST', url: command === 'publish' ? '/api/v2/me/music/shouts' : '/api/v2/admin/shouts/' + target + '/delete', headers, payload: JSON.parse(input) });
  await new Promise<void>((resolve, reject) => process.send!({ type: 'result', status: response.statusCode, body: response.json() }, error => error ? reject(error) : resolve()));
} finally {
  await app.close(); db.close(); process.disconnect();
}
