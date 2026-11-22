import { randomUUID } from 'node:crypto';
import { BotOutboxWorker } from '../../bot/src/outbox';
import { loadBotConfig } from '../../bot/src/config';
import type { APIObject } from '../../bot/src/protocol';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { SettlementInput, SettlementContext, SettlementPreview, SettlementView, SettlementSnapshot, StoredSettlementSnapshot } from '@qgroup/contracts';
import { fixture } from '../testsupport/fixture';
import { createApp } from './app';
import { eventRow } from './activity-arrangements';
import { accountKey, financeEntries } from './finance-context';
import { calculateSettlement } from './settlement-calculation';
import { settlementDetail } from './settlement-context';
import { settlementNotice } from './settlement-notice';
import { pngChunk, testPNG } from '../testsupport/payment-fixture';
import { activityBotPolicy, buildActivityBotMessage, renderActivityBot } from './activity-bot';
const origin = 'https://rebuild.example',
  stamp = '2026-11-17T00:00:00+00:00',
  a = accountKey('listen', 'alice'),
  b = accountKey('listen', 'bob'),
  p1 = 'aaaaaaaaaaaaaaaa',
  p2 = 'bbbbbbbbbbbbbbbb',
  p3 = 'cccccccccccccccc',
  i1 = '1111111111111111',
  i2 = '2222222222222222';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'qgroup-native-settlement-')),
    db = openDatabase(join(root, 'state.db'));
  fixture(db);
  db.exec(
    `UPDATE events SET lifecycle='ended',bot_enabled=1 WHERE id='listen'; INSERT INTO event_roles VALUES('helper','listen','bob','["settlement"]','before'); INSERT INTO attendees(id,event_id,manager_id,user_id,name,payer_kind,status,confirmation_state,accepted_conditions_version,created_at,updated_at) VALUES('${p1}','listen','alice','alice','','self','confirmed','accepted',1,'before','before'),('${p2}','listen','bob','bob','','self','confirmed','accepted',1,'before','before'),('${p3}','listen','alice',NULL,'同行','self','confirmed','accepted',1,'before','before')`,
  );
  db.prepare('UPDATE bot_settings SET config_json=?').run(
    JSON.stringify({
      enabled: true,
      groups: [{ id: 'synthetic-group', name: '測試', replies: true, broadcast: true }],
    }),
  );
  const app = createApp({
    db,
    origin,
    now: () => new Date(stamp),
    activityBot: { enabled: true, baseURL: origin, keyboard: true, personalQueue: true },
  });
  await app.ready();
  cleanup.push(async () => {
    await app.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  async function headers(id: string) {
    const cookie = 'kanban_session=fixture-' + id,
      s = (await app.inject({ url: '/api/v2/session', headers: { cookie } })).json();
    return { cookie, origin, 'x-account-scope': s.scope, 'x-csrf-token': s.csrf };
  }
  const alice = await headers('alice'),
    bob = await headers('bob');
  const input = (patch: object = {}) =>
    SettlementInput.parse({
      revision: eventRow(db, 'listen')!.revision,
      base_version: (
        db.prepare("SELECT COALESCE(MAX(version),0) AS n FROM settlement_history WHERE event_id='listen'").get() as {
          n: number;
        }
      ).n,
      reviewed_roster: true,
      people: [{ id: p1 }, { id: p2 }, { id: p3 }],
      items: [{ id: i1, name: '消費', amount: '10.00' }],
      ...patch,
    });
  const preview = (data = input(), h = alice) =>
    app.inject({ method: 'POST', url: '/api/v2/activities/listen/settlement/preview', headers: h, payload: data });
  const send = (data: object, h = alice, key = randomUUID()) =>
    app.inject({
      method: 'POST',
      url: '/api/v2/activities/listen/settlement',
      headers: { ...h, 'idempotency-key': key },
      payload: data,
    });
  const save = async (data = input(), h = alice) => {
    const p = await preview(data, h);
    expect(p.statusCode, p.body).toBe(200);
    const value = await send({ ...data, preview_token: p.json().preview_token, confirm: true }, h);
    expect(value.statusCode, value.body).toBe(200);
    return value;
  };
  return { db, root, app, alice, bob, input, preview, send, save };
}
type Setup = Awaited<ReturnType<typeof setup>>;
async function python(
  s: Setup,
  data: object,
  extra = 'print(json.dumps(settlements.calculate(db,event,user,data)[0]))',
) {
  const folder = mkdtempSync(join(tmpdir(), 'qgroup-settlement-')),
    path = join(folder, 'synthetic.sqlite3'),
    input = join(folder, 'input.json');
  try {
    await s.db.backup(path);
    if (existsSync(join(s.root, 'images'))) cpSync(join(s.root, 'images'), join(folder, 'images'), { recursive: true });
    writeFileSync(input, JSON.stringify(data));
    return JSON.parse(
      execFileSync(
        'python3',
        [
          '-c',
          `import datetime,json,sqlite3,sys
from qgroup_core import settlements,finance,bot_outbox,bot_settings,audit,rooms
class Frozen(datetime.datetime):
 @classmethod
 def now(cls,tz=None):return datetime.datetime.fromisoformat('${stamp}').astimezone(tz)
finance.datetime=Frozen;bot_outbox.datetime=Frozen
for module in (settlements,finance,bot_outbox,bot_settings,audit,rooms):module.now=lambda:'${stamp}'
db=sqlite3.connect(sys.argv[1]);db.row_factory=sqlite3.Row
event=db.execute("SELECT * FROM events WHERE id='listen'").fetchone();user=db.execute("SELECT * FROM users WHERE id='alice'").fetchone();data=json.load(open(sys.argv[2]))
${extra}`,
          path,
          input,
        ],
        {
          encoding: 'utf8',
          timeout: 15000,
          env: { ...process.env, QQ_APP_ID: '', QQ_SECRET: '', KANBAN_BOT_BASE_URL: origin, KANBAN_BOT_KEYBOARD: '1' },
        },
      ),
    );
  } finally {
    rmSync(folder, { force: true, recursive: true });
  }
}
const compare = (snapshot: unknown, expected: any) =>
  expect(snapshot).toEqual({ ...expected, journal_seq: String(expected.journal_seq) });
describe('native settlement and rooms', () => {
  it('reads original detailed bills without later metadata and preserves history when reviewing a new strict version', async () => {
    const s = await setup(), historical = await python(s, s.input());
    for (const field of ['journal_seq', 'balances', 'group_notice']) delete historical[field];
    const raw = JSON.stringify(historical);
    s.db.prepare("INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,updated_at,actor_id,actor_name,kind,changed_fields) VALUES('listen',1,?,3,'','before','alice','小青','detailed_published','[]')")
      .run(historical.total_cents);
    s.db.prepare('INSERT INTO settlement_details VALUES(?,?,?)').run('listen', 1, raw);
    s.db.prepare("INSERT INTO settlements(event_id,total_cents,headcount,note,updated_at) VALUES('listen',?,3,'','before')")
      .run(historical.total_cents);
    expect(StoredSettlementSnapshot.parse(historical)).toEqual(historical);
    for (const invalid of [{balances:null}, {group_notice:'yes'}, {journal_seq:'1.5'}])
      expect(StoredSettlementSnapshot.safeParse({...historical,...invalid}).success).toBe(false);
    expect(SettlementSnapshot.safeParse(historical).success).toBe(false);
    expect(settlementDetail(s.db, 'listen')).toEqual(historical);
    for (const suffix of ['', '/context', '/history', '/history/1']) {
      const r = await s.app.inject({url: '/api/v2/activities/listen/settlement' + suffix, headers: s.alice});
      expect(r.statusCode, r.body).toBe(200);
      const value = r.json(), bill = suffix === '/history' ? value.revisions[0] : suffix === '/history/1' ? value : value.bill;
      expect(bill.detail).toEqual(historical);
      for (const key of ['journal_seq', 'balances', 'group_notice']) expect(bill.detail).not.toHaveProperty(key);
    }
    expect((await python(s, {}, "print(json.dumps(bot_outbox.build_message(db,event,'settlement_updated')[:2]))"))[0])
      .not.toContain('逐人 AA：');
    const originalNotice = buildActivityBotMessage(s.db, eventRow(s.db, 'listen')!, 'settlement_updated', activityBotPolicy(s.db).config, new Date(stamp), {baseURL:origin});
    expect(originalNotice?.text).not.toContain('逐人 AA：');
    expect(originalNotice?.context).not.toHaveProperty('_settlement_notice');
    const notice = settlementNotice(historical);
    expect(notice.join('\n')).toContain('付款账户应付合计：');
    expect(notice.join('\n')).not.toMatch(/无需补款|已投入|应退／待偿还/);
    const data = s.input({reason:'補核對收付款'}), preview = await s.preview(data);
    expect(preview.statusCode, preview.body).toBe(200);
    const strict = SettlementPreview.parse(preview.json());
    expect(strict.snapshot.group_notice).toBe(false);
    compare(strict.snapshot, await python(s, data));
    for (const key of ['journal_seq', 'balances', 'group_notice']) {
      const damaged = { ...strict.snapshot };
      delete (damaged as Record<string, unknown>)[key];
      expect(SettlementPreview.safeParse({...strict, snapshot: damaged}).success).toBe(false);
    }
    const expected = await python(s, data, `data['preview_token']=settlements.token(settlements.calculate(db,event,user,data)[0],event,data['base_version'])
settlements.save(db,event,user,data)
print(json.dumps(dict(detail=settlements.details(db,'listen',2),history=[dict(r) for r in db.execute("SELECT * FROM settlement_history ORDER BY version")])))`);
    const body = {...data, preview_token: strict.preview_token, confirm:true}, key = randomUUID(), saved = await s.send(body, s.alice, key);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({version:2,changed:true});
    compare(settlementDetail(s.db, 'listen'), expected.detail);
    const actualHistory = s.db.prepare("SELECT * FROM settlement_history ORDER BY version").all() as any[];
    expect(actualHistory.map(r=>({...r,changed_fields:JSON.parse(r.changed_fields)})))
      .toEqual(expected.history.map((r:any)=>({...r,changed_fields:JSON.parse(r.changed_fields)})));
    expect(s.db.prepare("SELECT snapshot_json FROM settlement_details WHERE version=1").get()).toEqual({snapshot_json:raw});
    const counts = () => ['settlement_history','settlement_details','finance_entries','event_audit','notifications','bot_outbox']
      .map(table=>s.db.prepare('SELECT COUNT(*) AS n FROM '+table).get());
    const once = counts(), retried = await s.send(body, s.alice, key);
    expect(retried.body).toBe(saved.body);
    expect(counts()).toEqual(once);
    const payloads = (s.db.prepare('SELECT payload_json FROM bot_outbox').all() as {payload_json:string}[]).map(r=>JSON.parse(r.payload_json));
    expect(payloads.length).toBeGreaterThan(0);
    for (const p of payloads) {
      expect(p.text).not.toContain('逐人 AA：');
      expect(p).not.toHaveProperty('_settlement_image');
    }
    expect((await s.save(s.input({reason:'再次核對'}))).json()).toMatchObject({version:2,changed:false});
    expect(settlementDetail(s.db, 'listen', 1)).toEqual(historical);
  });
  it('matches all five allocation modes, signed independent remainders, frozen roster order and split payment ownership', async () => {
    const s = await setup();
    for (const mode of ['shares', 'equal', 'weights', 'fixed', 'duration']) {
      const allocations = [p1, p2, p3].map((person_id, i) => ({
        person_id,
        ...(mode === 'weights'
          ? { weight: ['0.333', '0.667', '0'][i] }
          : mode === 'fixed'
            ? { amount: ['0.01', '0.01', '0.03'][i] }
            : mode === 'duration'
              ? { minutes: [20, 40, 0][i] }
              : {}),
      }));
      const data = s.input({
        people: [
          { id: p3 },
          { id: p2 },
          {
            id: p1,
            payments: [
              { payer_id: a, share: '1' },
              { payer_id: b, share: '2' },
            ],
            reason: '共同支付',
          },
        ],
        items: [{ id: i1, name: '消費', amount: '0.05', mode, reason: '分攤依據', allocations }],
      });
      const response = await s.preview(data);
      expect(response.statusCode, response.body).toBe(200);
      compare(response.json().snapshot, await python(s, data));
    }
    const data = s.input({
      items: [
        { id: i1, name: '消費', amount: '0.05' },
        { id: i2, name: '折扣', amount: '0.02', kind: 'discount', reason: '折扣' },
      ],
    });
    compare((await s.preview(data)).json().snapshot, await python(s, data));
    expect((await s.preview(data)).json().snapshot.people.map((p: { due_cents: number }) => p.due_cents)).toEqual([
      1, 1, 1,
    ]);
  });
  it('keeps same names separate, immutable origins, accepted versions and exceptions; requires all confirmed people', async () => {
    const s = await setup();
    s.db.exec(
      `UPDATE users SET nickname='同名'; INSERT INTO attendee_payment_origins VALUES('${p3}','person:${p3}','原同行',1,NULL); UPDATE attendees SET user_id='bob',status='withdrawn',attendance='absent',withdrawal_requested=1 WHERE id='${p3}'`,
    );
    expect((await s.preview(s.input())).statusCode).toBe(400);
    const data = s.input({ people: [{ id: p1 }, { id: p2 }, { id: p3, share: '0', reason: '免 A 核對' }] });
    compare((await s.preview(data)).json().snapshot, await python(s, data));
    expect((await s.preview(s.input({ people: [{ id: p1 }] }))).statusCode).toBe(400);
  });
  it('validates selected scopes, fixed sums, zero weights, refund caps, duplicates and exceptional reasons', async () => {
    const s = await setup();
    for (const patch of [
      { people: [{ id: p1 }, { id: p1 }, { id: p2 }, { id: p3 }] },
      { people: [{ id: p1, share: '0' }, { id: p2 }, { id: p3 }] },
      { items: [] },
      { items: [{ id: i1, name: '退款', kind: 'refund', amount: '1', reason: '退款' }] },
      { items: [{ id: i1, name: '費用', amount: '1', scope: 'selected', allocations: [] }] },
      {
        items: [
          {
            id: i1,
            name: '費用',
            amount: '1',
            mode: 'fixed',
            reason: '指定',
            allocations: [{ person_id: p1, amount: '1' }],
          },
        ],
      },
      {
        items: [
          {
            id: i1,
            name: '費用',
            amount: '1',
            mode: 'weights',
            reason: '比例',
            allocations: [p1, p2, p3].map((person_id) => ({ person_id, weight: '0' })),
          },
        ],
      },
    ])
      expect((await s.preview(s.input(patch))).statusCode, JSON.stringify(patch)).toBe(400);
    const free = s.input({
      items: [{ id: i1, name: '免費', amount: '0', scope: 'selected', reason: '免費', allocations: [] }],
    });
    expect((await s.save(free)).json()).toMatchObject({ version: 1, changed: true });
  });
  it('binds preview to revision, journal, images and versions, saves atomically and returns exact retry receipt before revision checks', async () => {
    const s = await setup(),
      data = s.input(),
      p = SettlementPreview.parse((await s.preview(data)).json()),
      payload = { ...data, preview_token: p.preview_token, confirm: true },
      key = randomUUID();
    s.db.exec(
      `INSERT INTO finance_entries(id,event_id,kind,payload_json,occurred_at,actor_id,actor_name,created_at) VALUES('${i2}','listen','expense','{"kind":"expense","amount_cents":1,"payer_id":"${a}","funding":"payer"}','before','alice','小青','before')`,
    );
    expect((await s.send(payload)).statusCode).toBe(409);
    const fresh = (await s.preview(data)).json();
    const sent = await s.send({ ...payload, preview_token: fresh.preview_token }, s.alice, key);
    expect(sent.statusCode, sent.body).toBe(200);
    expect((await s.send({ ...payload, preview_token: fresh.preview_token }, s.alice, key)).json()).toEqual(
      sent.json(),
    );
    expect((await s.send({ ...payload, note: '不同' }, s.alice, key)).statusCode).toBe(409);
    expect(s.db.prepare('SELECT * FROM settlement_details').all()).toHaveLength(1);
    expect(s.db.prepare("SELECT * FROM notifications WHERE kind='settlement_updated'").all()).toHaveLength(2);
    const view = await s.app.inject({ url: '/api/v2/activities/listen/settlement' });
    expect(view.statusCode, view.body).toBe(200);
    expect(SettlementView.parse(view.json()).bill?.mode).toBe('detailed');
  });
  it('requires a reason for edits and legacy conversion; retains old versions and does not create a repeated identical business version', async () => {
    const s = await setup();
    s.db.exec(
      "INSERT INTO settlements VALUES('listen',100,2,NULL,'old','before'); INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,updated_at,actor_id,actor_name,kind,changed_fields) VALUES('listen',1,100,2,'old','before','alice','小青','published','[]')",
    );
    expect((await s.preview(s.input())).statusCode).toBe(400);
    const data = s.input({ convert_legacy: true, reason: '逐人核對' });
    expect((await s.save(data)).json().version).toBe(2);
    expect((await s.save(s.input({ reason: '重複核對' }))).json()).toMatchObject({ version: 2, changed: false });
    expect((await s.app.inject({ url: '/api/v2/activities/listen/settlement/history/1' })).json()).toMatchObject({
      mode: 'legacy',
      total_amount: '1.00',
      per_person_amount: '0.50',
    });
    const edited = s.input({ reason: '修正', note: '新備註' });
    compare((await s.preview(edited)).json().snapshot, await python(s, edited));
    expect((await s.save(edited)).json().version).toBe(3);
  });
  it('records actual merchant payments separately, including external custom payer, and never invents payment from an amount', async () => {
    const s = await setup(),
      custom = 'custom:1234567890abcdef';
    const data = s.input({
      custom_payers: [{ id: custom, name: '外部墊款' }],
      merchant_payment: {
        mode: 'paid',
        amount: '12',
        payer_id: custom,
        merchant: '測試店家',
        occurred_at: stamp,
        method: 'cash',
      },
    });
    compare((await s.preview(data)).json().snapshot, await python(s, data));
    await s.save(data);
    expect(financeEntries(s.db, 'listen')).toHaveLength(1);
    expect(settlementDetail(s.db, 'listen')?.balances?.find((p) => p.id === custom)).toMatchObject({
      due_cents: 0,
      contributed_cents: 1200,
      balance_cents: -1200,
    });
    expect(
      (
        await s.preview(
          s.input({ reason: '重複付款', merchant_payment: data.merchant_payment, custom_payers: data.custom_payers }),
        )
      ).statusCode,
    ).toBe(409);
    expect((await s.preview(s.input({ reason: '已登記', merchant_payment: { mode: 'recorded' } }))).statusCode).toBe(
      200,
    );
  });
  it('normalizes actual rooms, preserves per-room balances and records multiple synthetic expenses in order', async () => {
    const s = await setup(),
      data = s.input({
        rooms: [
          { id: i1, name: '一房', payer_id: a, person_ids: [p2, p1], amount: '10', merchant_mode: 'paid' },
          { id: i2, name: '二房', payer_id: a, person_ids: [p3], amount: '5', merchant_mode: 'paid' },
        ],
        room_payment_details: { occurred_at: stamp, method: 'cash' },
      });
    const p = await s.preview(data);
    expect(p.statusCode, p.body).toBe(200);
    compare(p.json().snapshot, await python(s, data));
    await s.save(data);
    expect(financeEntries(s.db, 'listen').map((e) => e.payload.room_id)).toEqual([i1, i2]);
    expect(settlementDetail(s.db, 'listen')?.input.rooms?.[0]?.person_ids).toEqual([p1, p2]);
    expect((await s.preview(s.input({ reason: '遺漏包間' }))).statusCode).toBe(409);
    const changed = s.input({ reason: '協辦改動', rooms: data.rooms });
    expect((await s.preview(changed, s.bob)).statusCode).toBe(409);
  });
  it('allows only owner to plan rooms, rejects casefold duplicates and duplicate memberships, freezes canonical order without money', async () => {
    const s = await setup(),
      rooms = [{ id: i1, name: 'Straße', payer_id: a, person_ids: [p2, p1] }],
      send = (data: object, h = s.alice, key = randomUUID()) =>
        s.app.inject({
          method: 'POST',
          url: '/api/v2/activities/listen/rooms',
          headers: { ...h, 'idempotency-key': key },
          payload: data,
        }),
      data = { revision: 0, rooms, confirm: true };
    expect((await send(data, s.bob)).statusCode).toBe(403);
    expect(
      (await send({ ...data, rooms: [...rooms, { id: i2, name: 'STRASSE', payer_id: a, person_ids: [p3] }] }))
        .statusCode,
    ).toBe(400);
    expect(
      (await send({ ...data, rooms: [...rooms, { id: i2, name: '二房', payer_id: a, person_ids: [p2] }] })).statusCode,
    ).toBe(400);
    expect((await send(data)).json()).toMatchObject({ version: 1, changed: true });
    expect(financeEntries(s.db, 'listen')).toHaveLength(0);
    const ctx = SettlementContext.parse(
      (await s.app.inject({ url: '/api/v2/activities/listen/settlement/context', headers: s.alice })).json(),
    );
    expect(ctx.rooms[0]?.person_ids).toEqual([p1, p2]);
    expect((await send({ ...data, revision: 1 })).json()).toMatchObject({ version: 1, changed: false });
    expect((await s.preview(s.input())).statusCode).toBe(409);
  });
  it('protects permission, invitation, CSRF, scope and lifecycle gates before writes', async () => {
    const s = await setup();
    for (const url of ['/settlement/context', '/rooms'])
      expect((await s.app.inject({ url: '/api/v2/activities/listen' + url })).statusCode).toBe(401);
    expect((await s.preview(s.input(), { ...s.alice, 'x-csrf-token': '' })).statusCode).toBe(403);
    expect((await s.preview(s.input(), { ...s.alice, 'x-account-scope': 'stale' })).statusCode).toBe(409);
    s.db.exec("UPDATE events SET lifecycle='scheduled' WHERE id='listen'");
    expect((await s.preview()).statusCode).toBe(409);
    s.db.exec("UPDATE events SET lifecycle='ended'; UPDATE event_roles SET permissions_json='[]'");
    expect((await s.preview(s.input(), s.bob)).statusCode).toBe(403);
    expect((await s.app.inject({ url: '/api/v2/activities/invite/settlement' })).statusCode).toBe(404);
  });
  it('preserves all fifty planned room identities, permits partial membership and keeps same-payer rooms independent', async () => {
    const s = await setup(), rooms = Array.from({length:50}, (_,i)=>({
      id:(i+1).toString(16).padStart(16,'0'), name:i===0?'　'+ '𰀀'.repeat(40)+'　':'房 '+(i+1),
      payer_id:a, person_ids:i===0?[p3,p1]:[],
    })), data = {revision:0,rooms,confirm:true,reason:'核對部分安排'},
      send = (payload:object) => s.app.inject({method:'POST',url:'/api/v2/activities/listen/rooms',headers:{...s.alice,'idempotency-key':randomUUID()},payload});
    const expected = await python(s, {rooms,reason:data.reason}, `rooms.save_plan(db,event,user,data)
print(json.dumps(rooms.plan(db,'listen')))`);
    const before = ['attendees','settlements','settlement_history','settlement_details','finance_entries','bot_outbox','bot_settings']
      .map(table=>s.db.prepare('SELECT * FROM '+table).all());
    const saved = await send(data);
    expect(saved.statusCode, saved.body).toBe(200);
    const view = (await s.app.inject({url:'/api/v2/activities/listen/rooms',headers:s.alice})).json();
    expect(view.rooms).toEqual(expected);
    expect(view.rooms[0].name).toBe('𰀀'.repeat(40));
    expect(view.rooms[0].person_ids).toEqual([p1,p3]);
    expect(view.rooms).toHaveLength(50);
    expect(view.rooms.every((r:any)=>r.payer_id===a)).toBe(true);
    const committed = s.db.prepare('SELECT * FROM event_room_plans').all();
    for (const invalid of [
      [...rooms,{...rooms[0],id:'f'.repeat(16),name:'第 51 房',person_ids:[]}],
      rooms.map((r,i)=>i? r:{...r,name:'𰀀'.repeat(41)}),
      rooms.map((r,i)=>i===1?{...r,person_ids:[p1]}:r),
    ]) expect((await send({...data,revision:1,rooms:invalid})).statusCode).toBe(400);
    expect(s.db.prepare('SELECT * FROM event_room_plans').all()).toEqual(committed);
    expect(['attendees','settlements','settlement_history','settlement_details','finance_entries','bot_outbox','bot_settings']
      .map(table=>s.db.prepare('SELECT * FROM '+table).all())).toEqual(before);
  });
  it('matches original edge whitespace in native plans and actual-room previews without changing room identity', async () => {
    const s = await setup();
    for (const edge of ['\u0085','\u001c','\ufeff']) {
      const rooms = [{id:i1,name:edge+'房'+edge,payer_id:a,person_ids:[p3,p2,p1]}], reason=edge+'核對'+edge,
        expected = await python(s,{rooms,reason},`rooms.save_plan(db,event,user,data)
print(json.dumps(dict(rooms=rooms.plan(db,'listen'),reason=db.execute("SELECT reason FROM event_audit WHERE event_id='listen' ORDER BY version DESC LIMIT 1").fetchone()[0])))`),
        saved = await s.app.inject({method:'POST',url:'/api/v2/activities/listen/rooms',headers:{...s.alice,'idempotency-key':randomUUID()},payload:{revision:eventRow(s.db,'listen')!.revision,rooms,reason,confirm:true}});
      expect(saved.statusCode,saved.body).toBe(200);
      expect((await s.app.inject({url:'/api/v2/activities/listen/rooms',headers:s.alice})).json().rooms).toEqual(expected.rooms);
      expect(s.db.prepare("SELECT reason FROM event_audit WHERE event_id='listen' ORDER BY version DESC LIMIT 1").get()).toEqual({reason:expected.reason});
      const input = s.input({rooms:rooms.map(r=>({...r,amount:'10'}))});
      compare((await s.preview(input)).json().snapshot,await python(s,input));
    }
  });
  it('rolls back bill, money, audit and notifications on required failures while isolating optional bot failures', async () => {
    const s = await setup();
    for (const table of ['event_audit', 'notifications', 'request_results']) {
      s.db.exec(
        'CREATE TRIGGER synthetic_fail BEFORE INSERT ON ' + table + " BEGIN SELECT RAISE(ABORT,'synthetic'); END",
      );
      const data = s.input({
          merchant_payment: { mode: 'paid', amount: '10', payer_id: a, merchant: '測試', occurred_at: stamp },
        }),
        p = await s.preview(data),
        sent = await s.send({ ...data, preview_token: p.json().preview_token, confirm: true });
      expect(sent.statusCode, sent.body).toBe(500);
      for (const t of [
        'settlement_history',
        'settlement_details',
        'settlements',
        'finance_entries',
        'event_audit',
        'notifications',
      ])
        expect(s.db.prepare('SELECT * FROM ' + t).all()).toHaveLength(0);
      s.db.exec('DROP TRIGGER synthetic_fail');
    }
    s.db.exec("CREATE TRIGGER synthetic_bot BEFORE INSERT ON bot_outbox BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    await s.save();
    expect(settlementDetail(s.db, 'listen')).toBeTruthy();
  });
  it('freezes group notice and custom plain/rich templates exactly like the retained Python renderer', async () => {
    const s = await setup();
    await s.save(s.input({ group_notice: true }));
    const row = s.db.prepare("SELECT payload_json FROM bot_outbox WHERE kind='settlement_updated'").get() as {
        payload_json: string;
      },
      payload = JSON.parse(row.payload_json),
      expected = await python(s, {}, "print(json.dumps(bot_outbox.build_message(db,event,'settlement_updated')[:2]))");
    expect(payload.text).toBe(expected[0]);
    expect(payload._settlement_version).toBe(1);
    for (const template of ['發布 {title}\n{url}', '@md\n## {title}\n{details}\n{url}', '@md\n{title}\n{url}']) {
      const policy = { ...activityBotPolicy(s.db).config, templates: { settlement_updated: template } },
        contexts = payload._template_context;
      const py = await python(
        s,
        { policy, contexts },
        "print(json.dumps([bot_outbox.render_message(data['policy'],'settlement_updated',data['contexts'],markdown=m) for m in (False,True)]))",
      );
      expect(
        [false, true].map((markdown) =>
          renderActivityBot(policy, 'settlement_updated', contexts, new Date(stamp), markdown),
        ),
      ).toEqual(py);
    }
  });
  it('preserves exact large journal sequence on disk and wire and changes preview tokens on adjacent integers', async () => {
    const s = await setup();
    s.db.exec(
      `INSERT INTO finance_entries(seq,id,event_id,kind,payload_json,occurred_at,actor_id,actor_name,created_at) VALUES(9007199254740993,'${i2}','listen','reopen','{}','before','alice','小青','before')`,
    );
    const p = await s.preview();
    expect(p.json().snapshot.journal_seq).toBe('9007199254740993');
    await s.save();
    expect(
      (s.db.prepare('SELECT snapshot_json FROM settlement_details').get() as { snapshot_json: string }).snapshot_json,
    ).toContain('"journal_seq":9007199254740993');
    expect(settlementDetail(s.db, 'listen')?.journal_seq).toBe('9007199254740993');
  });
  it('calculator retains only used custom payer inputs and validates fixed payment ownership', async () => {
    const s = await setup(),
      data = s.input({
        custom_payers: [{ id: 'custom:1234567890abcdef', name: '未使用' }],
        people: [
          { id: p1, payment_mode: 'fixed', payments: [{ payer_id: a, amount: '3.34' }] },
          { id: p2 },
          { id: p3 },
        ],
      });
    const result = calculateSettlement(
      s.db,
      eventRow(s.db, 'listen')!,
      { id: 'alice', nickname: '小青' },
      data,
      new Date(stamp),
    );
    expect(result.snapshot.input.custom_payers).toEqual([]);
    data.people[0]!.payments![0]!.amount = '3.33';
    expect(() =>
      calculateSettlement(s.db, eventRow(s.db, 'listen')!, { id: 'alice', nickname: '小青' }, data, new Date(stamp)),
    ).toThrow(/固定付款/);
  });
  it('freezes codes and receipts as independent per-version assets, binds their bytes to preview and enforces per-version limits', async () => {
    const s = await setup(),
      raw = testPNG(),
      encoded = raw.toString('base64'),
      codes = (['wechat', 'alipay', 'other'] as const).map((kind) => ({ kind, name: kind, image: encoded })),
      data = s.input({
        items: [{ id: i1, name: '消費', amount: '10', receipt: encoded }],
        payment_codes: codes,
        group_notice: true,
      }),
      p = await s.preview(data);
    expect(p.statusCode, p.body).toBe(200);
    compare(p.json().snapshot, await python(s, data));
    const changed = {
      ...data,
      payment_codes: [{ kind: 'wechat', name: 'wechat', image: testPNG([1, 2, 3]).toString('base64') }],
    };
    expect((await s.send({ ...changed, confirm: true, preview_token: p.json().preview_token })).statusCode).toBe(409);
    await s.save(data);
    for (const kind of ['wechat', 'alipay', 'other']) {
      const response = await s.app.inject({
        url: '/api/v2/activities/listen/settlement/history/1/payment-codes/' + kind,
      });
      expect(response.rawPayload).toEqual(raw);
    }
    expect(
      (await s.app.inject({ url: '/api/v2/activities/listen/settlement/history/1/receipts/' + i1 })).rawPayload,
    ).toEqual(raw);
    const next = s.input({
      reason: '沿用圖片',
      items: [{ id: i1, name: '消費', amount: '11', receipt: { version: 1, item_id: i1 } }],
      payment_codes: [{ kind: 'wechat', version: 1 }],
    });
    compare((await s.preview(next)).json().snapshot, await python(s, next));
    expect((await s.preview(next, s.bob)).statusCode).toBe(403);
    await s.save(next);
    expect(s.db.prepare('SELECT * FROM settlement_receipt_images').all()).toHaveLength(2);
    expect(s.db.prepare('SELECT * FROM settlement_code_images').all()).toHaveLength(4);
    const four = s.input({
      reason: '四張憑證',
      items: [1, 2, 3, 4].map((n) => ({
        id: String(n).padStart(16, '0'),
        name: '憑證',
        amount: '0',
        receipt: encoded,
      })),
    });
    expect((await s.preview(four)).statusCode).toBe(400);
    const padded = Buffer.concat([
        raw.subarray(0, -12),
        pngChunk('tEXt', Buffer.alloc(1100000, 65)),
        raw.subarray(-12),
      ]).toString('base64'),
      large = s.input({
        reason: '總量',
        items: [1, 2, 3].map((n) => ({ id: String(n).padStart(16, '0'), name: '憑證', amount: '0', receipt: padded })),
        payment_codes: codes.map((c) => ({ ...c, image: padded })),
      });
    const over = await s.preview(large);
    expect(over.statusCode, over.body).toBe(400);
    expect(over.body).toContain('6 MiB');
    expect(s.db.prepare('SELECT * FROM settlement_details').all()).toHaveLength(2);
  });
  it('matches native and retained Python workers on frozen settlement text and each code through a simulated QQ API', async () => {
    const s = await setup(),
      image = testPNG().toString('base64');
    await s.save(
      s.input({
        group_notice: true,
        payment_codes: [
          { kind: 'wechat', image, name: '本版微信' },
          { kind: 'alipay', image, name: '本版支付寶' },
          { kind: 'other', image, name: '其他' },
        ],
      }),
    );
    const result = await python(
      s,
      {},
      `from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
from qgroup_bot import worker
worker.datetime=Frozen;worker.now=lambda:'${stamp}'
config=SimpleNamespace(db=Path(sys.argv[1]),group='synthetic-group',dry_run=False,sandbox=False,claim_timeout=600,batch=10,max_attempts=5,markdown_replies=True,allowed_link_hosts=('rebuild.example',),log_dir=Path(sys.argv[1]).parent/'isolated-logs',log_content=False)
api=Mock();api.post.side_effect=lambda path,body:(True,0,dict(file_info='SYNTHETIC_FILE')) if path.endswith('/files') else (True,0,dict(id='SYNTHETIC_ONLY'))
consumer=worker.OutboxWorker(config,api);first=consumer.poll_once();second=consumer.poll_once()
print(json.dumps(dict(first=first,second=second,calls=[dict(path=c.args[0],body=c.args[1]) for c in api.post.call_args_list],statuses=[r[0] for r in db.execute('SELECT status FROM bot_outbox ORDER BY id')])) )`,
    );
    const nativeCalls: { path: string; body: APIObject }[] = [];
    const native = new BotOutboxWorker(s.db, loadBotConfig({
      KANBAN_DB: s.db.name, KANBAN_BOT_GROUP: 'synthetic-group', KANBAN_BOT_DRY_RUN: '0',
      KANBAN_BOT_MARKDOWN: '1', KANBAN_BOT_ALLOWED_HOSTS: 'rebuild.example',
      KANBAN_BOT_LOG_DIR: join(s.root, 'native-logs'),
    }), { post: async (path, body) => {
      nativeCalls.push({path,body});return {ok:true,code:0,status:200,kind:'ok',platformTrace:null,data:path.endsWith('/files')?{file_info:'SYNTHETIC_FILE'}:{id:'SYNTHETIC_ONLY'}};
    } }, { now: () => new Date(stamp) });
    expect(await native.pollOnce()).toEqual(result.first);
    expect(await native.pollOnce()).toEqual(result.second);
    expect(nativeCalls).toEqual(result.calls);
    expect(result.first).toMatchObject({ sent: 4, failed: 0 });
    expect(result.second.claimed).toBe(0);
    expect(result.statuses).toEqual(['sent', 'sent', 'sent', 'sent']);
    expect(result.calls).toHaveLength(7);
    expect(result.calls.filter((c: { path: string }) => c.path.endsWith('/files'))).toHaveLength(3);
    expect(
      result.calls
        .filter((c: { path: string }) => c.path.endsWith('/files'))
        .every((c: { body: { file_data: string } }) => c.body.file_data === image),
    ).toBe(true);
  });
  it('preserves used room identities, blocks unscoped money and limits cohosts to actual amounts', async () => {
    const s = await setup(),
      rooms = [{ id: i1, name: '一房', payer_id: a, person_ids: [p1, p2, p3] }];
    const plan = await s.app.inject({
      method: 'POST',
      url: '/api/v2/activities/listen/rooms',
      headers: { ...s.alice, 'idempotency-key': randomUUID() },
      payload: { revision: 0, rooms, confirm: true },
    });
    expect(plan.statusCode, plan.body).toBe(200);
    const data = s.input({ rooms: [{ ...rooms[0], amount: '10' }] });
    expect((await s.preview(data, s.bob)).statusCode).toBe(200);
    expect((await s.preview(s.input({ rooms: [{ ...rooms[0], name: '改房', amount: '10' }] }), s.bob)).statusCode).toBe(
      403,
    );
    s.db
      .prepare(
        "INSERT INTO finance_entries(id,event_id,kind,payload_json,occurred_at,actor_id,actor_name,created_at) VALUES(?,'listen','expense',?,'before','alice','小青','before')",
      )
      .run(i2, JSON.stringify({ kind: 'expense', amount_cents: 1, payer_id: a, funding: 'payer', room_id: i1 }));
    expect(
      (
        await s.app.inject({
          method: 'POST',
          url: '/api/v2/activities/listen/rooms',
          headers: { ...s.alice, 'idempotency-key': randomUUID() },
          payload: { revision: 1, rooms: [], confirm: true },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await s.preview(s.input({ rooms: [{ ...rooms[0], amount: '10', merchant_mode: 'paid' }] }))).statusCode,
    ).toBe(409);
    await s.save(s.input({ rooms: [{ ...rooms[0], amount: '10', merchant_mode: 'recorded' }] }), s.bob);
    expect(
      (
        await s.app.inject({
          method: 'POST',
          url: '/api/v2/activities/listen/rooms',
          headers: { ...s.alice, 'idempotency-key': randomUUID() },
          payload: { revision: eventRow(s.db, 'listen')!.revision, rooms, confirm: true },
        })
      ).statusCode,
    ).toBe(409);
    const other = await setup();
    other.db
      .prepare(
        "INSERT INTO finance_entries(id,event_id,kind,payload_json,occurred_at,actor_id,actor_name,created_at) VALUES(?,'listen','expense',?,'before','alice','小青','before')",
      )
      .run(i2, JSON.stringify({ kind: 'expense', amount_cents: 1, payer_id: a, funding: 'payer' }));
    expect((await other.preview(other.input({ rooms: [{ ...rooms[0], amount: '10' }] }))).statusCode).toBe(409);
  });
  it('arbitrates concurrent publishing without duplicate money, versions or notification work', async () => {
    const s = await setup(),
      data = s.input(),
      p = await s.preview(data),
      payload = { ...data, preview_token: p.json().preview_token, confirm: true },
      results = await Promise.all([s.send(payload), s.send(payload)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(s.db.prepare('SELECT * FROM settlement_history').all()).toHaveLength(1);
    expect(s.db.prepare('SELECT * FROM bot_outbox').all()).toHaveLength(1);
  });
});
