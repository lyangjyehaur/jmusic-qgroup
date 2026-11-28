import { afterEach, expect, test } from 'vitest';
import { openDatabase, type DB } from '@qgroup/database';
import { ParticipationOverview, ParticipationRecords, MyParticipation } from '@qgroup/contracts';
import { fixture } from '../testsupport/fixture';
import { participationFixture } from '../testsupport/participation-fixture';
import { createApp } from './app';
import { hash } from './security';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
async function setup() {
  let time = new Date('2026-11-26T12:00:00Z');
  const db = openDatabase(':memory:'); fixture(db); participationFixture(db);
  const app = createApp({ db, origin: 'http://localhost:5080', now: () => time, pairedBackupScheduling: false }); await app.ready();
  cleanups.push(async () => { await app.close(); db.close(); });
  const cookie = 'kanban_session=fixture-alice', viewer = (await app.inject({ url: '/api/v2/session', headers: { cookie } })).json();
  const headers = { cookie, 'x-account-scope': viewer.scope };
  const overview = async (query = '') => ParticipationOverview.parse((await app.inject('/api/v2/activities/participation' + query)).json());
  const mine = async (query = '') => MyParticipation.parse((await app.inject({ url: '/api/v2/me/participation' + query, headers })).json());
  return { app, db, headers, overview, mine, clock: (value: string) => { time = new Date(value); } };
}
function state(db: DB) { return Object.fromEntries(['events', 'attendees', 'settlements', 'finance_entries', 'event_audit', 'bot_outbox'].map(table => [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()])); }
test('counts confirmed people once per activity, retains unclaimed guests, and reads without changing business or bot state', async () => {
  const s = await setup();
  s.db.exec("UPDATE attendees SET attendance='absent' WHERE id='stats-dinner-bob'; UPDATE events SET archived_at='before' WHERE id='stats-dinner'; INSERT INTO settlements(event_id,total_cents,headcount,note,updated_at) VALUES('stats-karaoke',100,3,'','before');");
  const before = state(s.db), result = await s.overview();
  expect(result).toMatchObject({ activityCount: 3, participationCount: 10, memberCount: 4, unclaimedCount: 1 });
  expect(result.members[0]).toMatchObject({ name: '小青', count: 3 }); expect(result.members.find(m => m.name === '小白')?.count).toBe(2);
  expect((await s.mine()).count).toBe(3); expect((await s.mine()).records.find(r => r.id === 'stats-dinner')?.archived).toBe(true);
  expect(state(s.db)).toEqual(before);
  expect(JSON.stringify(result)).not.toMatch(/fixture-|stats-chen|stats-yu|user_id|manager_id|QQ/);
});
test('keeps invitations out of public totals and member drilldowns, and requires current personal access rather than ownership or role counts', async () => {
  const s = await setup();
  s.db.exec("UPDATE events SET lifecycle='ended',starts_at='2026-11-10T10:00:00Z',owner_id='bob' WHERE id='invite'; INSERT INTO attendees(id,event_id,manager_id,user_id,name,payer_kind,status,created_at,updated_at) VALUES('private-self','invite','bob','alice','本人','self','confirmed','before','before'); INSERT INTO event_roles VALUES('stats-role','invite','alice','[]','before')");
  expect((await s.mine()).count).toBe(3);
  s.db.exec("INSERT INTO event_access VALUES('invite','alice','before')");
  expect((await s.mine()).count).toBe(4); expect((await s.mine()).records.find(r => r.id === 'invite')?.visibility).toBe('invitation');
  const result = await s.overview(); expect(result.activityCount).toBe(3); expect(result.participationCount).toBe(10);
  const detail = ParticipationRecords.parse((await s.app.inject('/api/v2/activities/participation/members/' + result.members[0]!.id)).json());
  expect(detail.count).toBe(3); expect(JSON.stringify(detail)).not.toContain('私人');
  s.db.exec("DELETE FROM event_access WHERE event_id='invite'"); expect((await s.mine()).count).toBe(3);
  s.db.exec("DELETE FROM attendees WHERE user_id='alice'"); expect((await s.mine()).count).toBe(0);
  expect((await s.app.inject('/api/v2/activities/participation/members/alice')).statusCode).toBe(404);
});
test('excludes under-minimum events from all totals and records even after ending or archiving when no formation decision was saved', async () => {
  const s = await setup(), memberId = hash('qgroup-participation-member:alice');
  s.db.exec("UPDATE events SET minimum_participants=4,formation_state='pending',archived_at='before' WHERE id='stats-dinner'");
  const before = state(s.db);
  expect(await s.overview()).toMatchObject({ activityCount: 2, participationCount: 7, memberCount: 4 });
  const detail = ParticipationRecords.parse((await s.app.inject('/api/v2/activities/participation/members/' + memberId)).json());
  expect(detail.count).toBe(2); expect(detail.records.map(r => r.id)).not.toContain('stats-dinner');
  expect((await s.mine()).count).toBe(2); expect((await s.mine()).records.map(r => r.id)).not.toContain('stats-dinner');
  expect(await s.overview('?category=' + encodeURIComponent('聚餐'))).toMatchObject({ activityCount: 0, participationCount: 0, memberCount: 0 });
  expect(state(s.db)).toEqual(before);
  s.db.exec("UPDATE events SET minimum_participants=3 WHERE id='stats-dinner'");
  expect((await s.overview()).activityCount).toBe(3); expect((await s.mine()).count).toBe(3);
  s.db.exec("UPDATE events SET minimum_participants=2 WHERE id='stats-dinner'");
  expect((await s.overview()).activityCount).toBe(3);
});
test('formation counts confirmed guests but excludes waiting, tentative and withdrawn registrations, including for personal views', async () => {
  const s = await setup();
  s.db.exec("UPDATE events SET minimum_participants=4 WHERE id='stats-walk'");
  expect((await s.overview()).activityCount).toBe(3); expect((await s.mine()).count).toBe(3);
  for (const status of ['waiting', 'tentative', 'withdrawn']) {
    s.db.prepare("UPDATE attendees SET status=? WHERE id='stats-guest'").run(status);
    expect((await s.overview()).activityCount).toBe(2); expect((await s.mine()).count).toBe(2);
  }
  s.db.exec("UPDATE attendees SET status='confirmed' WHERE id='stats-guest'");
  expect((await s.overview()).activityCount).toBe(3);
  s.db.exec("UPDATE events SET minimum_participants=0 WHERE id='stats-walk'; UPDATE attendees SET status='waiting' WHERE id='stats-guest'");
  expect((await s.overview()).activityCount).toBe(3);
});

test.each(["formation_state='confirmed'", "formation_state='formed'", "actual_started_at='2026-11-10T10:00:00Z'"])('retains actual participation after a saved or manual formation decision: %s', async patch => {
  const s = await setup();
  s.db.exec("UPDATE events SET minimum_participants=4," + patch + " WHERE id='stats-dinner'; UPDATE attendees SET status='withdrawn' WHERE id='stats-dinner-bob'");
  expect(await s.overview()).toMatchObject({ activityCount: 3, participationCount: 9 });
  expect((await s.mine()).count).toBe(3);
  s.db.exec("UPDATE events SET lifecycle='cancelled',formation_state='unformed' WHERE id='stats-dinner'");
  expect((await s.overview()).activityCount).toBe(2);
});
test('filters by activity start in Taipei time and includes projected endings only at the exact boundary', async () => {
  const s = await setup();
  s.db.exec("UPDATE events SET starts_at='2026-10-31T23:00:00-05:00',duration_hours=3,lifecycle='scheduled',archived_at=NULL WHERE id='stats-walk'");
  s.clock('2026-11-01T06:59:59.999Z'); expect((await s.overview('?period=2026-11')).activityCount).toBe(0);
  s.clock('2026-11-01T07:00:00Z'); expect((await s.overview('?period=2026-11')).activityCount).toBe(1); expect((await s.overview('?period=2026-10')).activityCount).toBe(0);
  s.db.exec("UPDATE events SET duration_hours=NULL WHERE id='stats-walk'"); expect((await s.overview()).activityCount).toBe(0);
  s.clock('2026-11-26T12:00:00Z');
  s.db.exec("UPDATE events SET lifecycle='ended' WHERE id IN ('draft','deleted'); UPDATE events SET lifecycle='cancelled' WHERE id='stats-dinner'");
  expect((await s.overview()).activityCount).toBe(1);
  expect((await s.overview('?period=2026&category='+encodeURIComponent('约K'))).participationCount).toBe(3);
});
test('recomputes cancellation, withdrawals and claims; names never identify a guest or merge different members', async () => {
  const s = await setup();
  s.db.exec("UPDATE users SET nickname='同名' WHERE id IN ('alice','bob'); UPDATE attendees SET name='同名' WHERE id='stats-guest'");
  expect((await s.overview()).members.filter(m => m.name === '同名')).toHaveLength(2);
  expect((await s.overview()).unclaimedCount).toBe(1);
  s.db.exec("UPDATE attendees SET user_id='bob' WHERE id='stats-guest'");
  expect(await s.overview()).toMatchObject({ participationCount: 10, unclaimedCount: 0 });
  expect((await s.overview()).members.find(m => m.id === hash('qgroup-participation-member:bob'))?.count).toBe(3);
  s.db.exec("UPDATE attendees SET status='withdrawn' WHERE id='stats-dinner-alice'; UPDATE events SET lifecycle='cancelled' WHERE id='stats-karaoke'");
  expect((await s.mine()).count).toBe(1);
  s.db.exec("UPDATE attendees SET status='waiting' WHERE id='stats-walk-alice'"); expect((await s.mine()).count).toBe(0);
  s.db.exec("UPDATE attendees SET status='tentative' WHERE id='stats-dinner-bob'"); expect((await s.overview()).participationCount).toBe(4);
});
test('paginates only after filtering and keeps totals independent of the displayed page', async () => {
  const s = await setup();
  for (let i = 0; i < 25; i++) {
    const id = 'extra-' + i;
    s.db.prepare("INSERT INTO users VALUES(?,?,?,'before')").run(id, hash(id), '參加者 ' + i);
    s.db.prepare("INSERT INTO attendees(id,event_id,manager_id,user_id,name,payer_kind,status,created_at,updated_at) VALUES(?,'stats-karaoke','alice',?,'','self','confirmed','before','before')").run(id, id);
    s.db.prepare("INSERT INTO events(id,owner_id,title,category,location,starts_at,deadline,capacity,description,created_at,lifecycle,duration_hours,timezone) SELECT ?,'alice',?,'其他',location,starts_at,deadline,capacity,description,created_at,'ended',3,timezone FROM events WHERE id='stats-karaoke'").run('event-' + i, '往期 ' + i);
    s.db.prepare("INSERT INTO attendees(id,event_id,manager_id,user_id,name,payer_kind,status,created_at,updated_at) VALUES(?,?,'alice','alice','','self','confirmed','before','before')").run('self-' + i, 'event-' + i);
  }
  const first = await s.overview(), second = await s.overview('?page=2');
  expect(first.members).toHaveLength(20); expect(second.members).toHaveLength(9); expect(second.memberCount).toBe(first.memberCount); expect(second.participationCount).toBe(first.participationCount);
  expect((await s.mine()).count).toBe(28); expect((await s.mine()).records).toHaveLength(20); expect((await s.mine('?page=2')).records).toHaveLength(8);
  expect((await s.overview('?category='+encodeURIComponent('聚餐'))).memberCount).toBe(3);
});
test('rejects malformed filters, stale scopes and unauthenticated personal reads', async () => {
  const s = await setup();
  for (const query of ['?period=2026-13', '?page=0', '?category=' + 'x'.repeat(81), '?userId=bob']) expect((await s.app.inject('/api/v2/activities/participation' + query)).statusCode).toBe(400);
  expect((await s.app.inject('/api/v2/me/participation')).statusCode).toBe(401);
  expect((await s.app.inject({ url: '/api/v2/me/participation', headers: { cookie: s.headers.cookie } })).statusCode).toBe(409);
  expect((await s.app.inject({ url: '/api/v2/me/participation', headers: { ...s.headers, 'x-account-scope': 'wrong' } })).statusCode).toBe(409);
});
