import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '@qgroup/database';
import { createApp } from './app';
import { fixture } from '../testsupport/fixture';
import { redactRequestURL } from './request-log';

const prefix = '/api/public/v1', id = '0123456789abcdef', privateId = '2222222222222222';
const personIds = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc', 'dddddddddddddddd', 'eeeeeeeeeeeeeeee', 'ffffffffffffffff'];
const key = 'synthetic_partner_' + 'a'.repeat(40), replacement = 'synthetic_partner_' + 'b'.repeat(40);
const auth = { authorization: 'Bearer ' + key }, fixed = '2026-11-18T08:00:00+00:00';
const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
async function setup(memory = false) {
  const root = mkdtempSync(join(tmpdir(), 'qgroup-partner-')), db = openDatabase(memory ? ':memory:' : join(root, 'state.sqlite3'));
  fixture(db);
  const template = db.prepare("SELECT * FROM events WHERE id='listen'").get() as Record<string, unknown>;
  db.exec('DELETE FROM events');
  const add = (overrides: Record<string, unknown>) => {
    const row = { ...template, ...overrides };
    db.prepare('INSERT INTO events(' + Object.keys(row).join(',') + ') VALUES(' + Object.keys(row).map(() => '?').join(',') + ')').run(...Object.values(row));
  };
  add({ id, revision: 7, capacity: 3, minimum_participants: 2, fee_policy: '各付各的', description: '<b>原文</b> & 說明', invite_token: 'PRIVATE_EVENT_TOKEN' });
  add({ id: '1111111111111111', lifecycle: 'ended', status: 'closed', archived_at: fixed, duration_hours: null });
  add({ id: privateId, visibility: 'invitation' });
  add({ id: '3333333333333333', lifecycle: 'draft' });
  add({ id: '4444444444444444', status: 'deleted' });
  add({ id: '5555555555555555', lifecycle: 'cancelled', status: 'cancelled', cancellation_reason: '場地取消' });
  db.prepare("INSERT INTO roster_parties(id,event_id,manager_id,queue_mode,created_at) VALUES('party',?,'alice','individual',?)").run(id, fixed);
  for (const [i, status] of ['tentative', 'confirmed', 'waiting', 'confirmed', 'invited', 'withdrawn'].entries())
    db.prepare(`INSERT INTO attendees(id,event_id,manager_id,user_id,party_id,name,note,payer_kind,status,confirmation_state,invitation_token,withdrawal_reason,attendance_note,created_at,updated_at)
      VALUES(?,?,'alice',?,'party',?,'PRIVATE_NOTE','manager',?,? ,?,'PRIVATE_REASON','PRIVATE_ATTENDANCE',?,?)`)
      .run(personIds[i]!, id, i === 2 ? 'bob' : i === 3 ? 'alice' : null, '同行 ' + i, status, i === 0 ? 'pending' : i === 2 ? 'declined' : 'accepted', i === 4 ? 'PRIVATE_INVITATION_TOKEN' : null, fixed, fixed);
  db.prepare("INSERT INTO admin_user_metadata VALUES('alice','PRIVATE_ADMIN_NOTE','PRIVATE_QQ',1,?,'test')").run(fixed);
  db.prepare("INSERT INTO bot_groups VALUES('synthetic-group',?,?,'test','joined')").run(fixed, fixed);
  for (const status of ['pending', 'sending', 'sent', 'failed', 'skipped'])
    db.prepare("INSERT INTO bot_outbox(event_id,kind,dedupe_key,target,payload_json,status,created_at,claim_token,attempts) VALUES(?,'activity_published',?,'synthetic-group','{}',?,?,'PRIVATE_CLAIM',2)").run(id, status, status, fixed);
  let configuration = key, clock = () => new Date(fixed);
  const app = createApp({ db, origin: 'https://rebuild.example', now: () => clock(), publicAPIKeys: () => configuration, pairedBackupScheduling: false });
  await app.ready();
  closes.push(async () => { await app.close(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const get = (suffix = '', headers: Record<string, string> = auth) => app.inject({ url: prefix + suffix, headers });
  const plan = (version = 1) => db.prepare('INSERT INTO event_room_plans VALUES(?,?,?,?)').run(id, version, JSON.stringify([
    { id: '9876543210abcdef', name: '一房', person_ids: [personIds[1], personIds[2], personIds[4], personIds[5]], payer_id: 'PRIVATE_PAYER', payer_name: 'PRIVATE_PAYER_NAME' },
  ]), fixed);
  const settle = (version = 1, rooms: object[] | null = [{ id: '9876543210abcdef', name: '實際房', person_ids: [personIds[3], personIds[5]], amount: 'PRIVATE_AMOUNT' }], detailed = true) => {
    db.prepare("INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,updated_at,actor_id,actor_name,kind,changed_fields) VALUES(?,?,999,2,'PRIVATE_BILL_NOTE',?,'alice','小青','publish','[]')").run(id, version, fixed);
    if (detailed) db.prepare('INSERT INTO settlement_details VALUES(?,?,?)').run(id, version, JSON.stringify({ people: [
      { id: personIds[3], name: '凍結小青', payer_id: 'PRIVATE_PAYER' }, { id: personIds[5], name: '凍結退出者' },
    ], ...(rooms !== null ? { rooms } : {}), total_cents: 999, payments: ['PRIVATE_PAYMENT'], receipt: 'PRIVATE_RECEIPT' }));
  };
  return { app, db, root, get, add, plan, settle, configure(value: string) { configuration = value; }, clock(value: () => Date) { clock = value; } };
}
function snapshot(db: DB) {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {name: string}[])
    .map(({ name }) => [name, db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all()]);
}
function python(path: string, paths: string[]) {
  return JSON.parse(execFileSync('python3', ['-c', `import datetime,json,sqlite3,sys
from unittest.mock import patch
import public_api
from qgroup_core import bot_views,lifecycle
class Clock(datetime.datetime):
    @classmethod
    def now(cls,tz=None): return cls.fromisoformat('${fixed}').astimezone(tz)
db=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
db.execute('PRAGMA query_only=ON');db.execute('BEGIN')
result=[]
with patch.object(lifecycle,'now',return_value='${fixed}'),patch.object(lifecycle,'datetime',Clock):
    for url in json.loads(sys.argv[2]):
        path,_,query=url.partition('?')
        try: result.append(dict(status=200,body=public_api.read(db,path,query)))
        except public_api.APIError as e: result.append(dict(status=e.status,body=dict(error=e.message)))
event=db.execute('SELECT * FROM events WHERE id=?',('${id}',)).fetchone()
print(json.dumps(dict(responses=result,bot=dict(counts=bot_views.counts(db,event['id']),roster=bot_views.roster_lines(db,event)))))`, path, JSON.stringify(paths)], { encoding: 'utf8' }));
}
describe('native partner public v1 contract', () => {
  it('matches every legacy response field, pagination, filters and errors on the same read-only synthetic DB', async () => {
    const s = await setup(); s.plan(); s.settle();
    s.add({ id: '6666666666666666', starts_at: '2026-11-18T07:00:00+00:00', duration_hours: 0.5 });
    s.add({ id: '7777777777777777', starts_at: '2026-11-18T17:00:00+08:00', duration_hours: 2.25 });
    s.add({ id: '8888888888888888', duration_hours: 0 });
    const paths = ['', '/events', '/events?limit=1', '/events?limit=1&offset=1', '/events?limit=1&offset=999', '/events?lifecycle=ended&status=closed', '/events?status=cancelled',
      '/events/' + id, '/events/' + id + '/participants', '/events/' + id + '/rooms', '/events/' + privateId, '/events/3333333333333333', '/events/4444444444444444', '/events/9999999999999999',
      '/events/not-an-id', '/unknown', '/events?limit=0', '/events?offset=100000001', '/events?limit=1&limit=2', '/events?limit=1?extra=2', '/events?limit=1%0A', '/events?status=deleted', '/events?lifecycle=draft', '?secret=1', '/events/' + id + '?key=1',
    ].map(suffix => prefix + suffix);
    const before = snapshot(s.db), expected = python(s.db.name, paths);
    for (const [index, url] of paths.entries()) {
      const response = await s.app.inject({ url, headers: auth });
      expect({ status: response.statusCode, body: response.json() }, url).toEqual(expected.responses[index]);
    }
    expect(snapshot(s.db)).toEqual(before);
    expect(python(s.db.name, []).bot).toEqual(expected.bot);
    expect(s.db.pragma('foreign_key_check')).toEqual([]);
  });
  it('requires a key at every data entry, regardless of owner/admin cookies or query keys', async () => {
    const s = await setup();
    const before = snapshot(s.db);
    for (const suffix of ['', '/events', '/events/' + id, '/events/' + id + '/participants', '/events/' + id + '/rooms', '/missing']) {
      for (const headers of [{}, { cookie: 'kanban_session=fixture-alice; kanban_admin=synthetic-admin' }] as Record<string, string>[]) {
        const response = await s.get(suffix, headers);
        expect(response.statusCode).toBe(401); expect(response.json()).toEqual({ error: 'Valid API key required' });
        expect(response.headers['www-authenticate']).toBe('Bearer realm="qgroup-partner-api"');
        expect(response.headers['set-cookie']).toBeUndefined();
      }
    }
    expect((await s.get('/events?api_key=' + key, {})).statusCode).toBe(401);
    expect(snapshot(s.db)).toEqual(before);
  });
  it('rejects malformed credentials and configuration, and supports independent rotation/revocation', async () => {
    const s = await setup();
    for (const authorization of ['', 'Basic ' + key, 'Bearer wrong', 'Bearer ' + replacement, 'Bearer ' + key + ', Bearer ' + key, 'Bearer ' + key + ' extra', 'Bearer ' + 'é'.repeat(40)])
      expect((await s.get('', { authorization })).statusCode).toBe(401);
    expect((await s.get('', { authorization: 'bearer\t' + key })).statusCode).toBe(200);
    for (const config of ['', ' ', 'short', key + ',', 'é'.repeat(40), Array(21).fill(key).join(',')]) {
      s.configure(config);
      const response = await s.get(); expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: 'Partner API is not configured' });
    }
    s.configure(' ' + key + ' , ' + replacement + ' ');
    expect((await s.get()).statusCode).toBe(200);
    expect((await s.get('', { authorization: 'Bearer ' + replacement })).statusCode).toBe(200);
    s.configure(replacement);
    expect((await s.get()).statusCode).toBe(401);
    expect((await s.get('', { authorization: 'Bearer ' + replacement })).statusCode).toBe(200);
    expect((await s.app.inject('/api/v2/activities')).statusCode).toBe(200);
  });
  it('rejects duplicate Authorization lines even when Node retained a valid first value', async () => {
    const s = await setup(); const base = await s.app.listen({ host: '127.0.0.1', port: 0 });
    const result = await new Promise<{status: number; body: string}>((resolve, reject) => {
      http.get(base + prefix, { headers: ['Host', new URL(base).host, 'Authorization', 'Bearer ' + key, 'Authorization', 'Bearer ' + replacement] }, response => {
        let body = ''; response.setEncoding('utf8'); response.on('data', data => { body += data; });
        response.on('end', () => resolve({ status: response.statusCode!, body }));
      }).on('error', reject);
    });
    expect(result).toEqual({ status: 401, body: JSON.stringify({ error: 'Valid API key required' }) });
  });
  it('preserves GET/HEAD/OPTIONS, auth-before-method order, no-store and backend-only access without writes', async () => {
    const s = await setup(), before = snapshot(s.db);
    for (const url of [prefix, prefix + '/events', prefix + '/events/' + id, prefix + '/missing']) {
      const get = await s.app.inject({ url, headers: { ...auth, origin: 'https://partner.example' } });
      const head = await s.app.inject({ method: 'HEAD', url, headers: auth });
      expect(head.statusCode).toBe(get.statusCode); expect(head.body).toBe('');
      expect(head.headers['content-length']).toBe(get.headers['content-length']);
      for (const response of [get, head]) {
        expect(response.headers['cache-control']).toBe('no-store'); expect(response.headers['allow']).toBe('GET, HEAD, OPTIONS');
        expect(response.headers['set-cookie']).toBeUndefined(); expect(response.headers['access-control-allow-origin']).toBeUndefined();
        expect(response.headers['access-control-allow-credentials']).toBeUndefined();
      }
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'TRACE'] as const) {
        const invalid = await s.app.inject({ method, url, headers: { 'content-type': 'application/json' }, payload: '{broken-json' });
        expect(invalid.statusCode).toBe(401);
        const valid = await s.app.inject({ method, url, headers: { ...auth, 'content-type': 'application/json' }, payload: '{broken-json' });
        expect(valid.statusCode).toBe(405); expect(valid.json()).toEqual({ error: 'Public API is read-only' });
      }
      s.configure('');
      const options = await s.app.inject({ method: 'OPTIONS', url, headers: { origin: 'https://partner.example', 'access-control-request-method': 'GET' } });
      expect(options.statusCode).toBe(204); expect(options.body).toBe(''); expect(options.headers['access-control-allow-origin']).toBeUndefined();
      s.configure(key);
    }
    expect(snapshot(s.db)).toEqual(before);
  });
  it('hides nonpublic events on every endpoint even from owners, keeping cancelled and archived public events', async () => {
    const s = await setup();
    for (const eventId of [privateId, '3333333333333333', '4444444444444444', '9999999999999999'])
      for (const suffix of ['', '/participants', '/rooms']) {
        const response = await s.get('/events/' + eventId + suffix, { ...auth, cookie: 'kanban_session=fixture-alice' });
        expect(response.statusCode).toBe(404); expect(response.json()).toEqual({ error: 'Public event not found' });
      }
    const page = (await s.get('/events')).json();
    expect(page.total).toBe(3); expect(page.events.map((e: {id: string}) => e.id)).toEqual([id, '1111111111111111', '5555555555555555']);
    expect((await s.get('/events?lifecycle=ended')).json().events[0].archived_at).toBe(fixed);
    expect((await s.get('/events?status=cancelled')).json().events[0].registration_open).toBe(false);
  });
  it('strictly validates raw query keys, duplicates, empty values, integer limits and unknown paths', async () => {
    const s = await setup();
    for (const query of ['limit=0', 'limit=101', 'offset=-1', 'offset=100000001', 'limit=1&limit=2', '%6cimit=1&limit=2', 'limit=1.0', 'limit=+1', 'limit=1e1', 'limit=', 'offset=', 'status=', 'lifecycle=draft', 'unknown=1', 'limit=0000000001', Array(11).fill('a=1').join('&')])
      expect((await s.get('/events?' + query)).statusCode, query).toBe(400);
    for (const suffix of ['', '/participants', '/rooms']) expect((await s.get('/events/' + id + suffix + '?unknown=1')).statusCode).toBe(400);
    for (const suffix of ['/events/' + id + '/finance', '/events/' + id.toUpperCase(), '/events/' + id + '/', '/events/%30' + id.slice(1)]) {
      const response = await s.get(suffix); expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'Public API endpoint not found' });
    }
    expect((await s.get('/events?limit=001&offset=000')).json()).toMatchObject({ limit: 1, offset: 0, next_offset: 1 });
    expect((await s.get('/events?offset=100000000')).json()).toMatchObject({ events: [], next_offset: null });
  });
  it('allowlists every public object, filters invite/withdrawn people and ignores cookies and locale', async () => {
    const s = await setup(); s.plan(); s.settle();
    const response = await s.get('/events/' + id), detail = response.json();
    expect(detail.participants.map((p: {status: string}) => p.status)).toEqual(['confirmed', 'confirmed', 'waiting', 'tentative']);
    for (const person of detail.participants) expect(Object.keys(person).sort()).toEqual(['attendee_id', 'confirmation_state', 'name', 'status', 'user_id']);
    expect(detail.event.counts).toEqual({ confirmed: 2, waiting: 1, tentative: 1 });
    expect(detail.event).toMatchObject({ remaining_capacity: 1, minimum_met: true, description: '<b>原文</b> & 說明' });
    expect(response.body).not.toMatch(/PRIVATE_|payer|payment|receipt|attendance|withdrawal_reason|invite_token|owner_id|manager_id|manual_qq|avatar|union|openid/);
    for (const room of [...detail.room_assignments.planned.rooms, ...detail.room_assignments.actual.rooms]) {
      expect(Object.keys(room).sort()).toEqual(['attendee_ids', 'id', 'members', 'name']);
      for (const person of room.members) expect(Object.keys(person).sort()).toEqual(['attendee_id', 'name', 'user_id']);
    }
    expect((await s.get('/events/' + id, { ...auth, cookie: 'kanban_session=fixture-alice', 'accept-language': 'zh-CN' })).json()).toEqual(detail);
    s.db.prepare('UPDATE events SET capacity=0 WHERE id=?').run(id);
    expect((await s.get('/events/' + id)).json().event.remaining_capacity).toBeNull();
  });
  it('keeps attendee IDs stable on claim, shares account IDs across events and removes erased identity links', async () => {
    const s = await setup(); s.plan();
    const before = (await s.get('/events/' + id + '/participants')).json().participants;
    expect(before.find((p: {attendee_id: string}) => p.attendee_id === personIds[1]).user_id).toBeNull();
    s.db.prepare("INSERT INTO users(id,token_hash,nickname,created_at) VALUES('charlie','synthetic-charlie','本人',?)").run(fixed);
    s.db.prepare('UPDATE attendees SET user_id=? WHERE id=?').run('charlie', personIds[1]!);
    const claimed = (await s.get('/events/' + id + '/participants')).json().participants;
    expect(claimed.find((p: {attendee_id: string}) => p.attendee_id === personIds[1])).toMatchObject({ user_id: 'charlie', name: '本人' });
    s.db.prepare("INSERT INTO attendees(id,event_id,manager_id,user_id,name,payer_kind,status,created_at,updated_at) VALUES('1234567890abcdef','1111111111111111','alice','charlie','','self','confirmed',?,?)").run(fixed, fixed);
    expect((await s.get('/events/1111111111111111/participants')).json().participants[0]).toMatchObject({ attendee_id: '1234567890abcdef', user_id: 'charlie' });
    s.settle();
    s.db.prepare("INSERT INTO privacy_requests VALUES('erasure','alice','shared_review',?,?,'')").run(fixed, fixed);
    s.db.prepare("INSERT INTO privacy_requests VALUES('erasure-charlie','charlie','shared_review',?,?,'')").run(fixed, fixed);
    const detail = (await s.get('/events/' + id)).json();
    expect(detail.participants.filter((p: {attendee_id: string}) => [personIds[1], personIds[3]].includes(p.attendee_id)).every((p: {user_id: unknown}) => p.user_id === null)).toBe(true);
    expect(detail.room_assignments.planned.rooms[0].members[0].user_id).toBeNull();
    expect(detail.room_assignments.actual.rooms[0].members[0].user_id).toBeNull();
  });
  it('uses current people for plans, frozen names for actual rooms, and never falls back from a non-room detailed bill', async () => {
    const s = await setup();
    const none = (await s.get('/events/' + id + '/rooms')).json();
    expect(none.planned).toMatchObject({ version: 0, rooms: [] }); expect(none.planned.unassigned_attendee_ids).toHaveLength(4); expect(none.actual).toBeNull();
    s.plan(); s.settle();
    s.db.prepare("UPDATE users SET nickname='改名後' WHERE id='alice'").run();
    s.db.prepare("UPDATE attendees SET status='withdrawn' WHERE id=?").run(personIds[3]!);
    const rooms = (await s.get('/events/' + id + '/rooms')).json();
    expect(rooms.planned.rooms[0].attendee_ids).toEqual([personIds[1], personIds[2]]);
    expect(rooms.planned.unassigned_attendee_ids).toEqual([personIds[0]]);
    expect(rooms.actual.rooms[0].members).toEqual([{ attendee_id: personIds[3], user_id: 'alice', name: '凍結小青' }, { attendee_id: personIds[5], user_id: null, name: '凍結退出者' }]);
    s.settle(2, null);
    expect((await s.get('/events/' + id + '/rooms')).json().actual).toEqual({ settlement_version: 2, rooms: [], unassigned_attendee_ids: [personIds[3], personIds[5]] });
    expect((await s.get('/events/' + id + '/rooms')).json()).toEqual(python(s.db.name, [prefix + '/events/' + id + '/rooms']).responses[0].body);
    s.settle(3, []);
    expect((await s.get('/events/' + id + '/rooms')).json().actual).toEqual({ settlement_version: 3, rooms: [], unassigned_attendee_ids: [personIds[3], personIds[5]] });
    s.settle(4, [], false);
    expect((await s.get('/events/' + id + '/rooms')).json().actual).toBeNull();
    expect((await s.get('/events/' + id + '/rooms')).json()).toEqual(python(s.db.name, [prefix + '/events/' + id + '/rooms']).responses[0].body);
  });
  it('keeps one read transaction across fields even when a writer changes the WAL during the request', async () => {
    const s = await setup();
    let changed = false;
    s.clock(() => {
      if (!changed) {
        changed = true;
        s.db.transaction(() => {
          s.db.prepare('UPDATE events SET revision=8 WHERE id=?').run(id);
          s.db.prepare("UPDATE users SET nickname='新稱呼' WHERE id='alice'").run();
        }).immediate();
      }
      return new Date(fixed);
    });
    const first = (await s.get('/events/' + id)).json();
    expect(first).toMatchObject({ revision: 7, event: { revision: 7, owner_name: '小青' } });
    expect(first.participants.find((p: {user_id: string}) => p.user_id === 'alice').name).toBe('小青');
    expect((await s.get('/events/' + id)).json()).toMatchObject({ revision: 8, event: { owner_name: '新稱呼' } });
  });
  it('fails closed for recovery candidates and storage errors without leaking details or touching other APIs', async () => {
    const s = await setup();
    s.db.prepare('UPDATE rebuild_storage SET recovery_required=1 WHERE id=1').run();
    const before = snapshot(s.db);
    const response = await s.get('/events/' + id); expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'Partner API temporarily unavailable' }); expect(snapshot(s.db)).toEqual(before);
    s.configure(''); expect((await s.get('/events/' + id)).json()).toEqual({ error: 'Partner API is not configured' });
    const usable = await setup();
    usable.db.prepare('INSERT INTO event_room_plans VALUES(?,1,?,?)').run(id, '{PRIVATE_INVALID_JSON', fixed);
    expect((await usable.get('/events/' + id)).statusCode).toBe(503);
    expect((await usable.get('/events/' + id + '/participants')).statusCode).toBe(200);
  });
  it('authenticates before database access and never creates a missing database', async () => {
    const s = await setup(); rmSync(s.db.name);
    s.configure(''); expect((await s.get()).json()).toEqual({ error: 'Partner API is not configured' });
    s.configure(key); expect((await s.get('', {})).statusCode).toBe(401);
    expect((await s.get()).json()).toEqual({ error: 'Partner API temporarily unavailable' });
    expect(existsSync(s.db.name)).toBe(false);
  });
  it('blocks pending erasure without replaying writes, then exposes only the recovered identity projection', async () => {
    const s = await setup(), cookie = 'kanban_session=fixture-bob';
    const session = (await s.app.inject({ url: '/api/v2/session', headers: { cookie } })).json();
    s.db.exec("CREATE TRIGGER reject_closure BEFORE INSERT ON privacy_requests BEGIN SELECT RAISE(ABORT,'synthetic closure failure'); END");
    const response = await s.app.inject({ method: 'POST', url: '/api/v2/me/privacy/erase', headers: {
      cookie, origin: 'https://rebuild.example', 'x-account-scope': session.scope, 'x-csrf-token': session.csrf,
    }, payload: { requestId: randomUUID(), secret: 'ab'.repeat(32), target: 'account', confirm: true, profileId: null, profileRevision: 0 } });
    expect(response.statusCode).toBe(500);
    for (const drop of [false, true]) {
      if (drop) s.db.exec('DROP TRIGGER reject_closure');
      const before = snapshot(s.db), blocked = await s.get('/events/' + id);
      expect(blocked.statusCode).toBe(503); expect(snapshot(s.db)).toEqual(before);
    }
    expect((await s.app.inject('/api/v2/health')).statusCode).toBe(200);
    const participants = (await s.get('/events/' + id + '/participants')).json().participants;
    expect(participants.find((p: {attendee_id: string}) => p.attendee_id === personIds[2])).toMatchObject({ name: '已注销用户', user_id: null });
  });
  it('restores in-memory query_only after successful and failed reads, without imposing browser GET rate limits', async () => {
    const s = await setup(true);
    for (let count = 0; count < 185; count++) expect((await s.get()).statusCode).toBe(200);
    expect((await s.get('/events?bad=1')).statusCode).toBe(400);
    expect(s.db.pragma('query_only', { simple: true })).toBe(0);
    expect(() => s.db.prepare('UPDATE events SET revision=revision+1 WHERE id=?').run(id)).not.toThrow();
  });
  it('redacts all partner query strings, including disguised credential names', () => {
    for (const path of [prefix, prefix + '/events', prefix + '/events/' + id, prefix + '/missing'])
      expect(redactRequestURL(path + '?custom=' + key + '&api_key=' + replacement)).toBe(path);
  });
});
