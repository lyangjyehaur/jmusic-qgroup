import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { openServiceDatabase } from '@qgroup/database';
import { createApp } from '../../apps/api/src/app';
import { hash } from '../../apps/api/src/security';
import { erasureJournal, readVerifiedErasureJournal } from '../../apps/api/src/erasure-journal';

const [folder, portValue = '5094', ...extra] = process.argv.slice(2), port = Number(portValue);
if (!folder || extra.length || !Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Usage: tsx tools/rebuild/preview-production-data.ts <private-snapshot-directory> [port]');
const repository = resolve(import.meta.dirname, '../..');
const root = realpathSync(folder), privateRoot = realpathSync(join(repository, 'artifacts/private'));
if (!root.startsWith(privateRoot + '/')) throw Error('Preview snapshots must remain in artifacts/private');
const manifest = JSON.parse(readFileSync(join(root, 'preview-snapshot.json'), 'utf8')) as { version: number; capturedAt: string; credentialsReplaced: boolean; deliveryDisabled: boolean; counts: Record<string, number>; files: { path: string; size: number; sha256: string }[] };
if (manifest.version !== 1 || !manifest.credentialsReplaced || !manifest.deliveryDisabled) throw Error('Preview snapshot isolation is unverified');
for (const file of manifest.files) {
  if (isAbsolute(file.path) || file.path.split('/').some(part => part === '..' || part === '.')) throw Error('Invalid preview file path');
  const path = realpathSync(join(root, file.path));
  if (!path.startsWith(root + '/')) throw Error('Preview file escapes snapshot');
  const raw = readFileSync(path);
  if (raw.length !== file.size || createHash('sha256').update(raw).digest('hex') !== file.sha256) throw Error('Preview snapshot differs from captured files; use a fresh copy');
}
// Keep the captured files immutable: sessions and startup maintenance touch only this copy.
process.umask(0o077);
const workingRoot = mkdtempSync(join(privateRoot, 'production-preview-run-'));
process.once('exit', () => { rmSync(workingRoot, { recursive: true, force: true }); });
for (const file of manifest.files) {
  const target = join(workingRoot, file.path);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  copyFileSync(join(root, file.path), target); chmodSync(target, 0o600);
}
const db = openServiceDatabase(join(workingRoot, 'state.sqlite3'));
const journal = erasureJournal(db); readVerifiedErasureJournal(db, journal);
if ((db.prepare('SELECT count(*) n FROM bot_outbox').get() as { n: number }).n !== 0) throw Error('Preview contains delivery work');
const origin = 'http://127.0.0.1:' + port;
// A single captured app can supply stored avatars without enabling OAuth.
const profileClients = db.prepare("SELECT DISTINCT client_id FROM external_profiles WHERE provider='qq'").all() as { client_id: string }[];
const qqProfileClientId = profileClients.length === 1 ? profileClients[0]!.client_id : undefined;
const app = createApp({ db, origin, qqProfileClientId, staticRoot: join(repository, '.rebuild-dist/web'), erasureJournal: journal, pairedBackupScheduling: false, musicTrendSampling: false, botEnabledDefault: false, activityBot: { enabled: false, scheduleEnabled: false }, adminCredentialHash: () => '', publicAPIKeys: () => '' });
// This tool never enters either runtime bundle. Only local preview sessions are created.
const user = db.prepare(`SELECT u.id FROM users u LEFT JOIN attendees a ON a.user_id=u.id AND a.status='confirmed'
  WHERE NOT EXISTS(SELECT 1 FROM privacy_requests p WHERE p.user_id=u.id) GROUP BY u.id ORDER BY count(a.id) DESC,u.id LIMIT 1`).get() as { id: string } | undefined;
app.addHook('onRequest', async (request, reply) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return reply.code(403).send({ code: 'PREVIEW_READ_ONLY', message: '這份本機資料預覽為唯讀，不能修改活動或帳號。' });
});
app.get('/__test/participation/my', async (_request, reply) => {
  if (!user) return reply.redirect('/me/participation', 303);
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO browser_sessions VALUES(?,?,?)').run(hash(token), user.id, new Date().toISOString());
  reply.setCookie('kanban_session', token, { path: '/', httpOnly: true, sameSite: 'lax' });
  return reply.header('Cache-Control', 'no-store').redirect('/me/participation', 303);
});
await app.listen({ host: '127.0.0.1', port });
console.log(JSON.stringify({ preview: origin + '/activities/participation', capturedAt: manifest.capturedAt, counts: manifest.counts, readOnly: true }));
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await app.close(); db.close(); rmSync(workingRoot, { recursive: true }); }
process.once('SIGTERM', () => { void stop(); }); process.once('SIGINT', () => { void stop(); });
