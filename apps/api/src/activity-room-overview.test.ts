import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { ActivityRoomOverview, SettlementInput } from '@qgroup/contracts';
import { fixture } from '../testsupport/fixture';
import { settlementFixture } from '../testsupport/settlement-fixture';
import { createApp } from './app';
import { accountKey } from './finance-context';
import { eventRow } from './activity-arrangements';
const origin = 'https://rebuild.example',
  p1 = 'aaaaaaaaaaaaaaaa',
  p2 = 'bbbbbbbbbbbbbbbb',
  p3 = 'cccccccccccccccc',
  r1 = '1111111111111111';
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'qgroup-room-view-')),
    db = openDatabase(join(root, 'state.db'));
  fixture(db);
  settlementFixture(db);
  const app = createApp({ db, origin });
  await app.ready();
  closes.push(async () => {
    await app.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  async function headers(user: string) {
    const cookie = 'kanban_session=fixture-' + user,
      session = (await app.inject({ url: '/api/v2/session', headers: { cookie } })).json();
    return {
      cookie,
      origin,
      'x-account-scope': session.scope,
      'x-csrf-token': session.csrf,
    };
  }
  const alice = await headers('alice'),
    bob = await headers('bob');
  const get = (suffix = 'overview', h: Record<string, string> = alice, id = 'listen') =>
    app.inject({
      url: '/api/v2/activities/' + id + '/rooms/' + suffix,
      headers: h,
    });
  const plan = async (name = '一房', people = [p1, p3]) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/activities/listen/rooms',
      headers: { ...alice, 'idempotency-key': randomUUID() },
      payload: {
        revision: eventRow(db, 'listen')!.revision,
        rooms: [
          {
            id: r1,
            name,
            payer_id: accountKey('listen', 'alice'),
            person_ids: people,
          },
        ],
        confirm: true,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  };
  const settle = async (rooms?: object[]) => {
    const input = SettlementInput.parse({
      revision: eventRow(db, 'listen')!.revision,
      base_version: 0,
      reviewed_roster: true,
      people: [{ id: p1 }, { id: p2 }, { id: p3 }],
      items: [{ id: '2222222222222222', name: '消費', amount: '10.00' }],
      ...(rooms ? { rooms } : {}),
    });
    const preview = await app.inject({
      method: 'POST',
      url: '/api/v2/activities/listen/settlement/preview',
      headers: alice,
      payload: input,
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const saved = await app.inject({
      method: 'POST',
      url: '/api/v2/activities/listen/settlement',
      headers: { ...alice, 'idempotency-key': randomUUID() },
      payload: {
        ...input,
        preview_token: preview.json().preview_token,
        confirm: true,
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
  };
  return { root, db, app, alice, bob, get, plan, settle };
}
describe('public activity rooms and immutable plan history', () => {
  it('identifies self only by the live attendee user, distinguishes managed guests and retains unassigned and waiting people', async () => {
    const s = await setup();
    expect((await s.get()).json()).toMatchObject({
      kind: 'none',
      version: 0,
      rooms: [],
      can_manage: true,
    });
    s.db.exec(
      `UPDATE users SET nickname='同名'; UPDATE attendees SET status='waiting' WHERE id='${p1}' AND event_id='listen'`,
    );
    await s.plan();
    const alice = ActivityRoomOverview.parse((await s.get()).json());
    expect(alice).toMatchObject({
      kind: 'plan',
      version: 1,
      my_room_id: r1,
      has_self: true,
      self_waiting: true,
      can_manage: true,
    });
    expect(alice.rooms[0]!.people).toEqual([
      {
        id: p1,
        name: '同名 · 1',
        status: 'waiting',
        is_me: true,
        managed_guest: false,
        missing: false,
      },
      {
        id: p3,
        name: '同行',
        status: 'confirmed',
        is_me: false,
        managed_guest: true,
        missing: false,
      },
    ]);
    expect(alice.unassigned).toMatchObject([{ id: p2, name: '同名 · 2', is_me: false }]);
    const bob = (await s.get('overview', s.bob)).json();
    expect(bob).toMatchObject({
      my_room_id: null,
      has_self: true,
      can_manage: false,
    });
    expect(bob.rooms[0].people.every((p: any) => !p.is_me && !p.managed_guest)).toBe(true);
    expect(bob.unassigned[0]).toMatchObject({ id: p2, is_me: true });
    const anonymous = await s.get('overview', { cookie: s.alice.cookie });
    expect(anonymous.json()).toMatchObject({
      has_self: false,
      my_room_id: null,
      can_manage: false,
    });
    expect(anonymous.json().rooms[0].people.every((p: any) => !p.is_me && !p.managed_guest)).toBe(true);
    expect(anonymous.body).not.toMatch(
      /payer_id|manager_id|user_id|alice|bob|snapshot_json|payments|note|token/,
    );
  });
  it('keeps every stored arrangement and frozen payer while resolving current names and missing attendees', async () => {
    const s = await setup();
    await s.plan();
    await s.plan('二房', [p2]);
    const before = s.db.prepare("SELECT * FROM event_room_plans WHERE event_id='listen'").all();
    s.db.exec(
      `UPDATE users SET nickname='新稱呼' WHERE id='alice'; UPDATE attendees SET status='withdrawn' WHERE event_id='listen' AND id='${p3}'`,
    );
    const old = (await s.get('history/1')).json();
    expect(old).toMatchObject({
      version: 1,
      historical: true,
      can_manage: false,
      my_room_id: r1,
    });
    expect(old.rooms[0]).toMatchObject({
      name: '一房',
      payer_name: '小青',
      people: [
        { id: p1, name: '新稱呼', is_me: true },
        { id: p3, name: '名單已變更', missing: true, managed_guest: false },
      ],
    });
    expect((await s.get()).json().rooms[0].name).toBe('二房');
    expect((await s.get('history')).json()).toMatchObject({
      revisions: [
        { version: 2, room_count: 1 },
        { version: 1, room_count: 1 },
      ],
      next_before: null,
    });
    expect((await s.get('history/3')).statusCode).toBe(404);
    expect(s.db.prepare("SELECT * FROM event_room_plans WHERE event_id='listen'").all()).toEqual(before);
  });
  it('shows actual frozen names and membership after rename and withdrawal without manufacturing a self match', async () => {
    const s = await setup();
    await s.plan();
    await s.settle([
      {
        id: r1,
        name: '實際房',
        payer_id: accountKey('listen', 'alice'),
        person_ids: [p1, p2, p3],
        amount: '10',
      },
    ]);
    s.db.exec(
      `UPDATE users SET nickname='新稱呼' WHERE id='alice'; UPDATE attendees SET status='withdrawn' WHERE id='${p1}' AND event_id='listen'`,
    );
    const actual = (await s.get()).json();
    expect(actual).toMatchObject({
      kind: 'actual',
      version: 1,
      can_manage: false,
      has_self: false,
      my_room_id: null,
      unassigned: [],
    });
    expect(actual.rooms[0]).toMatchObject({
      name: '實際房',
      payer_name: '小青',
      people: [
        { name: '小青', status: 'confirmed', is_me: false },
        { name: '小白', is_me: false },
        { name: '同行', managed_guest: true },
      ],
    });
    expect((await s.get('history/1')).json().rooms[0].people[0]).toMatchObject({
      id: p1,
      name: '名單已變更',
      missing: true,
    });
  });
  it('falls back to the plan for a non-room bill but honors explicitly empty actual room definitions', async () => {
    const s = await setup();
    await s.settle(); // Source non-room bills have no rooms key.
    const stored = [
      {
        id: r1,
        name: '原預分',
        payer_id: accountKey('listen', 'alice'),
        payer_name: '小青',
        payer_label: '小青',
        person_ids: [p1],
      },
    ];
    s.db
      .prepare('INSERT INTO event_room_plans VALUES(?,?,?,?)')
      .run('listen', 1, JSON.stringify(stored), 'before');
    expect((await s.get()).json()).toMatchObject({
      kind: 'plan',
      can_manage: false,
      rooms: [{ name: '原預分' }],
    });
    const row = s.db
      .prepare("SELECT snapshot_json FROM settlement_details WHERE event_id='listen' AND version=1")
      .get() as { snapshot_json: string };
    // Imported source history can explicitly contain an empty rooms array.
    s.db.exec(
      "INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,updated_at,actor_id,actor_name,kind,changed_fields) SELECT event_id,2,total_cents,headcount,note,updated_at,actor_id,actor_name,kind,changed_fields FROM settlement_history WHERE event_id='listen' AND version=1",
    );
    s.db
      .prepare('INSERT INTO settlement_details VALUES(?,?,?)')
      .run('listen', 2, JSON.stringify({ ...JSON.parse(row.snapshot_json), rooms: [] }));
    expect((await s.get()).json()).toMatchObject({ kind: 'actual', rooms: [] });
  });
  it('enforces invitation, draft, deleted, scope and revoked-session boundaries on all three read routes', async () => {
    const s = await setup();
    for (const suffix of ['overview', 'history', 'history/1']) {
      for (const id of ['invite', 'draft', 'deleted', 'absent']) {
        expect((await s.get(suffix, {}, id)).statusCode).toBe(404);
        expect((await s.get(suffix, { cookie: s.alice.cookie }, id)).statusCode).toBe(404);
        expect((await s.get(suffix, s.bob, id)).statusCode).toBe(404);
      }
      expect((await s.get(suffix, { ...s.alice, 'x-account-scope': 'stale' })).statusCode).toBe(409);
    }
    s.db.exec("INSERT INTO user_admin_roles VALUES('bob',1,1,'before')");
    expect((await s.get('overview', s.bob, 'invite')).statusCode).toBe(404);
    s.db.exec(
      "INSERT INTO event_access VALUES('invite','bob','before'); INSERT INTO event_roles VALUES('draft-helper','draft','bob','[\"schedule\"]','before')",
    );
    expect((await s.get('overview', s.bob, 'invite')).statusCode).toBe(200);
    expect((await s.get('history', s.bob, 'draft')).statusCode).toBe(200);
    for (const sql of [
      "UPDATE events SET archived_at='before' WHERE id='listen'",
      "UPDATE events SET archived_at=NULL,lifecycle='cancelled' WHERE id='listen'",
      "UPDATE events SET lifecycle='draft' WHERE id='listen'",
    ]) {
      s.db.exec(sql);
      expect((await s.get()).json().can_manage).toBe(false);
    }
    s.db.exec('DELETE FROM browser_sessions');
    expect((await s.get()).statusCode).toBe(401);
  });
  it('paginates numerically without losing versions, keeps empty snapshots and rejects invalid cursors', async () => {
    const s = await setup();
    // Imported immutable history can exceed one page; seed only synthetic snapshots.
    for (let n = 1; n <= 103; n++)
      s.db.prepare('INSERT INTO event_room_plans VALUES(?,?,?,?)').run('listen', n, '[]', 'before');
    const first = (await s.get('history')).json(),
      second = (await s.get('history?before=' + first.next_before)).json(),
      third = (await s.get('history?before=' + second.next_before)).json();
    expect(first.next_before).toBe(54);
    expect(second.next_before).toBe(4);
    expect(third.next_before).toBeNull();
    expect([...first.revisions, ...second.revisions, ...third.revisions].map((r) => r.version)).toEqual(
      Array.from({ length: 103 }, (_, i) => 103 - i),
    );
    expect((await s.get('history/9')).json()).toMatchObject({
      version: 9,
      historical: true,
      kind: 'plan',
      rooms: [],
    });
    for (const suffix of [
      'history?before=0',
      'history?before=1.1',
      'history?before=9007199254740992',
      'history?before=abc',
      'history?extra=x',
      'history/0',
      'history/1.2',
    ])
      expect((await s.get(suffix)).statusCode).toBe(400);
  });
  it('matches the original public room cards and Python roster while leaving business and bot data untouched', async () => {
    const s = await setup();
    await s.plan();
    const path = join(s.root, 'source.sqlite3');
    await s.db.backup(path);
    const original = JSON.parse(
      execFileSync(
        'python3',
        [
          '-c',
          `import json,sqlite3,sys
from qgroup_core import roster,rooms
db=sqlite3.connect(sys.argv[1]);db.row_factory=sqlite3.Row
event=db.execute("SELECT * FROM events WHERE id='listen'").fetchone()
print(json.dumps(dict(participants=roster.serialize(db,event,'alice')['participants'],room_plan=rooms.plan(db,'listen'))))`,
          path,
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, QQ_APP_ID: '', QQ_SECRET: '' },
        },
      ),
    );
    const render = runInNewContext(readFileSync('public/rooms.js', 'utf8') + '\nroomPlanSection;') as (
      event: object,
      esc: (text: string) => string,
    ) => string;
    const html = render(original, String),
      actual = (await s.get()).json();
    expect(html).toContain('我的包间：' + actual.rooms[0].name);
    expect(html).toContain('店家付款／收款人：' + actual.rooms[0].payer_name);
    expect(html).toContain('待分配 · ' + actual.unassigned.length + ' 人');
    for (const person of actual.rooms[0].people) {
      expect(html).toContain(person.name);
      if (person.is_me) expect(html).toContain('我</span>');
      if (person.managed_guest) expect(html).toContain('我代报</span>');
    }
    const tables = [
      'events',
      'attendees',
      'event_room_plans',
      'event_audit',
      'settlement_history',
      'finance_entries',
      'bot_settings',
      'bot_outbox',
    ];
    const before = tables.map((table) => s.db.prepare('SELECT * FROM ' + table).all());
    for (const headers of [s.alice, s.bob, {}])
      for (const suffix of ['overview', 'history', 'history/1'])
        expect((await s.get(suffix, headers)).statusCode).toBe(200);
    expect(tables.map((table) => s.db.prepare('SELECT * FROM ' + table).all())).toEqual(before);
  });
});
