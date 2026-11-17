import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { TimePoll } from '@qgroup/contracts';
import { fixture } from '../testsupport/fixture';
import { createApp } from './app';
import { pollDateStart, pollExpires } from './time-poll-context';
const origin = 'https://rebuild.example',
  stamp = '2026-11-17T00:00:00+00:00';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function setup() {
  const db = openDatabase(':memory:');
  fixture(db);
  db.prepare("INSERT OR REPLACE INTO bot_settings VALUES(1,0,?,'before')").run(
    JSON.stringify({
      enabled: true,
      groups: [{ id: 'synthetic-group', name: '測試', replies: true, broadcast: true }],
    }),
  );
  let moment = stamp;
  const app = createApp({
    db,
    origin,
    now: () => new Date(moment),
    activityBot: { enabled: true, baseURL: origin, keyboard: true, personalQueue: true },
  });
  await app.ready();
  cleanups.push(async () => {
    await app.close();
    db.close();
  });
  async function account(user: string) {
    const cookie = 'kanban_session=fixture-' + user;
    const session = (await app.inject({ url: '/api/v2/session', headers: { cookie } })).json();
    return { cookie, origin, 'x-account-scope': session.scope, 'x-csrf-token': session.csrf };
  }
  const alice = await account('alice'),
    bob = await account('bob');
  const write = (path: string, payload: Record<string, unknown>, headers = alice, key = randomUUID()) =>
    app.inject({
      method: 'POST',
      url: '/api/v2/time-polls' + path,
      headers: { ...headers, 'idempotency-key': key },
      payload,
    });
  const definition = {
    title: '候選時段',
    category: '约K',
    location: '台北',
    description: '原始說明',
    timezone: 'Asia/Taipei',
    capacity: 8,
    minimum_participants: 1,
    fee_policy: '依實際費用',
    deadline: '2026-11-19T00:00:00Z',
    time_mode: 'exact',
    duration_hours: 3,
    options: [{ starts_at: '2026-11-20T18:00:00+08:00' }, { starts_at: '2026-11-21T18:00:00+08:00' }],
  };
  const create = async (patch: Record<string, unknown> = {}) => {
    const r = await write('', { ...definition, ...patch });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().id as string;
  };
  const read = async (id: string, headers = alice) => {
    const r = await app.inject({ url: '/api/v2/time-polls/' + id, headers });
    expect(r.statusCode, r.body).toBe(200);
    return TimePoll.parse(r.json());
  };
  const vote = async (id: string, choice: 'yes' | 'maybe' | 'no' = 'yes', headers = bob) => {
    const p = await read(id, headers);
    return write(
      '/' + id + '/votes',
      { revision: p.revision, choices: p.options.filter((o) => !o.expired).map((o) => ({ option_id: o.id, choice })) },
      headers,
    );
  };
  const manage = (id: string, data: Record<string, unknown>, headers = alice, key = randomUUID()) =>
    write('/' + id + '/manage', { revision: 1, confirm: true, ...data }, headers, key);
  return {
    db,
    app,
    alice,
    bob,
    definition,
    create,
    read,
    vote,
    write,
    manage,
    clock: (v: string) => {
      moment = v;
    },
  };
}
describe('native availability polls', () => {
  it('creates public exact/date choices without a fixed count cap and exposes owner-only respondents/history and no internal identities', async () => {
    const s = await setup(),
      id = await s.create();
    const p = await s.read(id);
    expect(p).toMatchObject({ revision: 1, vote_revision: 0, bot_enabled: true, status: 'open', respondent_count: 0 });
    expect(p.options).toHaveLength(2);
    expect(JSON.stringify(p)).not.toContain('owner_id');
    expect(p.history).toHaveLength(1);
    expect(s.db.prepare('SELECT count(*) AS n FROM events WHERE title=?').get(s.definition.title)).toEqual({ n: 0 });
    expect(s.db.prepare('SELECT event_id,poll_id,kind FROM bot_outbox').get()).toEqual({
      event_id: null,
      poll_id: id,
      kind: 'time_poll_published',
    });
    expect((await s.vote(id)).statusCode).toBe(200);
    const publicView = await s.read(id, s.bob);
    expect(publicView).not.toHaveProperty('respondents');
    expect(publicView).not.toHaveProperty('history');
    expect(publicView).not.toHaveProperty('bot_enabled');
    expect(publicView.has_voted).toBe(true);
    expect((await s.read(id)).respondents).toMatchObject([{ name: '小白' }]);
    const dateId = await s.create({
      time_mode: 'date',
      duration_hours: undefined,
      deadline: '2026-11-17T04:00:00Z',
      options: Array.from({ length: 40 }, (_, i) => ({
        date: new Date(Date.UTC(2026, 10, 17 + i)).toISOString().slice(0, 10),
      })),
    });
    expect((await s.read(dateId)).duration_hours).toBeNull();
    expect((await s.read(dateId)).options).toHaveLength(40);
  });
  it('matches ZoneInfo midnight, skipped dates and DST expiry with the original Python implementation', () => {
    const cases = [
      ['2026-03-08', 'America/New_York'],
      ['2026-11-01', 'America/New_York'],
      ['2011-12-30', 'Pacific/Apia'],
      ['2026-04-05', 'Australia/Lord_Howe'],
      ['2026-11-17', 'Asia/Taipei'],
    ];
    const actual = cases.map(([day, zone]) => {
      const start = pollDateStart(day!, zone!);
      return [start, pollExpires({ starts_at: start }, { time_mode: 'date', timezone: zone! })];
    });
    const expected = JSON.parse(
      execFileSync(
        'python3',
        [
          '-c',
          `import json,sys
from qgroup_core.time_polls import date_start,option_expires
print(json.dumps([[date_start(d,z),option_expires(dict(starts_at=date_start(d,z)),dict(time_mode='date',timezone=z))] for d,z in json.loads(sys.argv[1])]))`,
          JSON.stringify(cases),
        ],
        { encoding: 'utf8', timeout: 15000 },
      ),
    );
    expect(actual).toEqual(expected);
  });
  it('rejects duplicate/invalid/mixed/expired options, private polls, invalid capacity and deadline, without creating partial rows', async () => {
    const s = await setup();
    const cases = [
      { options: [s.definition.options[0], s.definition.options[0]] },
      { options: [{ starts_at: '2026-02-30T00:00:00Z' }, s.definition.options[1]] },
      { options: [{ date: '2026-11-20' }, s.definition.options[1]] },
      { options: [{ starts_at: '2026-11-16T00:00:00Z' }, s.definition.options[1]] },
      { visibility: 'invitation' },
      { timezone: '+08:00' },
      { minimum_participants: 9 },
      { deadline: '2026-11-16T00:00:00Z' },
      { deadline: '2026-11-22T00:00:00Z' },
    ];
    for (const patch of cases) expect((await s.write('', { ...s.definition, ...patch })).statusCode).toBe(400);
    expect(s.db.prepare('SELECT count(*) AS n FROM time_polls').get()).toEqual({ n: 0 });
    expect(s.db.prepare('SELECT 1 FROM bot_outbox').get()).toBeUndefined();
  });
  it('requires all active choices once, preserves expired old votes and increments only the ballot revision on change', async () => {
    const s = await setup(),
      id = await s.create({ deadline: '2026-11-21T00:00:00Z' }),
      p = await s.read(id),
      a = p.options[0]!,
      b = p.options[1]!;
    expect(
      (await s.write('/' + id + '/votes', { revision: 1, choices: [{ option_id: a.id, choice: 'yes' }] }, s.bob))
        .statusCode,
    ).toBe(409);
    expect((await s.vote(id)).statusCode).toBe(200);
    s.clock('2026-11-20T12:00:00Z');
    const expired = await s.read(id, s.bob);
    expect(expired.options[0]).toMatchObject({ expired: true, can_vote: false, yes: 1 });
    expect(
      (
        await s.write(
          '/' + id + '/votes',
          {
            revision: 1,
            choices: [
              { option_id: a.id, choice: 'no' },
              { option_id: b.id, choice: 'maybe' },
            ],
          },
          s.bob,
        )
      ).statusCode,
    ).toBe(200);
    const after = await s.read(id, s.bob);
    expect(after).toMatchObject({ revision: 1, vote_revision: 2, my_choices: { [a.id]: 'yes', [b.id]: 'maybe' } });
    expect(after.leading_option_ids).toEqual([]);
    expect(s.db.prepare("SELECT 1 FROM attendees WHERE user_id='bob'").get()).toBeUndefined();
  });
  it('closes automatically, extends only on explicit valid deadline, requires cancellation reason and fences management revisions', async () => {
    const s = await setup(),
      id = await s.create();
    s.clock('2026-11-19T00:00:00Z');
    expect((await s.read(id)).status).toBe('closed');
    expect((await s.vote(id)).statusCode).toBe(409);
    expect((await s.manage(id, { action: 'extend', deadline: '2026-11-22T00:00:00Z' })).statusCode).toBe(400);
    expect((await s.manage(id, { action: 'extend', deadline: '2026-11-20T00:00:00Z' })).statusCode).toBe(200);
    expect((await s.read(id)).status).toBe('open');
    expect((await s.manage(id, { action: 'close' })).statusCode).toBe(409);
    expect((await s.manage(id, { action: 'close', revision: 2 })).statusCode).toBe(200);
    expect((await s.read(id)).status).toBe('closed');
    expect((await s.manage(id, { action: 'cancel', revision: 3 })).statusCode).toBe(400);
    expect((await s.manage(id, { action: 'cancel', revision: 3, reason: '場地不可用' })).statusCode).toBe(200);
    expect((await s.read(id)).reason).toBe('場地不可用');
    const key = randomUUID(),
      r = await s.manage(id, { action: 'remove', revision: 4 }, s.alice, key);
    expect(r.statusCode).toBe(200);
    expect((await s.manage(id, { action: 'remove', revision: 4 }, s.alice, key)).body).toBe(r.body);
    expect((await s.app.inject({ url: '/api/v2/time-polls/' + id, headers: s.alice })).statusCode).toBe(404);
    expect(s.db.prepare('SELECT count(*) AS n FROM time_poll_history WHERE poll_id=?').get(id)).toEqual({ n: 5 });
  });
  it('finalizes once with current vote revision, explicit terms, valid date/time and reason for low support; votes never register respondents', async () => {
    const s = await setup(),
      id = await s.create({
        time_mode: 'date',
        duration_hours: undefined,
        options: [{ date: '2026-11-20' }, { date: '2026-11-21' }],
      });
    await s.vote(id);
    const p = await s.read(id);
    const finalize = {
      action: 'finalize',
      base_vote_revision: 1,
      option_id: p.options[0]!.id,
      accept_terms: true,
      registration_deadline: '2026-11-19T00:00:00Z',
      starts_at: '2026-11-20T18:00:00+08:00',
      duration_hours: 4,
    };
    expect((await s.manage(id, { ...finalize, base_vote_revision: 0 })).statusCode).toBe(409);
    expect((await s.manage(id, { ...finalize, accept_terms: false })).statusCode).toBe(400);
    expect((await s.manage(id, { ...finalize, starts_at: '2026-11-21T00:00:00+08:00' })).statusCode).toBe(400);
    const key = randomUUID(),
      result = await s.manage(id, finalize, s.alice, key);
    expect(result.statusCode, result.body).toBe(200);
    expect((await s.manage(id, finalize, s.alice, key)).body).toBe(result.body);
    expect((await s.manage(id, finalize)).statusCode).toBe(409);
    const event = result.json().event_id;
    expect(s.db.prepare('SELECT user_id FROM attendees WHERE event_id=?').all(event)).toEqual([{ user_id: 'alice' }]);
    expect(s.db.prepare('SELECT user_id,kind FROM notifications WHERE event_id=?').all(event)).toEqual([
      { user_id: 'bob', kind: 'time_poll_finalized' },
    ]);
    expect(await s.read(id)).toMatchObject({
      status: 'finalized',
      event_id: event,
      respondent_count: 1,
      selected_option_id: p.options[0]!.id,
    });
    s.db.prepare("UPDATE events SET status='deleted' WHERE id=?").run(event);
    expect(await s.read(id)).toMatchObject({ event_id: null, event_deleted: true });
    const low = await s.create();
    const option = (await s.read(low)).options[0]!.id;
    expect((await s.manage(low, { ...finalize, option_id: option, base_vote_revision: 0 })).statusCode).toBe(400);
    expect(
      (await s.manage(low, { ...finalize, option_id: option, base_vote_revision: 0, reason: '發起者仍決定舉行' }))
        .statusCode,
    ).toBe(200);
  });
  it('rolls back every required finalize write, notification, event and receipt while isolating optional bot failure', async () => {
    const s = await setup(),
      id = await s.create();
    await s.vote(id);
    const p = await s.read(id),
      data = {
        action: 'finalize',
        base_vote_revision: 1,
        option_id: p.options[0]!.id,
        accept_terms: true,
        registration_deadline: '2026-11-19T00:00:00Z',
      };
    s.db.exec(
      "CREATE TRIGGER synthetic_fail BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'synthetic'); END;",
    );
    expect((await s.manage(id, data)).statusCode).toBe(500);
    expect(await s.read(id)).toMatchObject({ status: 'open', event_id: null, revision: 1 });
    expect(s.db.prepare('SELECT count(*) AS n FROM events WHERE title=?').get(s.definition.title)).toEqual({ n: 0 });
    s.db.exec('DROP TRIGGER synthetic_fail');
    s.db.exec(
      "CREATE TRIGGER synthetic_fail BEFORE INSERT ON bot_outbox WHEN NEW.event_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic'); END;",
    );
    expect((await s.manage(id, data)).statusCode).toBe(200);
    expect(s.db.prepare('SELECT 1 FROM bot_outbox WHERE event_id IS NOT NULL').get()).toBeUndefined();
  });
  it('rolls back creation, ballot updates and finalization if the durable request receipt fails, and serializes competing finalizations', async () => {
    const s = await setup();
    s.db.exec(
      "CREATE TRIGGER receipt_fail BEFORE INSERT ON request_results BEGIN SELECT RAISE(ABORT,'synthetic'); END;",
    );
    expect((await s.write('', s.definition)).statusCode).toBe(500);
    expect(s.db.prepare('SELECT 1 FROM time_polls').get()).toBeUndefined();
    expect(s.db.prepare('SELECT 1 FROM bot_outbox').get()).toBeUndefined();
    s.db.exec('DROP TRIGGER receipt_fail');
    const id = await s.create();
    s.db.exec(
      "CREATE TRIGGER receipt_fail BEFORE INSERT ON request_results BEGIN SELECT RAISE(ABORT,'synthetic'); END;",
    );
    expect((await s.vote(id)).statusCode).toBe(500);
    expect(await s.read(id)).toMatchObject({ vote_revision: 0, respondent_count: 0 });
    expect(s.db.prepare('SELECT 1 FROM time_poll_votes').get()).toBeUndefined();
    s.db.exec('DROP TRIGGER receipt_fail');
    await s.vote(id);
    const p = await s.read(id),
      input = {
        action: 'finalize',
        base_vote_revision: 1,
        option_id: p.options[0]!.id,
        accept_terms: true,
        registration_deadline: '2026-11-19T00:00:00Z',
      };
    s.db.exec(
      "CREATE TRIGGER receipt_fail BEFORE INSERT ON request_results BEGIN SELECT RAISE(ABORT,'synthetic'); END;",
    );
    expect((await s.manage(id, input)).statusCode).toBe(500);
    expect(await s.read(id)).toMatchObject({ revision: 1, status: 'open', event_id: null });
    expect(s.db.prepare('SELECT 1 FROM events WHERE title=?').get(s.definition.title)).toBeUndefined();
    s.db.exec('DROP TRIGGER receipt_fail');
    const results = await Promise.all([s.manage(id, input), s.manage(id, input)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(s.db.prepare('SELECT count(*) AS n FROM events WHERE title=?').get(s.definition.title)).toEqual({ n: 1 });
  });
  it('retains an owner-only removed context for uncertain operation recovery while public reads and other members stay denied', async () => {
    const s = await setup(),
      id = await s.create();
    const key = randomUUID(),
      result = await s.manage(id, { action: 'remove' }, s.alice, key);
    expect(result.statusCode).toBe(200);
    expect((await s.app.inject({ url: '/api/v2/time-polls/' + id, headers: s.alice })).statusCode).toBe(404);
    const context = await s.app.inject({ url: '/api/v2/time-polls/' + id + '/manage', headers: s.alice });
    expect(context.statusCode, context.body).toBe(200);
    expect(context.json()).toMatchObject({ status: 'deleted', can_manage: false, can_remove: false });
    expect((await s.app.inject({ url: '/api/v2/time-polls/' + id + '/manage', headers: s.bob })).statusCode).toBe(403);
    expect((await s.manage(id, { action: 'remove' }, s.alice, key)).body).toBe(result.body);
  });
  it('protects scope, origin, CSRF, owner roles, receipt conflicts and exact ballot retries', async () => {
    const s = await setup(),
      id = await s.create(),
      p = await s.read(id);
    expect((await s.manage(id, { action: 'close' }, s.bob)).statusCode).toBe(403);
    for (const headers of [
      { ...s.alice, origin: 'https://outside.example' },
      { ...s.alice, 'x-csrf-token': '0'.repeat(64) },
      { ...s.bob, 'x-account-scope': s.alice['x-account-scope'] },
    ])
      expect([403, 409]).toContain((await s.manage(id, { action: 'close' }, headers)).statusCode);
    const key = randomUUID(),
      input = { revision: 1, choices: p.options.map((o) => ({ option_id: o.id, choice: 'yes' })) };
    const r = await s.write('/' + id + '/votes', input, s.bob, key);
    expect(r.statusCode).toBe(200);
    expect((await s.write('/' + id + '/votes', input, s.bob, key)).body).toBe(r.body);
    expect((await s.read(id)).vote_revision).toBe(1);
    expect(
      (
        await s.write(
          '/' + id + '/votes',
          { ...input, choices: p.options.map((o) => ({ option_id: o.id, choice: 'no' })) },
          s.bob,
          key,
        )
      ).statusCode,
    ).toBe(409);
  });
  it('uses existing group policies, skips pending work on close, and permits explicit failed/simulated retry without replaying a pending delivery', async () => {
    const s = await setup(),
      id = await s.create(),
      row = s.db.prepare('SELECT id FROM bot_outbox WHERE poll_id=?').get(id) as { id: number };
    expect((await s.manage(id, { action: 'bot_retry', outbox_id: row.id })).statusCode).toBe(409);
    s.db
      .prepare("UPDATE bot_outbox SET status='skipped',last_error='dry-run',simulated_at=? WHERE id=?")
      .run(stamp, row.id);
    expect((await s.manage(id, { action: 'bot_retry', outbox_id: row.id })).statusCode).toBe(200);
    expect(s.db.prepare('SELECT count(*) AS n FROM bot_outbox WHERE poll_id=?').get(id)).toEqual({ n: 2 });
    expect((await s.manage(id, { action: 'bot_sync', bot_enabled: false, revision: 2 })).statusCode).toBe(200);
    expect(s.db.prepare("SELECT 1 FROM bot_outbox WHERE poll_id=? AND status='pending'").get(id)).toBeUndefined();
    s.db.exec('UPDATE bot_settings SET config_json=\'{"enabled":false}\'');
    const silent = await s.create();
    expect(s.db.prepare('SELECT 1 FROM bot_outbox WHERE poll_id=?').get(silent)).toBeUndefined();
  });
  it('matches Python poll serialization and frozen text/rich jobs on identical source rows', async () => {
    const s = await setup(),
      id = await s.create();
    await s.vote(id);
    const folder = mkdtempSync(join(tmpdir(), 'qgroup-poll-diff-')),
      path = join(folder, 'synthetic.sqlite3');
    try {
      await s.db.backup(path);
      const expected = JSON.parse(
        execFileSync(
          'python3',
          [
            '-c',
            `import json,sqlite3,sys
from qgroup_core import time_polls,bot_outbox
p=sys.argv[1];db=sqlite3.connect(p);db.row_factory=sqlite3.Row
time_polls.now=lambda:'${stamp}';bot_outbox.now=lambda:'${stamp}'
poll=time_polls.get(db,sys.argv[2]);db.execute('DELETE FROM bot_outbox WHERE poll_id=?',(poll['id'],));bot_outbox.announce_poll(db,poll)
print(json.dumps(dict(owner=time_polls.serialize(db,poll,'alice'),voter=time_polls.serialize(db,poll,'bob'),jobs=[dict(r) for r in db.execute('SELECT kind,dedupe_key,target,payload_json FROM bot_outbox WHERE poll_id=?',(poll['id'],))])))`,
            path,
            id,
          ],
          {
            encoding: 'utf8',
            timeout: 15000,
            env: { ...process.env, KANBAN_BOT_ENABLED: '1', KANBAN_BOT_BASE_URL: origin, KANBAN_BOT_KEYBOARD: '1' },
          },
        ),
      );
      const owner = await s.read(id); // Auto sequence IDs differ after Python regenerated its isolated job.
      for (const v of [owner, expected.owner]) for (const row of v.bot_delivery ?? []) delete row.id;
      expect(owner).toEqual(expected.owner);
      expect(await s.read(id, s.bob)).toEqual(expected.voter);
      const jobs = s.db
        .prepare('SELECT kind,dedupe_key,target,payload_json FROM bot_outbox WHERE poll_id=?')
        .all(id) as { payload_json: string }[];
      const decode = (rows: { payload_json: string }[]) =>
        rows.map((r) => ({ ...r, payload_json: JSON.parse(r.payload_json) }));
      expect(decode(jobs)).toEqual(decode(expected.jobs));
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
  it('matches original Python finalization records, automatic owner signup, notifications and native bot jobs', async () => {
    for (const mode of ['date', 'exact']) {
      const s = await setup(),
        id = await s.create(
          mode === 'date'
            ? {
                time_mode: 'date',
                duration_hours: undefined,
                options: [{ date: '2026-11-20' }, { date: '2026-11-21' }],
              }
            : {},
        );
      await s.vote(id);
      const p = await s.read(id);
      const input = {
        action: 'finalize',
        base_vote_revision: 1,
        option_id: p.options[0]!.id,
        accept_terms: true,
        registration_deadline: '2026-11-19T00:00:00Z',
        ...(mode === 'date' ? { starts_at: '2026-11-20T18:00:00+08:00', duration_hours: 3 } : {}),
      };
      const folder = mkdtempSync(join(tmpdir(), 'qgroup-poll-finalize-diff-')),
        path = join(folder, 'synthetic.sqlite3');
      try {
        await s.db.backup(path);
        const expected = JSON.parse(
          execFileSync(
            'python3',
            [
              '-c',
              `import datetime,json,sqlite3,sys
from qgroup_core import time_polls,events,audit,conditions,roster,bot_outbox,bot_views,bot_settings,lifecycle
for module in (time_polls,events,audit,conditions,roster,bot_outbox,bot_views,bot_settings,lifecycle):module.now=lambda:'${stamp}'
class Frozen(datetime.datetime):
 @classmethod
 def now(cls,tz=None):return datetime.datetime.fromisoformat('${stamp}').astimezone(tz)
bot_outbox.datetime=Frozen
db=sqlite3.connect(sys.argv[1]);db.row_factory=sqlite3.Row
user=db.execute("SELECT * FROM users WHERE id='alice'").fetchone();poll=time_polls.get(db,sys.argv[2])
time_polls.manage(db,poll,user,dict(json.loads(sys.argv[3]),base_revision=1))
poll=time_polls.get(db,poll['id']);event=db.execute('SELECT * FROM events WHERE id=?',(poll['event_id'],)).fetchone()
result=dict(event=dict(event),poll=dict(poll),history=[dict(r) for r in db.execute('SELECT * FROM time_poll_history WHERE poll_id=?',(poll['id'],))])
for table in ('event_access','event_conditions','attendees','roster_parties','attendee_consents','event_audit','notifications','bot_outbox'):result[table]=[dict(r) for r in db.execute('SELECT * FROM '+table+' WHERE event_id=?',(event['id'],))]
print(json.dumps(result))`,
              path,
              id,
              JSON.stringify(input),
            ],
            {
              encoding: 'utf8',
              timeout: 15000,
              env: {
                ...process.env,
                KANBAN_BOT_ENABLED: '1',
                KANBAN_BOT_BASE_URL: origin,
                KANBAN_BOT_KEYBOARD: '1',
                KANBAN_BOT_PERSONAL_QUEUE: '1',
              },
            },
          ),
        );
        const r = await s.manage(id, input);
        expect(r.statusCode, r.body).toBe(200);
        const event = r.json().event_id;
        const actual: Record<string, unknown> = {
          event: s.db.prepare('SELECT * FROM events WHERE id=?').get(event),
          poll: s.db.prepare('SELECT * FROM time_polls WHERE id=?').get(id),
          history: s.db.prepare('SELECT * FROM time_poll_history WHERE poll_id=?').all(id),
        };
        for (const table of [
          'event_access',
          'event_conditions',
          'attendees',
          'roster_parties',
          'attendee_consents',
          'event_audit',
          'notifications',
          'bot_outbox',
        ])
          actual[table] = s.db.prepare('SELECT * FROM ' + table + ' WHERE event_id=?').all(event);
        function normalize(value: Record<string, unknown>) {
          const ev = value.event as { id: string; invite_token: string },
            person = (value.attendees as { id: string; party_id: string }[])[0]!;
          let raw = JSON.stringify(value)
            .replaceAll(ev.id, 'EVENT')
            .replaceAll(ev.invite_token, 'INVITE')
            .replaceAll(person.id, 'PERSON')
            .replaceAll(person.party_id, 'PARTY');
          const decoded = JSON.parse(raw);
          for (const rows of Object.values(decoded))
            if (Array.isArray(rows))
              for (const row of rows)
                for (const key of ['snapshot_json', 'details_json', 'before_json', 'after_json', 'payload_json'])
                  if (typeof row[key] === 'string') row[key] = JSON.parse(row[key]);
          if (decoded.poll.result_json) decoded.poll.result_json = JSON.parse(decoded.poll.result_json);
          return decoded;
        }
        expect(normalize(actual)).toEqual(normalize(expected));
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    }
  });
  it('lets the retained Python worker deliver native poll notices once through a mock transport and refresh delayed expired-candidate summaries', async () => {
    const s = await setup(),
      id = await s.create({ deadline: '2026-11-21T00:00:00Z' }),
      folder = mkdtempSync(join(tmpdir(), 'qgroup-poll-worker-')),
      path = join(folder, 'synthetic.sqlite3');
    try {
      await s.db.backup(path);
      const result = JSON.parse(
        execFileSync(
          'python3',
          [
            '-c',
            `import datetime,json,sqlite3,sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
from qgroup_bot import worker
from qgroup_core import bot_outbox,time_polls
stamp='2026-11-20T12:00:00+00:00'
class Frozen(datetime.datetime):
 @classmethod
 def now(cls,tz=None):return datetime.datetime.fromisoformat(stamp).astimezone(tz)
worker.datetime=Frozen;bot_outbox.datetime=Frozen;worker.now=lambda:stamp;bot_outbox.now=lambda:stamp;time_polls.now=lambda:stamp
config=SimpleNamespace(db=Path(sys.argv[1]),group='synthetic-group',dry_run=False,sandbox=False,claim_timeout=600,batch=10,max_attempts=5,markdown_replies=False,allowed_link_hosts=('rebuild.example',),log_dir=Path(sys.argv[1]).parent/'isolated-logs',log_content=False)
api=Mock();api.post.return_value=(True,0,dict(id='SYNTHETIC_ONLY'));consumer=worker.OutboxWorker(config,api)
a=consumer.poll_once();b=consumer.poll_once()
print(json.dumps(dict(first=a,second=b,calls=api.post.call_count,body=api.post.call_args.args[1])))`,
            path,
            id,
          ],
          {
            encoding: 'utf8',
            timeout: 15000,
            env: {
              ...process.env,
              QQBOT_APP_ID: '',
              QQBOT_APP_SECRET: '',
              KANBAN_BOT_ENABLED: '1',
              KANBAN_BOT_ENV: '',
              KANBAN_BOT_BASE_URL: origin,
            },
          },
        ),
      );
      expect(result.first).toMatchObject({ claimed: 1, sent: 1, failed: 0 });
      expect(result.second.claimed).toBe(0);
      expect(result.calls).toBe(1);
      expect(JSON.stringify(result.body)).toContain('共 1 个候选时段');
      expect(JSON.stringify(result.body)).not.toContain('2026-11-20');
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
