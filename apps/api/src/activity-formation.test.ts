import { randomUUID } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { openDatabase, type DB } from '@qgroup/database';
import { fixture } from '../testsupport/fixture';
import { createApp } from './app';
import { eventRow } from './activity-arrangements';
import { finalizeDueActivityFormations } from './activity-formation';
import { createActivityBot } from './activity-bot';

const origin = 'https://formation.example', start = new Date('2026-11-28T11:00:00Z');
const defaults = { enabled: true, baseURL: origin, keyboard: true };
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function setup(count = 1) {
  const db = openDatabase(':memory:'); fixture(db); cleanup.push(async () => db.close());
  db.exec("UPDATE events SET starts_at='2026-11-28T19:00:00+08:00',deadline='2026-11-28T23:00:00+08:00',duration_hours=4,minimum_participants=2,bot_enabled=1 WHERE id='listen'");
  db.prepare('UPDATE bot_settings SET config_json=?').run(JSON.stringify({ enabled: true, groups: [{ id: 'synthetic-group', name: '測試', broadcast: true, replies: true }] }));
  for (let i = 0; i < count; i++) addPerson(db, 'confirmed-' + i, 'confirmed');
  return db;
}
function addPerson(db: DB, id: string, status: string) {
  db.prepare("INSERT INTO attendees(id,event_id,manager_id,name,note,payer_kind,status,created_at,updated_at) VALUES(?,'listen','bob',?,'保留報名備註','manager',?,'before','before')").run(id, id, status);
}
const run = (db: DB, at = start) => finalizeDueActivityFormations(db, at, defaults);

test('cancels exactly at start, counts only confirmed people, and preserves roster and finances', () => {
  const db = setup();
  for (const status of ['waiting', 'tentative', 'withdrawn', 'invited']) addPerson(db, status, status);
  db.exec("INSERT INTO settlements(event_id,total_cents,headcount,note,updated_at) VALUES('listen',100,1,'保留帳單','before'); INSERT INTO event_roles VALUES('cohost','listen','alice','[]','before')");
  const snapshot = () => ['attendees', 'settlements', 'finance_entries'].map(t => db.prepare('SELECT * FROM ' + t).all());
  const before = snapshot();
  expect(run(db, new Date(start.getTime() - 1))).toEqual([]);
  expect(eventRow(db, 'listen')?.lifecycle).toBe('scheduled');
  expect(run(db)).toEqual([{ id: 'listen', formed: false }]);
  expect(eventRow(db, 'listen')).toMatchObject({ lifecycle: 'cancelled', status: 'cancelled', registration_open: 0, formation_state: 'unformed', actual_started_at: null });
  expect(eventRow(db, 'listen')?.cancellation_reason).toContain('1/2');
  expect(db.prepare("SELECT actor_id,actor_name,action FROM event_audit WHERE event_id='listen'").all()).toEqual([{ actor_id: null, actor_name: '系統', action: 'event_auto_cancel' }]);
  expect(db.prepare("SELECT user_id,kind FROM notifications WHERE event_id='listen' ORDER BY user_id").all()).toEqual([{ user_id: 'alice', kind: 'event_cancelled' }, { user_id: 'bob', kind: 'event_cancelled' }]);
  expect(snapshot()).toEqual(before);
  expect(run(db)).toEqual([]);
  expect(db.prepare("SELECT count(*) n FROM event_audit WHERE event_id='listen'").get()).toEqual({ n: 1 });
  expect(db.prepare("SELECT count(*) n FROM bot_outbox WHERE event_id='listen' AND kind='event_cancelled'").get()).toEqual({ n: 1 });
});

test('invalidates old reminders and emits one existing cancellation payload', () => {
  const db = setup();
  createActivityBot(db, () => new Date(start.getTime() - 48 * 3600000), defaults).publication('listen');
  run(db); run(db);
  expect(db.prepare("SELECT status FROM bot_outbox WHERE event_id='listen' AND kind IN ('deadline_reminder','estimated_over_reminder')").all()).toEqual([{ status: 'skipped' }, { status: 'skipped' }]);
  const payload = JSON.parse((db.prepare("SELECT payload_json FROM bot_outbox WHERE kind='event_cancelled'").get() as { payload_json: string }).payload_json);
  expect(payload.text).toContain('未達成團人數');
  expect(payload._template_context).toBeDefined();
});

test.each([0, 1])('saves formation once and retains the original registration setting %i', open => {
  const db = setup(2); db.prepare("UPDATE events SET registration_open=?,status=? WHERE id='listen'").run(open, open ? 'open' : 'closed');
  expect(run(db)).toEqual([{ id: 'listen', formed: true }]);
  expect(eventRow(db, 'listen')).toMatchObject({ lifecycle: 'ongoing', formation_state: 'formed', registration_open: open, status: open ? 'open' : 'closed' });
  db.exec("UPDATE attendees SET status='withdrawn' WHERE id='confirmed-1'");
  expect(run(db, new Date(start.getTime() + 1000))).toEqual([]);
  expect(eventRow(db, 'listen')?.lifecycle).toBe('ongoing');
  expect(db.prepare("SELECT * FROM bot_outbox WHERE kind='event_cancelled'").all()).toEqual([]);
});

test.each(["formation_state='confirmed'", "lifecycle='ongoing',actual_started_at='2026-11-28T11:00:00Z'", "minimum_participants=0", "lifecycle='draft'", "status='deleted'", "archived_at='before'"])(
  'preserves manual decisions and excluded activities: %s', patch => {
    const db = setup(); db.exec("UPDATE events SET " + patch + " WHERE id='listen'");
    const before = eventRow(db, 'listen'); expect(run(db)).toEqual([]); expect(eventRow(db, 'listen')).toEqual(before);
  });

test('durable enrolment catches up after an outage across the end without reinterpreting old history', () => {
  const db = setup();
  db.exec("UPDATE events SET starts_at='2026-11-27T23:00:00-05:00',timezone='America/New_York' WHERE id='listen'");
  const at = new Date('2026-11-28T04:00:00Z');
  expect(run(db, new Date(at.getTime() - 1))).toEqual([]);
  expect(eventRow(db, 'listen')?.formation_state).toBe('auto_pending');
  expect(run(db, new Date(at.getTime() + 6 * 3600000))).toEqual([{ id: 'listen', formed: false }]);
  db.exec("UPDATE events SET starts_at='2020-01-01T00:00:00Z',minimum_participants=2 WHERE id='karaoke'");
  const old = eventRow(db, 'karaoke'); expect(run(db)).toEqual([]); expect(eventRow(db, 'karaoke')).toEqual(old);
});

async function runtime(db: DB, clock: () => Date) {
  const app = createApp({ db, origin, now: clock, activityBot: defaults, activityFormationScheduling: true });
  await app.ready(); cleanup.push(() => app.close());
  const cookie = 'kanban_session=fixture-alice', session = (await app.inject({ url: '/api/v2/session', headers: { cookie } })).json();
  const headers = { cookie, origin, 'x-account-scope': session.scope, 'x-csrf-token': session.csrf };
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers: { ...headers, 'idempotency-key': randomUUID() }, payload });
  return { app, post, headers };
}

test('startup and requests expose cancellation in history and block normal, recovered and invited signup', async () => {
  const db = setup(); addPerson(db, 'invited-person', 'invited');
  db.exec("UPDATE attendees SET invitation_token='iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii' WHERE id='invited-person'");
  let time = new Date(start.getTime() - 1); const { app, post } = await runtime(db, () => time);
  time = start;
  const upcoming = (await app.inject('/api/v2/activities')).json(); expect(upcoming.events.map((e: { id: string }) => e.id)).not.toContain('listen');
  const history = (await app.inject('/api/v2/activities?period=history&status=unformed')).json();
  expect(history.events).toContainEqual(expect.objectContaining({ id: 'listen', phase: 'cancelled', formationState: 'unformed', registrationOpen: false }));
  const revision = eventRow(db, 'listen')!.revision;
  const preview = await post('/api/v2/activities/listen/registration/preview', { revision, people: [{ isSelf: true, name: '', note: '', payerKind: 'self' }], queueMode: 'individual', intent: 'registered' });
  expect(preview.statusCode).toBe(409);
  expect((await post('/api/v2/activities/listen/invitations/iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii/accept', { revision, conditionsVersion: 1, acceptConditions: true, acceptWaiting: true, confirm: true })).statusCode).toBe(409);
  expect((await post('/api/v2/me/legacy-requests/registration/inspect', { method: 'POST', path: '/api/events/listen/roster/parties', data: { base_revision: revision, people: [{ is_self: true }] }, requestKey: 'a'.repeat(32) })).statusCode).toBe(409);
  expect((await app.inject('/api/v2/activities/listen')).json().cancellationReason).toContain('1/2');
});

test('formed activities permit joining during the activity and keep formation after withdrawals', async () => {
  const db = setup(2), { app, post } = await runtime(db, () => start);
  expect(eventRow(db, 'listen')?.formation_state).toBe('formed');
  const preview = await post('/api/v2/activities/listen/registration/preview', { revision: eventRow(db, 'listen')!.revision, people: [{ isSelf: true, name: '', note: '', payerKind: 'self' }], queueMode: 'individual', intent: 'registered' });
  expect(preview.statusCode, preview.body).toBe(200);
  expect((await app.inject('/api/v2/activities/listen')).json().registrationOpen).toBe(true);
  db.exec("UPDATE attendees SET status='withdrawn' WHERE id='confirmed-1'");
  expect((await app.inject('/api/v2/activities')).json().events).toContainEqual(expect.objectContaining({ id: 'listen', phase: 'ongoing', formationState: 'formed' }));
});

test('startup immediately decides an already due activity', async () => {
  const db = setup(); await runtime(db, () => start);
  expect(eventRow(db, 'listen')?.formation_state).toBe('unformed');
});
