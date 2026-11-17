import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, readBotPolicy, type DB } from '@qgroup/database';
import { BOT_KINDS, BotPolicyView } from '@qgroup/contracts';
import { createApp } from './app';
import { fixture } from '../testsupport/fixture';
import { defaultBotPolicy } from '@qgroup/domain';
const origin = 'https://rebuild.example',
  stamp = '2026-11-17T10:00:00+00:00',
  cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup() {
  const db = openDatabase(':memory:');
  fixture(db);
  db.prepare("INSERT INTO user_admin_roles VALUES('alice',1,1,'synthetic')").run();
  const app = createApp({
    db,
    origin,
    now: () => new Date(stamp),
    activityBot: { baseURL: 'https://kanban.example', keyboard: true },
    adminCredentialHash: () => '',
  });
  await app.ready();
  cleanup.push(async () => {
    await app.close();
    db.close();
  });
  const cookie = 'kanban_session=fixture-alice',
    viewer = (await app.inject({ url: '/api/v2/session', headers: { cookie } })).json(),
    headers = {
      cookie,
      origin,
      'x-account-scope': viewer.scope,
      'x-csrf-token': viewer.csrf,
    },
    access = (await app.inject({ url: '/api/v2/admin/session', headers })).json(),
    admin = { ...headers, 'x-admin-csrf': access.adminCsrf };
  const read = async () =>
    BotPolicyView.parse((await app.inject({ url: '/api/v2/admin/bot', headers })).json());
  const send = (body: object, key: string = randomUUID(), h = admin) =>
    app.inject({
      method: 'POST',
      url: '/api/v2/admin/bot',
      headers: { ...h, 'idempotency-key': key },
      payload: body,
    });
  const save = async (patch: object = {}, key = randomUUID()) => {
    const before = await read(),
      input = {
        command: 'save',
        revision: before.revision,
        config: { ...before.config, ...patch },
        confirm: true,
      };
    return { input, key, response: await send(input, key) };
  };
  return { db, app, headers, admin, read, send, save };
}
function tableRows(db: DB, table: string) {
  return (db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all() as Record<string, unknown>[]).map(
    (row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          key.endsWith('_json') && typeof value === 'string' ? JSON.parse(value) : value,
        ]),
      ),
  );
}
describe('transactional bot administration', () => {
  it('saves/reverts append-only versions, checks concurrent edits and recovers the exact uncertain command receipt', async () => {
    const s = await setup();
    expect((await s.read()).config.enabled).toBe(false);
    expect((await s.send({ command: 'revert', revision: 0, confirm: true })).statusCode).toBe(409);
    const saved = await s.save({
      enabled: true,
      dry_run: true,
      groups: [{ id: 'configured', name: '通知群', replies: true, broadcast: true }],
      templates: { activity_published: '新版 {title}\n{url}' },
    });
    expect(saved.response.statusCode, saved.response.body).toBe(200);
    expect(saved.response.json()).toMatchObject({ revision: 1, changed: true });
    const next = await s.save({ min_interval_seconds: 60 });
    expect(next.response.statusCode).toBe(200);
    expect((await s.send(saved.input, saved.key)).json()).toEqual(saved.response.json());
    expect(
      (await s.send({ ...saved.input, config: { ...saved.input.config, dry_run: false } }, saved.key))
        .statusCode,
    ).toBe(409);
    expect((await s.send(saved.input)).json().code).toBe('BOT_POLICY_CHANGED');
    const current = await s.read(),
      revert = await s.send({
        command: 'revert',
        revision: current.revision,
        confirm: true,
      });
    expect(revert.statusCode, revert.body).toBe(200);
    expect((await s.read()).config).toEqual(saved.input.config);
    expect((await s.read()).history.map((row) => row.action)).toEqual(['revert', 'save', 'save', 'baseline']);
    const same = await s.save();
    expect(same.response.json()).toMatchObject({ revision: 3, changed: false });
    expect(() => s.db.prepare("UPDATE bot_settings_history SET action='changed'").run()).toThrow(
      'append-only',
    );
    expect(() => s.db.prepare('DELETE FROM bot_settings_history').run()).toThrow('append-only');
  });
  it('invalidates queued audience/disabled kinds, clears only pacing deferrals and preserves every delivered/simulated/uncertain/private row', async () => {
    const s = await setup();
    await s.save({
      enabled: true,
      groups: [{ id: 'A', name: '', replies: true, broadcast: true }],
    });
    for (const [index, status, error, simulated] of [
      [0, 'pending', '等待允许发送的时间', null],
      [1, 'pending', 'transport backoff', null],
      [2, 'sending', '', null],
      [3, 'sent', '', 'before'],
      [4, 'skipped', 'dry-run', 'before'],
      [5, 'skipped', '平台返回异步结果，未确认送出，需人工核对', null],
      [6, 'private', '', null],
    ] as const)
      s.db
        .prepare(
          "INSERT INTO bot_outbox(event_id,kind,dedupe_key,channel,target,payload_json,status,retry_at,last_error,simulated_at,delivered_payload_json,created_at) VALUES('listen','activity_published',?,?,?,'{}',?,'later',?,?,?,'before')",
        )
        .run(
          String(index),
          status === 'private' ? 'private' : 'group',
          'A',
          status === 'private' ? 'pending' : status,
          error,
          simulated,
          simulated ? '{}' : null,
        );
    const frozen = tableRows(s.db, 'bot_outbox').filter(
      (row) => ['sent', 'skipped'].includes(String(row.status)) || row.channel === 'private',
    );
    const updated = await s.save({ min_interval_seconds: 60, dry_run: false });
    expect(updated.response.statusCode).toBe(200);
    expect(s.db.prepare("SELECT retry_at,last_error FROM bot_outbox WHERE dedupe_key='0'").get()).toEqual({
      retry_at: null,
      last_error: '',
    });
    expect(s.db.prepare("SELECT retry_at,last_error FROM bot_outbox WHERE dedupe_key='1'").get()).toEqual({
      retry_at: 'later',
      last_error: 'transport backoff',
    });
    await s.save({
      groups: [{ id: 'B', name: '', replies: true, broadcast: true }],
    });
    for (const key of ['0', '1', '2'])
      expect(s.db.prepare('SELECT status,last_error FROM bot_outbox WHERE dedupe_key=?').get(key)).toEqual({
        status: 'skipped',
        last_error: '通知目标群已变更，旧通知作废',
      });
    expect(
      tableRows(s.db, 'bot_outbox').filter((row) => ['3', '4', '5', '6'].includes(String(row.dedupe_key))),
    ).toEqual(frozen);
  });
  it('matches Python save/revert queue and future reminder changes, and Python consumes the new policy without changing immutable records', async () => {
    const s = await setup(),
      dir = mkdtempSync(join(tmpdir(), 'bot-policy-diff-')),
      path = join(dir, 'synthetic.sqlite3');
    try {
      s.db.exec("UPDATE events SET bot_enabled=1 WHERE id IN ('listen','karaoke')");
      await s.db.backup(path);
      const one = defaultBotPolicy({
          enabled: true,
          groups: [{ id: 'A', name: '群', replies: true, broadcast: true }],
        }),
        two = {
          ...one,
          deadline_hours: 12,
          quiet_enabled: true,
          min_interval_seconds: 30,
          templates: { 'activity_published@md': '## {title}\n[活動]({url})' },
        },
        three = {
          ...two,
          groups: [{ id: 'B', name: '新群', replies: false, broadcast: true }],
        };
      const actions = [
        { base_revision: 0, config: one },
        { base_revision: 1, config: two },
        { base_revision: 2, config: three },
        { base_revision: 3, revert: true },
      ];
      for (const action of actions) {
        const result = await s.send(
          'revert' in action
            ? {
                command: 'revert',
                revision: action.base_revision,
                confirm: true,
              }
            : {
                command: 'save',
                revision: action.base_revision,
                config: action.config,
                confirm: true,
              },
        );
        expect(result.statusCode, result.body).toBe(200);
      }
      const expected = JSON.parse(
        execFileSync(
          'python3',
          [
            '-c',
            `import json,sqlite3,sys,datetime,os
from qgroup_core import bot_settings,bot_outbox
os.environ['KANBAN_BOT_BASE_URL']='https://kanban.example';os.environ['KANBAN_BOT_KEYBOARD']='1'
stamp='${stamp}'
bot_settings.now=lambda:stamp;bot_outbox.now=lambda:stamp
class Frozen(datetime.datetime):
 @classmethod
 def now(cls,tz=None):return datetime.datetime.fromisoformat(stamp).astimezone(tz)
bot_outbox.datetime=Frozen
db=sqlite3.connect(sys.argv[1]);db.row_factory=sqlite3.Row
for action in json.load(sys.stdin):
 with db:bot_settings.save(db,action,'alice',revert=action.get('revert',False))
result={}
for table in ('bot_settings','bot_settings_history','bot_outbox','bot_runtime'):
 result[table]=[]
 for row in db.execute('SELECT * FROM '+table+' ORDER BY rowid'):
  value=dict(row)
  for key,item in list(value.items()):
   if key.endswith('_json') and isinstance(item,str):value[key]=json.loads(item)
  result[table].append(value)
print(json.dumps(result))`,
            path,
          ],
          {
            input: JSON.stringify(actions),
            encoding: 'utf8',
            env: { PATH: process.env.PATH, PYTHONPATH: process.cwd() },
          },
        ),
      );
      for (const table of ['bot_settings', 'bot_settings_history', 'bot_outbox', 'bot_runtime'])
        expect(tableRows(s.db, table), table).toEqual(expected[table]);
      expect(readBotPolicy(s.db).config.groups?.[0]?.id).toBe('A');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('previews every kind through the native composers without enqueueing or changing settings/runtime', async () => {
    const s = await setup();
    // A real ID matching the synthetic ID must not leak real attendee data into previews.
    const event = {
      ...(s.db.prepare("SELECT * FROM events WHERE id='listen'").get() as Record<string, unknown>),
      id: 'preview',
    };
    s.db
      .prepare(
        `INSERT INTO events (${Object.keys(event).join(',')}) VALUES (${Object.keys(event)
          .map(() => '?')
          .join(',')})`,
      )
      .run(...Object.values(event));
    s.db
      .prepare(
        "INSERT INTO attendees(id,event_id,manager_id,name,payer_kind,status,created_at,updated_at) VALUES('preview-person','preview','alice','PRIVATE_PREVIEW_COLLISION','self','confirmed','synthetic','synthetic')",
      )
      .run();
    const tables = [
        'bot_outbox',
        'bot_settings',
        'bot_settings_history',
        'bot_runtime',
        'events',
        'attendees',
      ],
      before = tables.map((t) => tableRows(s.db, t)),
      config = (await s.read()).config;
    for (const kind of Object.keys(BOT_KINDS)) {
      const response = await s.app.inject({
        method: 'POST',
        url: '/api/v2/admin/bot/preview',
        headers: s.admin,
        payload: { config, kind },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().text).toContain('https://kanban.example/');
      expect(response.json().text).toContain('周末聚餐');
      expect(response.json().markdown).toBeTruthy();
      expect(response.body).not.toContain('PRIVATE_PREVIEW_COLLISION');
    }
    const rich = await s.app.inject({
      method: 'POST',
      url: '/api/v2/admin/bot/preview',
      headers: s.admin,
      payload: {
        config: {
          ...config,
          templates: { 'activity_published@md': '## {title}\n[查看]({url})' },
        },
        kind: 'activity_published',
      },
    });
    expect(rich.json().markdown).toContain('查看');
    expect(tables.map((t) => tableRows(s.db, t))).toEqual(before);
  });
  it('enforces current admin authority, scope, CSRF, confirmation, UUID, strict policy validation and atomic rollback', async () => {
    const s = await setup(),
      body = {
        command: 'save',
        revision: 0,
        config: defaultBotPolicy(),
        confirm: true,
      };
    expect((await s.app.inject({ url: '/api/v2/admin/bot' })).statusCode).toBe(401);
    expect(
      (
        await s.send(body, randomUUID(), {
          ...s.admin,
          origin: 'https://evil.example',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await s.send(body, randomUUID(), {
          ...s.admin,
          'x-account-scope': 'stale',
        })
      ).statusCode,
    ).toBe(409);
    expect((await s.send(body, randomUUID(), { ...s.admin, 'x-admin-csrf': 'bad' })).statusCode).toBe(403);
    for (const patch of [
      { confirm: false },
      { config: { ...body.config, extra: true } },
      {
        config: {
          ...body.config,
          groups: [{ id: 'bad/path', name: '', replies: true, broadcast: true }],
        },
      },
      {
        config: {
          ...body.config,
          templates: { activity_published: '{title}' },
        },
      },
    ])
      expect((await s.send({ ...body, ...patch })).statusCode).toBe(400);
    expect((await s.send(body, 'invalid')).statusCode).toBe(400);
    s.db.exec(
      "CREATE TRIGGER reject_bot_history BEFORE INSERT ON bot_settings_history BEGIN SELECT RAISE(ABORT,'synthetic'); END",
    );
    expect((await s.send(body)).statusCode).toBe(500);
    expect((await s.read()).revision).toBe(0);
    expect(s.db.prepare('SELECT * FROM auth_requests').all()).toEqual([]);
    s.db.exec('DROP TRIGGER reject_bot_history');
    s.db.prepare("UPDATE user_admin_roles SET is_admin=0,revision=revision+1 WHERE user_id='alice'").run();
    expect((await s.send(body)).statusCode).toBe(403);
    expect((await s.app.inject({ url: '/api/v2/admin/bot', headers: s.headers })).statusCode).toBe(403);
  });
});
