import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, readBotPolicy } from '@qgroup/database';
import { defaultBotPolicy } from '@qgroup/domain';
import { fixture } from '../../api/testsupport/fixture';
import { buildActivityBotMessage, createActivityBot } from '../../api/src/activity-bot';
import { eventRow } from '../../api/src/activity-arrangements';
import { attachPaymentCodes } from '../../api/src/payment-codes';
import { imageDigest } from '../../api/src/payment-media';
import { testPNG } from '../../api/testsupport/payment-fixture';
import { BotOutboxWorker } from './outbox';
import { markOutbox, type OutboxRow } from './outbox-store';
import { outboxBody, deliveryContext } from './outbox-planning';
import { botGroupStatePath, readBotAuthorizationBlock, recordBotAuthorizationRejection } from './group-state';
import { loadBotConfig } from './config';
import { createBotObserver } from './observability';
import { classifyAPIError, type APIObject } from './protocol';
import type { BotAPIResult } from './api';
const stamp = '2026-11-17T10:00:00+00:00',
  moment = new Date(stamp),
  cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
  vi.useRealTimers();
});
function result(code: number | null = 0, status = 200, data: APIObject = {}): BotAPIResult {
  const ok = status === 200 && (!code || code === 0);
  if (status > 200 && status < 300) data = { ...data, _unconfirmed_http: status };
  else if (status !== 200) data = { ...data, _http_status: status };
  return {
    ok,
    code,
    status,
    data,
    kind: ok ? 'ok' : classifyAPIError(code, status, data),
    platformTrace: null,
  };
}
function setup(patch: object = {}, dryRun = false) {
  const dir = mkdtempSync(join(tmpdir(), 'native-outbox-')),
    path = join(dir, 'state.sqlite3'),
    db = openDatabase(path);
  fixture(db);
  db.exec("UPDATE events SET bot_enabled=1 WHERE id='listen'");
  const policy = defaultBotPolicy({
    enabled: true,
    groups: [{ id: 'synthetic-group', name: '', replies: true, broadcast: true }],
    ...patch,
  });
  db.prepare('UPDATE bot_settings SET config_json=?').run(JSON.stringify(policy));
  const config = loadBotConfig({
    KANBAN_DB: path,
    KANBAN_BOT_GROUP: 'synthetic-group',
    KANBAN_BOT_DRY_RUN: dryRun ? '1' : '0',
    KANBAN_BOT_LOG_DIR: join(dir, 'logs'),
    KANBAN_BOT_ALLOWED_HOSTS: 'example.test',
  });
  const post = vi.fn(async (_path: string, _body: APIObject, _signal?: AbortSignal) => result());
  const rows = () => db.prepare('SELECT * FROM bot_outbox ORDER BY id').all() as OutboxRow[];
  function queue(payload: unknown = { text: '合成訊息', msg_type: 0 }, patch: Record<string, unknown> = {}) {
    const row = {
      event_id: 'listen',
      kind: 'activity_published',
      dedupe_key: 'synthetic-' + rows().length,
      channel: 'group',
      target: 'synthetic-group',
      payload_json: JSON.stringify(payload),
      status: 'pending',
      created_at: stamp,
      ...patch,
    };
    return Number(
      db
        .prepare(
          `INSERT INTO bot_outbox(${Object.keys(row).join(',')}) VALUES(${Object.keys(row)
            .map(() => '?')
            .join(',')})`,
        )
        .run(...Object.values(row)).lastInsertRowid,
    );
  }
  const options = {
    now: () => moment,
    policyDefaults: {},
    composition: { baseURL: 'https://example.test', keyboard: true },
  };
  const worker = new BotOutboxWorker(db, config, { post }, options);
  cleanup.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, path, db, policy, config, options, post, rows, queue, worker };
}
function state(s: ReturnType<typeof setup>): Record<string, unknown>[] {
  return (s.db.prepare('SELECT * FROM bot_outbox ORDER BY id').all() as Record<string, unknown>[]).map(
    ({ claimed_at: _c, claim_token: _t, ...row }) => ({
      ...row,
      payload_json: JSON.parse(String(row.payload_json)),
      delivered_payload_json: row.delivered_payload_json
        ? JSON.parse(String(row.delivered_payload_json))
        : null,
    }),
  );
}
describe('native outbox delivery', () => {
  it('matches retained Python delivery states, bodies and runtime across success, simulation, errors and policy deferrals', async () => {
    const scenarios = [
      { name: 'sent', code: 0 },
      { name: 'simulation', code: 0, dry: true },
      { name: 'deployment override', code: 0, dry: true, policy: { dry_run: false } },
      { name: 'forced simulation', code: 0, policy: { dry_run: true } },
      { name: 'transient', code: 50055001 },
      { name: 'authorization', code: 40034105 },
      { name: 'permanent', code: 304061 },
      { name: 'markdown rejection', code: 40034127, markdown: true },
      { name: 'rate', code: 40034100 },
      { name: 'http rate', code: 0, status: 429 },
      { name: 'unconfirmed', code: 0, status: 202 },
      { name: 'blank', code: 0, payload: { text: ' ' } },
      { name: 'control', code: 0, payload: { text: '\u0001' } },
      { name: 'long Unicode', code: 0, payload: { text: '😀'.repeat(4001) } },
      { name: 'unapproved link', code: 0, payload: { text: 'https://unknown.test' } },
      { name: 'empty media', code: 0, payload: { msg_type: 7 } },
      { name: 'private', code: 0, row: { channel: 'private' } },
      { name: 'wrong target', code: 0, row: { target: 'other' } },
      { name: 'disabled', code: 0, policy: { enabled: false } },
      { name: 'empty groups', code: 0, policy: { groups: [] } },
      { name: 'quiet', code: 0, policy: { quiet_enabled: true, quiet_start: '17:00', quiet_end: '20:00' } },
      { name: 'maximum failures', code: 50055001, row: { attempts: 4 } },
    ];
    for (const scenario of scenarios) {
      const s = setup(scenario.policy, scenario.dry);
      s.config.markdownReplies = !!scenario.markdown;
      const response = result(scenario.code, scenario.status ?? 200);
      s.post.mockResolvedValue(response);
      s.queue(
        scenario.payload ?? { text: '合成訊息', msg_type: 0, markdown_text: '## 合成訊息' },
        scenario.row,
      );
      const copy = join(s.dir, 'python.sqlite3');
      await s.db.backup(copy);
      const expected = JSON.parse(
        execFileSync(
          'python3',
          [
            '-c',
            `import datetime,json,sqlite3,sys
from pathlib import Path
from types import SimpleNamespace
from qgroup_bot import worker
from qgroup_core import bot_settings
stamp='${stamp}'
class Frozen(datetime.datetime):
 @classmethod
 def now(cls,tz=None):return datetime.datetime.fromisoformat(stamp).astimezone(tz)
worker.datetime=Frozen;worker.now=lambda:stamp;worker.obs.event=lambda *a,**kw:None
calls=[]
class API:
 def post(self,path,body):
  calls.append(dict(path=path,body=body));return (${response.ok ? 'True' : 'False'},${response.code},json.loads(sys.argv[3]))
config=SimpleNamespace(db=Path(sys.argv[1]),group='synthetic-group',dry_run=${scenario.dry ? 'True' : 'False'},claim_timeout=600,batch=10,max_attempts=5,markdown_replies=${scenario.markdown ? 'True' : 'False'},allowed_link_hosts=('example.test',),log_dir=Path(sys.argv[1]).parent/'python-logs',log_content=False)
consumer=worker.OutboxWorker(config,API());summary=consumer.poll_once()
db=sqlite3.connect(sys.argv[1]);db.row_factory=sqlite3.Row;rows=[]
for stored in db.execute('SELECT * FROM bot_outbox ORDER BY id'):
 row=dict(stored);row.pop('claimed_at');row.pop('claim_token');row['payload_json']=json.loads(row['payload_json']);row['delivered_payload_json']=json.loads(row['delivered_payload_json']) if row['delivered_payload_json'] else None;rows.append(row)
print(json.dumps(dict(summary=summary,rows=rows,calls=calls,runtime=dict(db.execute('SELECT * FROM bot_runtime').fetchone()))))`,
            copy,
            '',
            JSON.stringify(response.data),
          ],
          { encoding: 'utf8', env: { PATH: process.env.PATH, PYTHONPATH: process.cwd() }, timeout: 10000 },
        ),
      );
      expect(await s.worker.pollOnce(), scenario.name).toEqual(expected.summary);
      expect(state(s), scenario.name).toEqual(expected.rows);
      expect(
        s.post.mock.calls.map(([path, body]) => ({ path, body })),
        scenario.name,
      ).toEqual(expected.calls);
      expect(s.db.prepare('SELECT * FROM bot_runtime').get(), scenario.name).toEqual(expected.runtime);
    }
  }, 30000);
  it('claims due rows in order across two connections, reclaims expired claims and fences late writes', async () => {
    const s = setup();
    const second = openDatabase(s.path);
    cleanup.push(() => second.close());
    s.queue(undefined, { due_at: '2099-01-01' });
    s.queue(undefined, { retry_at: '2099-01-01' });
    s.queue(undefined, { status: 'sending', claimed_at: '2000-01-01' });
    s.queue();
    const first = s.worker.claim();
    expect(first.map((row) => row.id)).toEqual([3, 4]);
    const other = new BotOutboxWorker(second, s.config, { post: s.post }, s.options);
    expect(other.claim()).toEqual([]);
    s.db.exec("UPDATE bot_outbox SET claimed_at='2000-01-01' WHERE id=3");
    const reclaimed = other.claim()[0]!;
    expect(reclaimed.claim_token).not.toBe(first[0]!.claim_token);
    expect(await s.worker.deliver(first[0]!)).toBe('skipped');
    expect(s.post).not.toHaveBeenCalled();
    expect(markOutbox(s.db, first[0]!, moment, 'sent')).toBe(false);
    expect(await other.deliver(reclaimed)).toBe('sent');
    expect(() => s.db.prepare("UPDATE bot_outbox SET payload_json='{}'").run()).toThrow();
  });
  it('rechecks sharing and ownership before a send and does not overwrite a new token after an awaited send', async () => {
    const s = setup();
    s.queue();
    const row = s.worker.claim()[0]!;
    s.db.exec("UPDATE events SET visibility='invitation' WHERE id='listen'");
    expect(await s.worker.deliver(row)).toBe('skipped');
    expect(s.post).not.toHaveBeenCalled();
    s.db.exec("UPDATE events SET visibility='public' WHERE id='listen'");
    s.queue();
    const claimed = s.worker.claim()[0]!;
    s.post.mockImplementation(async () => {
      s.db.prepare("UPDATE bot_outbox SET claim_token='replacement'").run();
      return result();
    });
    expect(await s.worker.deliver(claimed)).toBe('sent');
    expect(s.rows()[1]!.status).toBe('sending');
  });
  it('keeps frozen facts while refreshing the clock, latest template and only a matching schedule', async () => {
    const s = setup(),
      event = eventRow(s.db, 'listen')!;
    const message = buildActivityBotMessage(
      s.db,
      event,
      'conditions_changed',
      s.policy,
      moment,
      s.options.composition,
    )!;
    s.queue(
      { text: message.text, msg_type: 0, _template_context: message.context },
      { kind: 'conditions_changed' },
    );
    s.db
      .prepare('UPDATE bot_settings SET revision=1,config_json=?')
      .run(JSON.stringify({ ...s.policy, templates: { conditions_changed: '新版 {title}\n{url}' } }));
    s.db.exec(
      "UPDATE events SET title='不能混入新標題',starts_at='2100-01-01T00:00:00+00:00' WHERE id='listen'",
    );
    await s.worker.pollOnce();
    expect(s.post.mock.calls[0]![1].content).toContain(event.title);
    expect(s.post.mock.calls[0]![1].content).not.toContain('不能混入');
    expect(s.post.mock.calls[0]![1].content).not.toContain('距开始');
    expect(deliveryContext(message.context, { ...event, lifecycle: 'ended' })._countdown_event).toMatchObject(
      { lifecycle: 'ended' },
    );
    expect(deliveryContext(message.context, undefined)._countdown_event).toBeNull();
  });
  it('rebuilds due reminders with current rosters, validates the schedule key and never rewrites intent', async () => {
    const s = setup();
    s.db.exec("UPDATE events SET deadline='2026-11-18T10:00:00+00:00' WHERE id='listen'");
    const event = eventRow(s.db, 'listen')!,
      bot = createActivityBot(s.db, () => new Date(moment.getTime() - 1000), s.options.composition);
    bot.schedule(event);
    const reminder = s.rows().find((row) => row.kind === 'deadline_reminder')!;
    s.db.exec(
      "INSERT INTO attendees(id,event_id,manager_id,user_id,name,payer_kind,status,created_at,updated_at) VALUES('person','listen','alice','alice','','self','confirmed','before','before')",
    );
    await s.worker.pollOnce();
    const delivered = state(s).find((row) => row.id === reminder.id)!;
    expect(delivered.status).toBe('sent');
    expect((delivered.delivered_payload_json as APIObject).content).toContain('正式报名 1 人');
    expect(JSON.stringify(delivered.payload_json)).toBe(reminder.payload_json);
    s.queue({ text: 'old', _schedule_key: 'obsolete' }, { kind: 'deadline_reminder', due_at: stamp });
    await s.worker.pollOnce();
    expect(s.post).toHaveBeenCalledTimes(1);
  });
  it('defers a policy changed during composition and refuses recovery candidates without changing queue state', async () => {
    const s = setup();
    s.queue();
    const observer = createBotObserver((row) => {
      if (row.event === 'outbox_prepared')
        s.db
          .prepare('UPDATE bot_settings SET revision=revision+1,config_json=?')
          .run(JSON.stringify({ ...s.policy, groups: [] }));
    });
    const consumer = new BotOutboxWorker(s.db, s.config, { post: s.post }, { ...s.options, observer });
    expect(await consumer.pollOnce()).toMatchObject({ deferred: 1 });
    expect(s.post).not.toHaveBeenCalled();
    expect(s.rows()[0]!.attempts).toBe(0);
    s.db.exec('UPDATE rebuild_storage SET recovery_required=1');
    const before = state(s);
    await expect(consumer.pollOnce()).rejects.toThrow('Recovery candidate');
    expect(() => consumer.claim()).toThrow('Recovery candidate');
    expect(state(s)).toEqual(before);
  });
  it('persists pacing across restarts without spending failures or sending simulated records again', async () => {
    const s = setup({ min_interval_seconds: 60 });
    s.queue();
    s.queue();
    expect(await s.worker.pollOnce()).toMatchObject({ sent: 1, deferred: 1 });
    expect(s.rows().every((row) => row.attempts === 0)).toBe(true);
    const next = new BotOutboxWorker(
      s.db,
      s.config,
      { post: s.post },
      { ...s.options, now: () => new Date(moment.getTime() + 60000) },
    );
    expect(await next.pollOnce()).toMatchObject({ claimed: 1, sent: 1 });
    s.db.prepare('UPDATE bot_settings SET config_json=?').run(JSON.stringify({ ...s.policy, dry_run: true }));
    s.queue();
    expect(await next.pollOnce()).toMatchObject({ simulated: 1 });
    s.db
      .prepare('UPDATE bot_settings SET config_json=?')
      .run(JSON.stringify({ ...s.policy, dry_run: false }));
    expect(await next.pollOnce()).toMatchObject({ claimed: 0 });
    expect(s.post).toHaveBeenCalledTimes(2);
  });
  it('requires manual review when a confirmed send cannot be persisted, instead of automatically retrying it', async () => {
    const s = setup();
    s.queue();
    s.queue();
    s.db.exec(
      "CREATE TRIGGER synthetic_failed_confirmation BEFORE UPDATE ON bot_outbox WHEN NEW.status='sent' BEGIN SELECT RAISE(FAIL,'synthetic write failure'); END;",
    );
    expect(await s.worker.pollOnce()).toMatchObject({ skipped: 2 });
    expect(s.post).toHaveBeenCalledTimes(2);
    expect(
      state(s).every(
        (row) =>
          row.status === 'skipped' && String(row.last_error).includes('平台已确认送出') && row.attempts === 0,
      ),
    ).toBe(true);
    expect((state(s)[0]!.delivered_payload_json as APIObject).content).toBe('合成訊息');
    expect((await s.worker.pollOnce()).claimed).toBe(0);
  });
  it('bounds malformed jobs and exceptions without stopping the rest of a batch', async () => {
    const s = setup();
    s.queue([]);
    s.queue();
    s.queue();
    s.post.mockRejectedValueOnce(Error('PRIVATE TOKEN')).mockResolvedValue(result());
    expect(await s.worker.pollOnce()).toMatchObject({ claimed: 3, sent: 1 });
    expect(s.rows().map((row) => row.attempts)).toEqual([1, 1, 0]);
    expect(JSON.stringify(state(s))).not.toContain('PRIVATE TOKEN');
    expect((await s.worker.pollOnce()).claimed).toBe(0);
  });
  it('treats an aborted active request as uncertain, releases unstarted rows and prevents overlapping polls', async () => {
    const s = setup();
    s.queue();
    s.queue();
    const abort = new AbortController();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    s.post.mockImplementation(async () => {
      entered();
      return new Promise(() => {});
    });
    const work = s.worker.pollOnce(abort.signal);
    const rejected = expect(work).rejects.toMatchObject({ name: 'AbortError' });
    await started;
    await expect(s.worker.pollOnce()).rejects.toThrow('already running');
    abort.abort();
    await rejected;
    expect(s.rows().map((row) => row.status)).toEqual(['skipped', 'pending']);
    expect(s.rows().map((row) => row.attempts)).toEqual([0, 0]);
    s.post.mockResolvedValue(result());
    expect((await s.worker.pollOnce()).sent).toBe(1);
  });
  it('renews an active request lease so another consumer cannot reclaim it during a slow response', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(moment);
    const s = setup();
    s.config.claimTimeout = 30;
    s.queue();
    let resolve!: (value: BotAPIResult) => void;
    s.post.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const worker = new BotOutboxWorker(
      s.db,
      s.config,
      { post: s.post },
      { ...s.options, now: () => new Date() },
    );
    const pending = worker.pollOnce();
    await vi.advanceTimersByTimeAsync(45000);
    const other = new BotOutboxWorker(
      s.db,
      s.config,
      { post: s.post },
      { ...s.options, now: () => new Date() },
    );
    expect(other.claim()).toEqual([]);
    resolve(result());
    expect(await pending).toMatchObject({ sent: 1 });
  });
  it('stops a hung API within its deadline without automatically replaying an uncertain request', async () => {
    const s = setup();
    s.queue();
    s.post.mockImplementation(() => new Promise(() => {}));
    const worker = new BotOutboxWorker(
      s.db,
      s.config,
      { post: s.post },
      { ...s.options, requestTimeoutMs: 20 },
    );
    expect(await worker.pollOnce()).toMatchObject({ skipped: 1 });
    expect((await worker.pollOnce()).claimed).toBe(0);
  });
  it('checks jump-button hosts, preserves Unicode limits and never falls back after a platform Markdown refusal', async () => {
    expect(outboxBody({ text: '😀'.repeat(4000) }, false, []).body?.content).toHaveLength(8000);
    expect(
      outboxBody(
        {
          text: 'okay',
          keyboard: {
            content: { rows: [{ buttons: [{ action: { type: 0, data: 'https://unknown.test' } }] }] },
          },
        },
        false,
        ['example.test'],
      ).problem,
    ).toContain('按钮');
    const s = setup();
    s.config.markdownReplies = true;
    s.queue({ text: 'fallback', markdown_text: '## rich' });
    s.post.mockResolvedValue(result(304036));
    expect((await s.worker.pollOnce()).failed).toBe(1);
    expect(s.post).toHaveBeenCalledTimes(1);
    expect(s.post.mock.calls[0]![1]).toEqual({ msg_type: 2, markdown: { content: '## rich' } });
  });
});

function settlementJobs(s: ReturnType<typeof setup>) {
  s.db.exec(
    "INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,updated_at,actor_id,actor_name,kind,changed_fields) VALUES('listen',1,100,1,'','before','alice','收款人','detailed_published','[]')",
  );
  s.db
    .prepare("INSERT INTO settlement_details VALUES('listen',1,?)")
    .run(JSON.stringify({ group_notice: true }));
  const raw = testPNG(),
    image = { kind: 'wechat' as const, name: '微信', digest: imageDigest(raw) };
  attachPaymentCodes(s.db, 'listen', 1, [{ meta: image, raw }], moment);
  s.queue({ text: '結算文字', _settlement_version: 1 }, { kind: 'settlement_updated' });
  s.queue({ msg_type: 7, _settlement_version: 1, _settlement_image: image }, { kind: 'settlement_updated' });
  return { raw, image };
}
describe('native settlement attachments and persisted group refusals', () => {
  it('requires confirmed text, privately uploads each image and records an opaque descriptor without file_data', async () => {
    const s = setup();
    const { raw } = settlementJobs(s);
    s.post.mockImplementation(async (path) =>
      result(0, 200, path.endsWith('/files') ? { file_info: 'opaque-file' } : { id: 'sent' }),
    );
    expect(await s.worker.pollOnce()).toMatchObject({ sent: 2 });
    expect(s.post.mock.calls).toHaveLength(3);
    expect(s.post.mock.calls[1]![1]).toMatchObject({
      file_data: raw.toString('base64'),
      srv_send_msg: false,
    });
    expect(s.post.mock.calls[2]![1]).toEqual({ msg_type: 7, media: { file_info: 'opaque-file' } });
    expect(JSON.stringify(state(s))).not.toContain('opaque-file');
    expect((await s.worker.pollOnce()).claimed).toBe(0);
  });
  it('never uploads simulated images or images whose parent text failed', async () => {
    for (const dry of [true, false]) {
      const s = setup({}, dry);
      settlementJobs(s);
      s.post.mockResolvedValue(result(304061));
      expect(await s.worker.pollOnce()).toMatchObject(dry ? { simulated: 2 } : { failed: 2 });
      expect(s.post).toHaveBeenCalledTimes(dry ? 0 : 1);
    }
  });
  it('defers an image while text is still retrying and retries only the failed image', async () => {
    const s = setup();
    settlementJobs(s);
    s.post.mockResolvedValueOnce(result(50055001));
    expect(await s.worker.pollOnce()).toMatchObject({ deferred: 1 });
    expect(s.post).toHaveBeenCalledTimes(1);
    s.db.exec('UPDATE bot_outbox SET retry_at=NULL');
    s.post.mockImplementation(async (path) => (path.endsWith('/files') ? result(50055001) : result()));
    expect(await s.worker.pollOnce()).toMatchObject({ sent: 1 });
    s.db.exec('UPDATE bot_outbox SET retry_at=NULL');
    s.post.mockImplementation(async (path) =>
      result(0, 200, path.endsWith('/files') ? { file_info: 'image' } : {}),
    );
    const before = s.post.mock.calls.length;
    expect(await s.worker.pollOnce()).toMatchObject({ claimed: 1, sent: 1 });
    expect(s.post.mock.calls.length - before).toBe(2);
  });
  it('rechecks destination, permissions and claim after upload before any image message', async () => {
    for (const mutation of ['policy', 'permission', 'claim', 'visibility', 'version']) {
      const s = setup();
      settlementJobs(s);
      s.post.mockImplementation(async (path) => {
        if (path.endsWith('/files')) {
          if (mutation === 'policy')
            s.db
              .prepare('UPDATE bot_settings SET revision=revision+1,config_json=?')
              .run(JSON.stringify({ ...s.policy, groups: [] }));
          if (mutation === 'permission') s.db.exec("UPDATE events SET owner_id='bob' WHERE id='listen'");
          if (mutation === 'claim') s.db.exec("UPDATE bot_outbox SET claim_token='other' WHERE id=2");
          if (mutation === 'visibility')
            s.db.exec("UPDATE events SET visibility='invitation' WHERE id='listen'");
          if (mutation === 'version')
            s.db.exec(
              "INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,updated_at,actor_id,actor_name,kind,changed_fields) VALUES('listen',2,100,1,'','before','alice','收款人','detailed_edited','[]')",
            );
          return result(0, 200, { file_info: 'uploaded' });
        }
        return result();
      });
      await s.worker.pollOnce();
      expect(s.post.mock.calls.map(([path]) => path.endsWith('/files'))).toEqual([false, true]);
      expect(s.rows()[1]!.status, mutation).not.toBe('sent');
    }
  });
  it('bounds malformed upload responses and rejects a code that does not belong to the frozen settlement', async () => {
    const s = setup();
    const { image } = settlementJobs(s);
    s.post.mockResolvedValue(result());
    expect(await s.worker.pollOnce()).toMatchObject({ sent: 1 });
    expect(s.rows()[1]!.attempts).toBe(1);
    s.queue(
      { msg_type: 7, _settlement_version: 1, _settlement_image: { ...image, digest: 'a'.repeat(64) } },
      { kind: 'settlement_updated' },
    );
    s.queue({ msg_type: 7, _settlement_image: image }, { kind: 'settlement_updated' });
    const before = s.post.mock.calls.length;
    await s.worker.pollOnce();
    expect(s.post.mock.calls).toHaveLength(before);
  });
  it('persists per-destination refusals privately, retains legacy fallback and rejects symlinks', async () => {
    const s = setup();
    s.queue();
    s.queue();
    s.post.mockResolvedValue(result(40034105));
    expect(await s.worker.pollOnce()).toMatchObject({ claimed: 2 });
    expect(s.post).toHaveBeenCalledTimes(2);
    const path = botGroupStatePath(s.config.logDirectory, s.config.group);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ push_authorized: false, code: 40034105 });
    expect(readFileSync(path, 'utf8')).not.toContain('synthetic-group');
    s.queue();
    expect(await s.worker.pollOnce()).toMatchObject({ skipped: 1 });
    expect(s.post).toHaveBeenCalledTimes(2);
    const legacy = botGroupStatePath(s.config.logDirectory);
    writeFileSync(legacy, '{"push_authorized":false}');
    expect(readBotAuthorizationBlock(s.config.logDirectory, 'other', 'other')).toBeTruthy();
    const target = join(s.dir, 'untouched');
    writeFileSync(target, 'private');
    const bad = botGroupStatePath(s.config.logDirectory, 'bad');
    symlinkSync(target, bad);
    expect(() => readBotAuthorizationBlock(s.config.logDirectory, 'bad', 'other')).toThrow();
    recordBotAuthorizationRejection(s.config.logDirectory, 'bad', 40034105, moment, createBotObserver());
    expect(readFileSync(target, 'utf8')).toBe('private');
    expect(readBotPolicy(s.db).config.groups).toEqual(s.policy.groups);
  });
});

it('defers a prepared request when token acquisition crosses into quiet hours',async()=>{
  const s=setup({quiet_enabled:true,quiet_start:'23:00',quiet_end:'08:00',timezone:'UTC'});s.queue();
  let now=new Date('2026-11-17T22:59:59Z'),sent=0;
  const worker=new BotOutboxWorker(s.db,s.config,{post:async(_path,_body,_signal,beforeSend)=>{
    now=new Date('2026-11-17T23:00:01Z');beforeSend?.();sent++;return result();
  }},{...s.options,now:()=>now});
  expect((await worker.pollOnce()).deferred).toBe(1);expect(sent).toBe(0);
  expect(s.rows()[0]).toMatchObject({status:'pending',retry_at:'2026-11-18T08:00:00+00:00',attempts:0});
});
