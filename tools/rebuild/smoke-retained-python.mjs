import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase } from '../../.rebuild-dist/api/database.mjs';

// This baseline is the original audited bot, not an assertion about the bot
// currently online. Nothing from the working-tree Python implementation loads.
const pythonCommit = '8da877857f163853c449474e168534e2e493121b';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'qgroup-retained-python-')));
try {
const pythonSource = join(root, 'original-python'), database = join(root, 'synthetic.sqlite3');
const fixture = resolve('tools/rebuild/retained-python-fixture.py');
const fixtureSha256 = hash(readFileSync(fixture));
const db = openDatabase(database);
try {
  for (const id of ['alice', 'bob']) {
    const token = hash('synthetic-retained-' + id);
    db.prepare('INSERT INTO users(id,token_hash,nickname,created_at) VALUES(?,?,?,?)').run(id, token, id, new Date().toISOString());
    db.prepare('INSERT INTO browser_sessions VALUES(?,?,?)').run(token, id, new Date().toISOString());
  }
} finally { db.close(); }
mkdirSync(pythonSource, { mode: 0o700 });
const archive = execFileSync('git', ['archive', pythonCommit, 'qgroup_core', 'qgroup_bot'], { maxBuffer: 32 * 1024 * 1024 });
execFileSync('tar', ['-xf', '-', '-C', pythonSource], { input: archive });
const sourceFiles = execFileSync('git', ['ls-tree', '-r', '--name-only', pythonCommit, '--', 'qgroup_core', 'qgroup_bot'], { encoding: 'utf8' }).trim().split('\n');
const pythonPins = sourceFiles.map(path => {
  const bytes = readFileSync(join(pythonSource, path));
  assert(bytes.equals(execFileSync('git', ['show', pythonCommit + ':' + path], { maxBuffer: 16 * 1024 * 1024 })));
  return { path, sha256: hash(bytes) };
});
const runtimePins = ['api/start.mjs', 'api/database.mjs'].map(path => ({ path, sha256: hash(readFileSync('.rebuild-dist/' + path)) }));
const portServer = createServer();
await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
const port = portServer.address().port;
await new Promise(resolve => portServer.close(resolve));
const origin = 'http://127.0.0.1:' + port, rescue = 'synthetic-rescue-' + randomUUID();
const environment = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
  REBUILD_DB: database, REBUILD_ORIGIN: origin, REBUILD_HOST: '127.0.0.1', REBUILD_PORT: String(port),
  REBUILD_BOT_ENABLED: '1', REBUILD_BOT_KEYBOARD: '1', REBUILD_BOT_PERSONAL_QUEUE: '1',
  REBUILD_ADMIN_KEY_HASH: hash(rescue), REBUILD_QQ_APP_ID: '', REBUILD_QQ_APP_KEY: '' };
const child = spawn(process.execPath, ['.rebuild-dist/api/start.mjs'], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '', stopped = false;
child.stdout.on('data', bytes => { logs = (logs + bytes).slice(-32768); });
child.stderr.on('data', bytes => { logs = (logs + bytes).slice(-32768); });
const closed = new Promise(resolve => child.once('exit', (code, signal) => { stopped = true; resolve({ code, signal }); }));
const rows = (sql, ...values) => { const db = new Database(database, { readonly: true }); try { return db.prepare(sql).all(...values); } finally { db.close(); } };
const python = (mode, id) => JSON.parse(execFileSync('python3', [fixture, pythonSource, database, mode, id, origin], {
  env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1', KANBAN_BOT_BASE_URL: origin },
  encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024,
}));
const results = [], linkChecks = new Set(), completed = [];
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    assert(!stopped, logs);
    try { ready = (await fetch(origin + '/api/v2/health', { signal: AbortSignal.timeout(1000) })).ok; } catch { /* startup */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, logs);
  const webRuntime = await (await fetch(origin + '/api/v2/version')).json(); assert.equal(webRuntime.service, 'web'); assert.equal(webRuntime.runtime, 'typescript');
  let cookie = 'kanban_session=synthetic-retained-alice';
  const viewer = await (await fetch(origin + '/api/v2/session', { headers: { Cookie: cookie } })).json();
  assert.equal(viewer.authenticated, true); assert.equal(viewer.nickname, 'alice');
  const headers = { Cookie: cookie, Origin: origin, 'X-Account-Scope': viewer.scope, 'X-CSRF-Token': viewer.csrf, 'Content-Type': 'application/json' };
  const post = async (path, value, extra = {}, key = randomUUID()) => {
    const response = await fetch(origin + '/api/v2' + path, { method: 'POST', headers: { ...headers, Cookie: cookie, 'Idempotency-Key': key, ...extra }, body: JSON.stringify(value), signal: AbortSignal.timeout(5000) });
    const text = await response.text(); assert.equal(response.status, 200, text); return JSON.parse(text);
  };
  const login = await fetch(origin + '/api/v2/admin/login', { method: 'POST', headers, body: JSON.stringify({ key: rescue, confirm: true }) });
  assert.equal(login.status, 200); await login.arrayBuffer(); cookie += '; ' + login.headers.getSetCookie().map(v => v.split(';')[0]).join('; ');
  const read = async path => { const response = await fetch(origin + '/api/v2' + path, { headers: { Cookie: cookie, 'X-Account-Scope': viewer.scope }, signal: AbortSignal.timeout(5000) }); const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value; };
  const access = await read('/admin/session'), admin = { 'X-Admin-CSRF': access.adminCsrf };
  for (const mode of ['plain', 'rich', 'dry-run']) {
    const beforePolicy = await read('/admin/bot');
    const config = { ...beforePolicy.config, enabled: true, dry_run: null, groups: [{ id: 'synthetic-group', name: '', replies: true, broadcast: true }], templates: { ...beforePolicy.config.templates, activity_published: mode + ': {title}\n正式 {confirmed} 人\n{url}' } };
    await post('/admin/bot', { command: 'save', revision: beforePolicy.revision, config, confirm: true }, admin);
    for (const original of completed) assert.deepEqual(rows('SELECT * FROM bot_outbox WHERE id=?', original.id)[0], original);
    const policy = await read('/admin/bot'); assert.equal(policy.revision, beforePolicy.revision + 1);
    const draft = await post('/activities/drafts', { values: { title: 'compiled web ' + mode, category: '其他', location: '合成地點', startsAt: '2099-12-12T18:00:00+08:00', deadline: '2099-12-11T18:00:00+08:00', capacity: 2, description: '合成原文', durationHours: 3, withdrawalDeadline: null, visibility: 'public', timezone: 'Asia/Taipei', minimumParticipants: 0, feePolicy: '', botEnabled: true, joinOwner: true } });
    const key = randomUUID(), command = { revision: draft.revision, confirm: true, acceptConditions: true };
    const published = await post('/activities/' + draft.id + '/draft/publish', command, {}, key);
    const frozen = rows('SELECT * FROM bot_outbox WHERE event_id=? ORDER BY id', draft.id);
    assert.equal(frozen.filter(r => r.kind === 'activity_published').length, 1); assert.equal(frozen.filter(r => r.due_at).length, 2);
    const data = python(mode, draft.id);
    assert.equal(data.first.claimed, 1); assert.equal(data.second.claimed, 0); assert.equal(data.first.failed, 0);
    assert.equal(data.first.sent, mode === 'dry-run' ? 0 : 1); assert.equal(data.first.simulated, mode === 'dry-run' ? 1 : 0);
    assert.equal(data.calls.length, mode === 'dry-run' ? 0 : 1); assert.equal(data.revision, policy.revision);
    const latest = rows('SELECT * FROM bot_outbox WHERE event_id=? ORDER BY id', draft.id), delivered = latest.find(r => r.kind === 'activity_published');
    assert.equal(delivered.status, mode === 'dry-run' ? 'skipped' : 'sent'); assert.equal(delivered.attempts, 0);
    assert.equal(delivered.last_error, mode === 'dry-run' ? 'dry-run' : ''); assert.equal(Boolean(delivered.simulated_at), mode === 'dry-run'); assert.equal(Boolean(delivered.sent_at), mode !== 'dry-run');
    const payload = JSON.parse(delivered.delivered_payload_json); assert.equal(payload.msg_type, mode === 'plain' ? 0 : 2);
    for (const reminder of latest.filter(r => r.due_at)) assert.deepEqual(reminder, frozen.find(r => r.id === reminder.id));
    const originalRows = rows('SELECT * FROM bot_outbox ORDER BY id');
    assert.deepEqual(await post('/activities/' + draft.id + '/draft/publish', command, {}, key), published);
    assert.deepEqual(rows('SELECT * FROM bot_outbox ORDER BY id'), originalRows);
    const input = { revision: published.revision, people: ['同行甲', '同行乙'].map(name => ({ isSelf: false, name, note: 'PRIVATE_SYNTHETIC_NOTE', payerKind: 'manager' })), queueMode: 'individual', intent: 'registered' };
    const preview = await post('/activities/' + draft.id + '/registration/preview', input);
    assert.deepEqual(preview.allocation.map(row => row.status), ['confirmed', 'waiting']);
    const joined = await post('/activities/' + draft.id + '/registration', { ...input, conditionsVersion: preview.conditionsVersion, previewToken: preview.token, acceptConditions: true, acceptPartial: true, confirm: true });
    const signup = python(mode, draft.id); assert.equal(signup.first.failed, 0); assert.equal(signup.second.claimed, 0);
    const owner = rows('SELECT id FROM attendees WHERE event_id=? AND user_id=?', draft.id, 'alice')[0];
    const beforeWithdrawal = rows('SELECT * FROM bot_outbox ORDER BY id');
    await post('/activities/' + draft.id + '/attendees/' + owner.id + '/registration', { revision: joined.revision, action: 'withdraw', name: '', note: '', payerKind: 'self', reason: '', confirm: true });
    const newRows = rows('SELECT * FROM bot_outbox ORDER BY id').filter(row => !beforeWithdrawal.some(old => old.id === row.id));
    assert.equal(newRows.filter(row => row.channel === 'group' && row.kind === 'registration_changed').length, 1);
    assert.deepEqual(rows('SELECT status FROM attendees WHERE event_id=? ORDER BY seq', draft.id).map(row => row.status), ['withdrawn', 'confirmed', 'confirmed']);
    const withdrawal = python(mode, draft.id); assert.equal(withdrawal.first.failed, 0); assert.equal(withdrawal.second.claimed, 0);
    assert.equal(withdrawal.calls.length, mode === 'dry-run' ? 0 : 1);
    assert(!JSON.stringify([...signup.calls, ...withdrawal.calls]).includes('PRIVATE_SYNTHETIC_NOTE'));
    const after = rows('SELECT * FROM bot_outbox WHERE event_id=? ORDER BY id', draft.id);
    for (const privateRow of after.filter(row => row.channel === 'private')) { assert.equal(privateRow.status, 'skipped'); assert.match(privateRow.last_error, /no binding/); }
    for (const reminder of after.filter(row => row.due_at)) assert.deepEqual(reminder, frozen.find(row => row.id === reminder.id));
    completed.push(...after.filter(row => ['sent', 'skipped'].includes(row.status)));
    assert(data.mine.includes('尚未绑定')); assert(!JSON.stringify(data.queries).includes('synthetic-retained-'));
    for (const url of JSON.stringify(data).match(/http:\/\/127\.0\.0\.1:\d+[^\s"\\<>]*/g) ?? []) linkChecks.add(url.replace(/[)\]，。；]+$/, ''));
    results.push({ mode, eventId: draft.id, nativePublication: true, originalReceiptReplayed: true,
      aliases: data.queries.length, first: data.first, second: data.second, signup: signup.first, withdrawalAndPromotion: withdrawal.first,
      singleCombinedWithdrawalCard: true, privateNoticesNeverForwarded: true, actualTransportCalls: 0,
      publicationMockCalls: data.calls.length, totalMockCalls: data.calls.length + signup.calls.length + withdrawal.calls.length,
      appliedPolicyRevision: data.revision, futureRemindersUnchanged: true });
  }
  const simulatedPolicy = await read('/admin/bot');
  await post('/admin/bot', { command: 'save', revision: simulatedPolicy.revision, config: { ...simulatedPolicy.config, dry_run: false }, confirm: true }, admin);
  const noReplay = python('plain', results.at(-1).eventId); assert.equal(noReplay.first.claimed, 0); assert.equal(noReplay.calls.length, 0);
  for (const original of completed) assert.deepEqual(rows('SELECT * FROM bot_outbox WHERE id=?', original.id)[0], original);
  for (const url of linkChecks) { assert.equal(new URL(url).origin, origin); const response = await fetch(url, { signal: AbortSignal.timeout(5000) }); assert.equal(response.status, 200, url); const html = await response.text(); assert(html.includes('/assets/'), url); }
  child.kill('SIGTERM'); const exit = await closed; assert.equal(exit.code, 0, logs);
  const afterPins = sourceFiles.map(path => ({ path, sha256: hash(readFileSync(join(pythonSource, path))) })); assert.deepEqual(afterPins, pythonPins);
  assert.equal(hash(readFileSync(fixture)), fixtureSha256);
  assert.deepEqual(runtimePins.map(({ path }) => ({ path, sha256: hash(readFileSync('.rebuild-dist/' + path)) })), runtimePins);
  console.log(JSON.stringify({ version: 1, pythonCommit, pythonSourcePins: pythonPins, runtimePins, webRuntime, fixtureSha256, cases: results, deepLinkShells: linkChecks.size,
    simulationNotReplayedInRealMode: true, deliveredRowsUnchangedAfterPolicyChanges: true,
    networkTransport: 'denied', actualQQ: false, actualProductionImageCombination: false, scope: 'none', releaseEligible: false, gracefulStop: true }));
} finally {
  if (!stopped) { child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 10000); try { await closed; } finally { clearTimeout(timer); } }
}
} finally {
  rmSync(root, { recursive: true, force: true });
}
