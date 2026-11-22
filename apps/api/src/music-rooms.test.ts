import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '@qgroup/database';
import { RoomLabResult, RoomLabSource } from '@qgroup/contracts';
import { fixture } from '../testsupport/fixture';
import { adminCatalogFixture, catalogProfiles } from '../testsupport/admin-catalog-fixture';
import { createApp } from './app';
import { createRoomJobs } from './music-room-jobs';
import { atRoomWorkerResult } from '../testsupport/room-worker-boundary';
import { musicRoomSource } from './music-room-source';
const origin = 'https://rebuild.example',
  cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup() {
  const db = openDatabase(':memory:');
  fixture(db);
  adminCatalogFixture(db);
  db.exec(
    "INSERT INTO roster_parties(id,event_id,manager_id,queue_mode,created_at) VALUES('party','listen','alice','individual','now'); INSERT INTO attendees(id,event_id,manager_id,user_id,party_id,name,payer_kind,status,created_at,updated_at) VALUES('att-alice','listen','alice','alice','party','原名','self','confirmed','now','now'),('att-bob','listen','alice','bob','party','原名','self','waiting','now','now'),('att-guest','listen','alice',NULL,'party','未認領同行','manager','tentative','now','now')",
  );
  const app = createApp({ db, origin });
  await app.ready();
  cleanup.push(async () => {
    await app.close();
    db.close();
  });
  const cookie = 'kanban_session=fixture-alice',
    viewer = (await app.inject({ url: '/api/v2/session', headers: { cookie } })).json();
  const headers = {
    cookie,
    origin,
    'x-account-scope': viewer.scope,
    'x-csrf-token': viewer.csrf,
  };
  const read = (eventId = '', h = headers) =>
    app.inject({
      url: '/api/v2/music/rooms/source' + (eventId ? '?eventId=' + eventId : ''),
      headers: h,
    });
  const calculate = (payload: unknown, eventId = '', h = headers) =>
    app.inject({
      method: 'POST',
      url: '/api/v2/music/rooms/calculate' + (eventId ? '?eventId=' + eventId : ''),
      headers: h,
      payload: payload as Record<string, unknown>,
    });
  return { db, app, headers, read, calculate };
}
describe('scoped music room source and CPU jobs', () => {
  it('loads current formal rooms as a whitelisted source, retains unmatched people and invalidates calculations after a plan update without mutating formal data', async () => {
    const s=await setup(),before=(await s.read('listen')).json();
    const room={id:'original-room-id',name:'原包間名稱',payer_id:'private-payer',payer_name:'private-payer-name',payer_label:'private-label',person_ids:['att-alice','att-bob','att-guest']};
    s.db.prepare('INSERT INTO event_room_plans(event_id,version,snapshot_json,created_at) VALUES(?,?,?,?)')
      .run('listen',1,JSON.stringify([room]),'now');
    const source=(await s.read('listen')).json();
    expect(source.currentRooms).toEqual({kind:'plan',version:1,rooms:[{id:room.id,name:room.name,members:room.person_ids}]});
    expect(source.sourceVersion).not.toBe(before.sourceVersion);
    expect(JSON.stringify(source)).not.toMatch(/private-payer|private-label|note|gender|tieBreakOrder/);
    const tables=(s.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[]).map(t=>t.name);
    const snapshot=()=>tables.map(t=>s.db.prepare('SELECT * FROM "'+t+'" ORDER BY rowid').all()),saved=snapshot();
    const payload={command:'recalc',sourceVersion:source.sourceVersion,selected:['att-alice','att-bob'],rooms:[{id:'00000000-0000-4000-8000-000000000001',capacity:3,members:room.person_ids}]};
    const response=await s.calculate(payload,'listen');expect(response.statusCode,response.body).toBe(200);
    expect(response.json().rooms[0].members).toEqual(room.person_ids);
    expect(response.json().rooms[0].analysis.members.map((m:{id:string})=>m.id)).toEqual(['att-alice','att-bob']);
    expect(snapshot()).toEqual(saved);
    s.db.prepare('INSERT INTO event_room_plans(event_id,version,snapshot_json,created_at) VALUES(?,?,?,?)')
      .run('listen',2,JSON.stringify([{...room,name:'修改後包間'}]),'later');
    expect((await s.calculate(payload,'listen')).statusCode).toBe(409);
    expect((await s.read('listen')).json().currentRooms.version).toBe(2);
    // Original bills need no native editor-only fields for a room projection.
    s.db.prepare("INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,updated_at,actor_id,actor_name,kind,changed_fields) VALUES('listen',1,0,2,'','now','alice','A','created','[]')").run();
    s.db.prepare('INSERT INTO settlement_details VALUES(?,?,?)').run('listen',1,JSON.stringify({
      people:[{id:'att-alice',label:'原帳單姓名',status:'confirmed'},{id:'att-bob',label:'原同房姓名',status:'waiting'}],
      rooms:[{...room,name:'實際包間'}],
    }));
    const actual=(await s.read('listen')).json();
    expect(actual.currentRooms).toMatchObject({kind:'actual',version:1,rooms:[{name:'實際包間'}]});
    const overview=await s.app.inject({url:'/api/v2/activities/listen/rooms/overview',headers:s.headers});
    expect(overview.statusCode,overview.body).toBe(200);
    expect(overview.json().rooms[0].people[0].name).toBe('原帳單姓名');
    s.db.prepare("INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,updated_at,actor_id,actor_name,kind,changed_fields) VALUES('listen',2,0,2,'','now','alice','A','created','[]')").run();
    s.db.prepare('INSERT INTO settlement_details VALUES(?,?,?)').run('listen',2,JSON.stringify({people:[],rooms:[]}));
    expect((await s.read('listen')).json().currentRooms).toEqual({kind:'actual',version:2,rooms:[]});
  });
  it('keeps original identity ties through free/activity workers, hides ranks and rejects stale identity ordering', async () => {
    const s = await setup();
    // Equal selections force ties; the original keys order Bob before Alice,
    // opposite to both public profile IDs and attendee IDs.
    s.db.prepare('DELETE FROM music_selections WHERE profile_id=?').run(catalogProfiles.bob);
    s.db.prepare('INSERT INTO music_selections SELECT ?,entry_id,level,position FROM music_selections WHERE profile_id=?')
      .run(catalogProfiles.bob, catalogProfiles.alice);
    s.db.prepare("INSERT INTO music_legacy_profiles VALUES(?,'10020','詞庫alice',1,'private','10020','{}','[]','oauth')")
      .run(catalogProfiles.alice);
    const free = musicRoomSource(s.db, 'alice', null), activity = musicRoomSource(s.db, 'alice', 'listen');
    expect(free.work.find(m => m.id === catalogProfiles.bob)!.tieBreakOrder)
      .toBeLessThan(free.work.find(m => m.id === catalogProfiles.alice)!.tieBreakOrder!);
    expect(activity.work.find(m => m.id === 'att-bob')!.tieBreakOrder)
      .toBe(free.work.find(m => m.id === catalogProfiles.bob)!.tieBreakOrder);
    expect(activity.work.find(m => m.id === 'att-guest')!.tieBreakOrder).toBeUndefined();
    expect(JSON.stringify([free.work, activity.work])).not.toMatch(/10002|10020|legacy_key|pin_hash/);
    for (const eventId of ['', 'listen']) {
      const source = (await s.read(eventId)).json(), selected = eventId
        ? ['att-alice', 'att-bob'] : [catalogProfiles.alice, catalogProfiles.bob];
      const analyzed = await s.calculate({command:'analyze',sourceVersion:source.sourceVersion,selected},eventId);
      expect(analyzed.statusCode,analyzed.body).toBe(200);
      expect(analyzed.json().analysis.loner.id).toBe(selected[1]);
      const split = await s.calculate({command:'split',sourceVersion:source.sourceVersion,selected,config:{mode:'rooms',value:2},sameGender:false},eventId);
      expect(split.statusCode,split.body).toBe(200);
      expect(split.json().rooms.map((r: {members:string[]}) => r.members)).toEqual([[selected[1]],[selected[0]]]);
      expect(JSON.stringify(source)+analyzed.body+split.body).not.toMatch(/tieBreakOrder|10002|10020|legacy_key|pin_hash/);
      expect((await s.calculate({command:'analyze',sourceVersion:source.sourceVersion,selected,tieBreakOrder:0},eventId)).statusCode).toBe(400);
    }
    const previous = (await s.read()).json();
    s.db.prepare("UPDATE music_legacy_profiles SET legacy_key='10001' WHERE profile_id=?").run(catalogProfiles.alice);
    const latest = (await s.read()).json();
    expect(latest.sourceVersion).not.toBe(previous.sourceVersion);
    expect((await s.calculate({command:'analyze',sourceVersion:previous.sourceVersion,selected:[catalogProfiles.alice,catalogProfiles.bob]})).statusCode).toBe(409);
  });
  it('analyzes and splits free picks, then recalculates manual moves with duplicate/capacity/conservation validation and no database writes', async () => {
    const s = await setup(),
      source = RoomLabSource.parse((await s.read()).json()),
      selected = [catalogProfiles.alice, catalogProfiles.bob, catalogProfiles.orphan];
    const tables = (
        s.db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
          .all() as { name: string }[]
      ).map((row) => row.name),
      snapshot = () => tables.map((table) => s.db.prepare('SELECT * FROM "' + table + '" ORDER BY rowid').all()),
      before = snapshot();
    const analyzed = await s.calculate({
      command: 'analyze',
      sourceVersion: source.sourceVersion,
      selected,
    });
    expect(analyzed.statusCode, analyzed.body).toBe(200);
    expect(RoomLabResult.parse(analyzed.json()).analysis?.members).toHaveLength(3);
    const response = await s.calculate({
      command: 'split',
      sourceVersion: source.sourceVersion,
      selected,
      config: { mode: 'sizes', sizes: [1, 2] },
      sameGender: true,
    });
    expect(response.statusCode, response.body).toBe(200);
    const result = RoomLabResult.parse(response.json());
    expect(result.rooms.flatMap((room) => room.members).sort()).toEqual([...selected].sort());
    expect(result.rooms.every((room) => room.members.length <= room.capacity)).toBe(true);
    const rooms = [
      { ...result.rooms[0]!, capacity: 3, members: selected },
      { ...result.rooms[1]!, members: [] },
    ].map(({ id, capacity, members }) => ({ id, capacity, members }));
    const moved = await s.calculate({
      command: 'recalc',
      sourceVersion: source.sourceVersion,
      selected,
      rooms,
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(RoomLabResult.parse(moved.json()).rooms[0]!.analysis).toEqual(analyzed.json().analysis);
    for (const bad of [
      rooms.map((room) => ({ ...room, members: selected })),
      [{ ...rooms[0], capacity: 1 }],
      [{ ...rooms[0], members: ['unknown'] }],
    ])
      expect(
        (
          await s.calculate({
            command: 'recalc',
            sourceVersion: source.sourceVersion,
            selected,
            rooms: bad,
          })
        ).statusCode,
      ).toBe(400);
    expect(snapshot()).toEqual(before);
    expect(response.body).not.toMatch(/note|gender|contact|private|fields_json|token|pin_hash|user_id/);
  });
  it('uses stable attendee IDs and current account ownership, retaining unmatched/closed-account/waiting/tentative attendees without guessing by names or managers', async () => {
    const s = await setup(),
      source = RoomLabSource.parse((await s.read('listen')).json());
    expect(source.members).toMatchObject([
      {
        id: 'att-alice',
        name: '小青',
        profileId: catalogProfiles.alice,
        status: 'confirmed',
      },
      { id: 'att-bob', profileId: catalogProfiles.bob, status: 'waiting' },
      { id: 'att-guest', profileId: null, status: 'tentative' },
    ]);
    expect(source.canAdopt).toBe(true);
    expect(source.selfId).toBe('att-alice');
    const selected = ['att-alice', 'att-bob'],
      response = await s.calculate(
        {
          command: 'split',
          sourceVersion: source.sourceVersion,
          selected,
          config: { mode: 'rooms', value: 2 },
          sameGender: false,
        },
        'listen',
      );
    expect(response.statusCode, response.body).toBe(200);
    const result = RoomLabResult.parse(response.json()),
      rooms = result.rooms.map(({ id, members }) => ({
        id,
        capacity: 3,
        members,
      }));
    rooms[0]!.members.push('att-guest');
    const moved = await s.calculate(
      {
        command: 'recalc',
        sourceVersion: source.sourceVersion,
        selected,
        rooms,
      },
      'listen',
    );
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json().rooms[0].members).toContain('att-guest');
    expect(
      moved
        .json()
        .rooms.flatMap((room: { analysis: { members: { id: string }[] } }) => room.analysis.members.map((m) => m.id)),
    ).not.toContain('att-guest');
    s.db.prepare('UPDATE music_profiles SET user_id=NULL WHERE id=?').run(catalogProfiles.bob);
    const changed = RoomLabSource.parse((await s.read('listen')).json());
    expect(changed.members.find((m) => m.id === 'att-bob')?.profileId).toBe(null);
    expect(changed.sourceVersion).not.toBe(source.sourceVersion);
    expect(
      (await s.calculate({ command: 'analyze', sourceVersion: source.sourceVersion, selected }, 'listen')).statusCode,
    ).toBe(409);
  });
  it('rejects stale saved picks/catalog/visible gender, wrong scope, CSRF, unknown or duplicate people, unknown fields and inaccessible activities', async () => {
    const s = await setup(),
      source = RoomLabSource.parse((await s.read()).json()),
      body = {
        command: 'analyze',
        sourceVersion: source.sourceVersion,
        selected: [catalogProfiles.alice, catalogProfiles.bob],
      };
    expect((await s.read('', { ...s.headers, cookie: '' })).statusCode).toBe(401);
    expect((await s.read('', { ...s.headers, 'x-account-scope': 'wrong' })).statusCode).toBe(409);
    expect((await s.read('missing')).statusCode).toBe(404);
    const bob = (
      await s.app.inject({ url: '/api/v2/session', headers: { cookie: 'kanban_session=fixture-bob' } })
    ).json();
    expect(
      (
        await s.read('invite', {
          ...s.headers,
          cookie: 'kanban_session=fixture-bob',
          'x-account-scope': bob.scope,
          'x-csrf-token': bob.csrf,
        })
      ).statusCode,
    ).toBe(404);
    s.db
      .prepare("UPDATE music_profile_fields SET gender='private-change',gender_public=0 WHERE profile_id=?")
      .run(catalogProfiles.bob);
    expect(RoomLabSource.parse((await s.read()).json()).sourceVersion).toBe(source.sourceVersion);

    expect((await s.calculate(body, '', { ...s.headers, 'x-csrf-token': 'wrong' })).statusCode).toBe(403);
    for (const patch of [
      { selected: [catalogProfiles.alice] },
      { selected: [catalogProfiles.alice, catalogProfiles.alice] },
      { selected: [catalogProfiles.alice, 'unknown'] },
      { userId: 'bob' },
    ])
      expect((await s.calculate({ ...body, ...patch })).statusCode).toBe(400);
    s.db.prepare('UPDATE music_selections SET level=2 WHERE profile_id=?').run(catalogProfiles.bob);
    expect((await s.calculate(body)).statusCode).toBe(409);
    const fresh = RoomLabSource.parse((await s.read()).json());
    s.db
      .prepare("UPDATE music_profile_fields SET gender='female',gender_public=1 WHERE profile_id=?")
      .run(catalogProfiles.bob);
    expect((await s.calculate({ ...body, sourceVersion: fresh.sourceVersion })).statusCode).toBe(409);
    const latest = RoomLabSource.parse((await s.read()).json());
    s.db.prepare("UPDATE music_entries SET name='new-name' WHERE id='main-0'").run();
    expect((await s.calculate({ ...body, sourceVersion: latest.sourceVersion })).statusCode).toBe(409);
  });
  it('revalidates after asynchronous work, rejects late data/account revocation and keeps private gender/notes outside responses', async () => {
    const s = await setup(),
      source = RoomLabSource.parse((await s.read()).json()),
      payload = {
        command: 'analyze',
        sourceVersion: source.sourceVersion,
        selected: [catalogProfiles.alice, catalogProfiles.bob],
      };
    const changedBoundary = atRoomWorkerResult(source.sourceVersion, () => {
      s.db.prepare("UPDATE music_profile_fields SET name='changed-during-job' WHERE profile_id=?").run(catalogProfiles.bob);
    });
    try {
      const late = await s.calculate(payload);
      expect(changedBoundary.calls).toBe(1);
      expect(late.statusCode, late.body).toBe(409);
      expect(late.json().message).toContain('這次結果已失效');
    } finally { changedBoundary.restore(); }
    const changed = await s.read();
    expect(changed.body).not.toMatch(/note|gender|contact|私人|不可匯出|token|pin|selections|userId/);
    expect(changed.headers['cache-control']).toBe('no-store');
    const version = RoomLabSource.parse(changed.json()).sourceVersion;
    const revokedBoundary = atRoomWorkerResult(version, () => {
      s.db.prepare("DELETE FROM browser_sessions WHERE user_id='alice'").run();
    });
    try {
      expect((await s.calculate({ ...payload, sourceVersion: version })).statusCode).toBe(401);
      expect(revokedBoundary.calls).toBe(1);
    } finally { revokedBoundary.restore(); }

  });

  it('adopts through the existing owner/revision/receipt guard and replays successful results even when the music source later changes', async () => {
    const s = await setup(),
      source = RoomLabSource.parse((await s.read('listen')).json());
    const current = (
      await s.app.inject({
        url: '/api/v2/activities/listen/rooms',
        headers: s.headers,
      })
    ).json();
    const rooms = [
      {
        id: 'a'.repeat(16),
        name: '包間一',
        payer_id: current.payers[0].id,
        person_ids: ['att-alice', 'att-bob', 'att-guest'],
      },
    ];
    const payload = {
        revision: current.revision,
        rooms,
        reason: '採用試算',
        music_source_version: source.sourceVersion,
        confirm: true,
      },
      key = crypto.randomUUID();
    const save = (body: Record<string, unknown> = payload, k = key, headers = s.headers) =>
      s.app.inject({
        method: 'POST',
        url: '/api/v2/activities/listen/rooms',
        headers: { ...headers, 'idempotency-key': k },
        payload: body,
      });
    for (const [index, status] of ['pending', 'sending', 'sent', 'failed', 'skipped', 'skipped'].entries())
      s.db
        .prepare(
          `INSERT INTO bot_outbox(event_id,kind,dedupe_key,target,payload_json,status,attempts,claim_token,retry_at,simulated_at,delivered_payload_json,last_error,created_at) VALUES('listen','synthetic',?,'synthetic-group','{"template_version":1}',?,3,'synthetic-claim','later',?,?,?,'before')`,
        )
        .run(
          String(index),
          status,
          index === 4 ? 'simulation-only' : null,
          ['sent', 'skipped'].includes(status) ? '{}' : null,
          index === 5 ? 'platform delivery uncertain' : '',
        );
    s.db.exec(
      "INSERT INTO bot_groups VALUES('synthetic-group','before','before','join','joined'); INSERT INTO bot_group_ignores(group_id,reason,created_at) VALUES('synthetic-group','paused','before'); UPDATE bot_settings SET revision=3; INSERT INTO bot_settings_history VALUES(3,'{}','before','synthetic','save'); UPDATE bot_runtime SET applied_revision=3",
    );
    const tables = (
        s.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'bot_%' OR name LIKE '%outbox%') ORDER BY name",
          )
          .all() as { name: string }[]
      ).map((row) => row.name),
      snapshot = () => tables.map((table) => s.db.prepare('SELECT * FROM "' + table + '" ORDER BY rowid').all()),
      before = snapshot();
    const outdated = await save({ ...payload, music_source_version: 'a'.repeat(64) }, crypto.randomUUID());
    expect(outdated.statusCode, outdated.body).toBe(409);
    const accepted = await save();
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json().changed).toBe(true);
    s.db.prepare('UPDATE music_selections SET level=2 WHERE profile_id=?').run(catalogProfiles.bob);
    const replay = await save();
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual(accepted.json());
    const directory = mkdtempSync(join(tmpdir(), 'qgroup-room-bot-'));
    try {
      const file = join(directory, 'synthetic.sqlite3'),
        bytes = s.db.serialize();
      bytes[18] = 1;
      bytes[19] = 1;
      writeFileSync(file, bytes);
      const legacy = JSON.parse(
        execFileSync(
          'python3',
          [
            '-c',
            `import json,sqlite3,sys
from pathlib import Path
from qgroup_core import rooms,bot_views
with sqlite3.connect(Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True) as db:
 db.row_factory=sqlite3.Row
 event=db.execute("SELECT * FROM events WHERE id='listen'").fetchone()
 print(json.dumps(dict(plan=rooms.plan(db,'listen'),current=rooms.current(db,'listen'),counts=bot_views.counts(db,'listen'),roster=bot_views.roster_lines(db,event)),ensure_ascii=False))`,
            file,
          ],
          { encoding: 'utf8' },
        ),
      );
      const native = (
        await s.app.inject({
          url: '/api/v2/activities/listen/rooms',
          headers: s.headers,
        })
      ).json();
      expect(legacy.plan).toEqual(native.rooms);
      expect(legacy.current).toEqual(native.rooms);
      expect(legacy.counts).toMatchObject({
        confirmed: 1,
        waiting: 1,
        tentative: 1,
      });
      expect(legacy.roster.join('\n')).toContain('小青');
      expect(legacy.roster.join('\n')).toContain('小白');
      expect(legacy.plan.flatMap((room: { person_ids: string[] }) => room.person_ids)).toContain('att-guest');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }

    const fresh = (
      await s.app.inject({
        url: '/api/v2/activities/listen/rooms',
        headers: s.headers,
      })
    ).json();
    expect(fresh.rooms[0].person_ids).toEqual(['att-alice', 'att-bob', 'att-guest']);
    expect((await save({ ...payload, revision: fresh.revision }, crypto.randomUUID())).statusCode).toBe(409);
    const manual = await save(
      { ...payload, revision: fresh.revision, music_source_version: undefined },
      crypto.randomUUID(),
    );
    expect(manual.statusCode, manual.body).toBe(200);
    const bob = (
      await s.app.inject({
        url: '/api/v2/session',
        headers: { cookie: 'kanban_session=fixture-bob' },
      })
    ).json();
    expect(
      (
        await save({ ...payload, revision: fresh.revision }, crypto.randomUUID(), {
          cookie: 'kanban_session=fixture-bob',
          origin,
          'x-account-scope': bob.scope,
          'x-csrf-token': bob.csrf,
        })
      ).statusCode,
    ).toBe(403);
    expect(snapshot()).toEqual(before);
    expect(s.db.prepare('SELECT count(*) n FROM event_room_plans').get()).toEqual({ n: 1 });
  });
  it('terminates timed out and in-flight workers without publishing late results', async () => {
    const task = {
      input: {
        command: 'analyze' as const,
        sourceVersion: 'a'.repeat(64),
        selected: ['a', 'b'],
      },
      members: [
        { id: 'a', name: 'A', selections: [] },
        { id: 'b', name: 'B', selections: [] },
      ],
      entries: [],
    };
    const jobs = createRoomJobs();
    vi.useFakeTimers();
    try {
      const timed = expect(jobs.run(task)).rejects.toThrow('逾時');
      await vi.advanceTimersByTimeAsync(5000);
      await timed;
      vi.useRealTimers();
      const pending = expect(jobs.run(task)).rejects.toThrow('已停止');
      await jobs.close();
      await pending;
      expect(() => jobs.run(task)).toThrow('忙碌');
    } finally {
      vi.useRealTimers();
      await jobs.close();
    }
  });
  it('bounds worker concurrency, propagates shutdown and permits a new task after workers finish', async () => {
    const jobs = createRoomJobs();
    try {
      const task = {
        input: {
          command: 'analyze' as const,
          sourceVersion: 'a'.repeat(64),
          selected: ['a', 'b'],
        },
        members: [
          { id: 'a', name: 'A', selections: [] },
          { id: 'b', name: 'B', selections: [] },
        ],
        entries: [],
      };
      const first = jobs.run(task),
        second = jobs.run(task);
      expect(() => jobs.run(task)).toThrow('忙碌');
      await Promise.all([first, second]);
      expect((await jobs.run(task)).algorithm).toBe('music-rooms-v1');
      await jobs.close();
      expect(() => jobs.run(task)).toThrow('忙碌');
    } finally {
      await jobs.close();
    }
  });
});
