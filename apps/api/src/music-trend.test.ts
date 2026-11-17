import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type DB } from '@qgroup/database';
import { MusicTrend, MusicTrendMembers } from '@qgroup/contracts';
import { fixture } from '../testsupport/fixture';
import { musicTrendFixture } from '../testsupport/music-trend-fixture';
import { createApp } from './app';
import { sampleMusicTrend, startMusicTrendSampler } from './music-trend';
const stamp = '2026-11-17T08:00:00.125Z', now = Date.parse(stamp) / 1000, origin = 'https://rebuild.example';
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup(db = openDatabase(':memory:')) {
  fixture(db); musicTrendFixture(db, new Date(stamp));
  const app = createApp({ db, origin, now: () => new Date(stamp) }); await app.ready();
  cleanup.push(async () => { await app.close(); db.close(); });
  const cookie = 'kanban_session=fixture-alice', viewer = (await app.inject({ url: '/api/v2/session', headers: { cookie } })).json();
  const headers = { cookie, origin, 'x-account-scope': viewer.scope, 'x-csrf-token': viewer.csrf };
  const read = () => app.inject({ url: '/api/v2/music/trend' });
  const members = (h = headers) => app.inject({ url: '/api/v2/music/trend/members', headers: h });
  return { app, db, read, members, headers };
}
function snapshot(db: DB) {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(({ name }) => [name, db.prepare('SELECT * FROM "' + name + '"').all()]);
}
describe('music trend read and sampling', () => {
  it('matches the real Python trend handler for original history, latest counts, creation ordering, totals and strict seven-day counts', async () => {
    const s = await setup();
    const entries = s.db.prepare(`SELECT e.id,e.name text,e.kind,d.category,COALESCE(d.created_at_json,'0') created FROM music_entries e LEFT JOIN music_entry_details d ON d.entry_id=e.id ORDER BY e.rowid`).all() as { id: string; text: string; kind: string; category: string | null; created: string }[];
    const members = s.db.prepare(`SELECT p.id qq,f.name,c.created_at FROM music_profiles p JOIN music_profile_fields f ON f.profile_id=p.id LEFT JOIN music_profile_creation c ON c.profile_id=p.id ORDER BY p.rowid`).all() as { qq: string; name: string; created_at: string | null }[];
    const picks = s.db.prepare('SELECT profile_id,entry_id FROM music_selections ORDER BY profile_id,position').all() as { profile_id: string; entry_id: string }[];
    const trend = (s.db.prepare("SELECT payload_json FROM music_documents WHERE kind='trend' ORDER BY position").all() as { payload_json: string }[]).map(row => JSON.parse(row.payload_json));
    const input = { entries: Object.fromEntries(entries.map(row => [row.id, { id: row.id, text: row.text, kind: row.kind, category: row.category || (row.kind === 'main' ? '领域' : '其他'), createdAt: JSON.parse(row.created) }])),
      members: Object.fromEntries(members.map(row => [row.qq, { qq: row.qq, name: row.name, createdAt: row.created_at ? Date.parse(row.created_at) / 1000 || 0 : 0, selection: picks.filter(pick => pick.profile_id === row.qq).map(pick => pick.entry_id) }])), trend };
    const expected = JSON.parse(execFileSync('python3', ['-c', `import json,sys
from music_site import upstream as u
u.data=json.load(sys.stdin);u.time.time=lambda:${now}
print(json.dumps(u.Handler.compute_trend(None),ensure_ascii=False))`], { input: JSON.stringify(input), encoding: 'utf8' }));
    const response = await s.read(); expect(response.statusCode, response.body).toBe(200); const actual = MusicTrend.parse(response.json());
    expect(actual.points).toEqual(expected.points); expect(actual.new7d).toEqual(expected.new7d); expect(actual.totals).toEqual(expected.totals);
    expect(actual.recentEntries.map(({ id, name, ...entry }) => ({ id, text: name, ...entry, createdAt: entry.createdAt ?? 0 }))).toEqual(expected.recentEntries);
    expect(MusicTrendMembers.parse((await s.members()).json()).members.map(({ id, name, createdAt }) => ({ qq: id, name, createdAt: createdAt ?? 0 }))).toEqual(expected.recentMembers);
  });
  it('keeps public aggregates and scoped new members separate, rejects overrides and leaks no contacts or private fields', async () => {
    const s = await setup(), before = snapshot(s.db), writes = s.db.prepare('SELECT total_changes() n').get();
    const publicResponse = await s.read(); expect(publicResponse.body).not.toMatch(/我的成分|共同最多|m_000|234567|留言|性別|pin|qq|user_id|scope|token|alice/);
    const response = await s.members(); expect(response.statusCode).toBe(200); expect(response.body).not.toMatch(/234567|留言|性別|pin|qq|user_id|scope|token|alice/);
    for (const r of [publicResponse, response]) { expect(r.headers['cache-control']).toBe('no-store'); expect(r.headers.vary).toBe('Cookie'); }
    expect((await s.members({ ...s.headers, cookie: '' })).statusCode).toBe(401);
    expect((await s.members({ ...s.headers, 'x-account-scope': 'wrong' })).statusCode).toBe(409);
    for (const path of ['/api/v2/music/trend?viewer=bob', '/api/v2/music/trend/members?qq=10001']) expect((await s.app.inject({ url: path, headers: s.headers })).statusCode).toBe(400);
    expect(snapshot(s.db)).toEqual(before); expect(s.db.prepare('SELECT total_changes() n').get()).toEqual(writes);
  });
  it('uses float for the 24h count but integer source times for 7d and display; missing native creation stays unknown', async () => {
    const s = await setup(); s.db.exec('DELETE FROM music_entry_details');
    const values = [now - 86400, now - 86400 + .001, Math.trunc(now) - 7 * 86400, Math.trunc(now) - 7 * 86400 + 1, String(Math.trunc(now) + 50), 0];
    values.forEach((value, i) => s.db.prepare('INSERT INTO music_entry_details VALUES(?,?,?,?,?,?)').run('sub-' + i, '歌手', '[]', '', JSON.stringify(value), 'null'));
    const result = MusicTrend.parse((await s.read()).json());
    expect(result.recent24h.entries).toBe(2); expect(result.new7d.entries).toBe(4);
    expect(result.recentEntries.find(row => row.id === 'sub-1')?.createdAt).toBe(Math.trunc(now - 86400));
    s.db.prepare('UPDATE music_profile_creation SET created_at=NULL').run();
    const member = MusicTrendMembers.parse((await s.members()).json()).members; expect(member.some(row => row.createdAt === null)).toBe(true);
  });
  it('preserves historical aggregates after member erasure but removes their live count, identity and new-member provenance', async () => {
    const s = await setup(), history = s.db.prepare("SELECT * FROM music_documents WHERE kind='trend'").all();
    const profile = (await s.app.inject({ url: '/api/v2/me/music', headers: s.headers })).json();
    const response = await s.app.inject({ method: 'POST', url: '/api/v2/me/privacy/erase', headers: s.headers, payload: { target: 'music', profileId: profile.id, profileRevision: profile.revision, requestId: randomUUID(), secret: 'e'.repeat(64), confirm: true } });
    expect(response.statusCode, response.body).toBe(200); expect((await s.members()).statusCode).toBe(403);
    const bob = (await s.app.inject({ url: '/api/v2/session', headers: { cookie: 'kanban_session=fixture-bob' } })).json();
    const members = await s.members({ ...s.headers, cookie: 'kanban_session=fixture-bob', 'x-account-scope': bob.scope }); expect(members.body).not.toContain('我的成分');
    const result = MusicTrend.parse((await s.read()).json()); expect(result.totals.members).toBe(9); expect(result.points.at(-1)?.counts['sub-0']).toBe(2);
    expect(s.db.prepare("SELECT * FROM music_documents WHERE kind='trend'").all()).toEqual(history);
  });
  it('samples unchanged counts, deduplicates concurrent starts, handles rollback and gaps, bounds retained native points and preserves every unrelated table', async () => {
    const s = await setup(), before = snapshot(s.db).filter(([name]) => name !== 'music_documents'), legacy = s.db.prepare('SELECT * FROM music_documents').all();
    const at = (seconds: number) => new Date(Math.trunc(now) * 1000 + seconds * 1000);
    expect(sampleMusicTrend(s.db, at(0))).toBe(true); expect(sampleMusicTrend(s.db, at(0))).toBe(false);
    expect(sampleMusicTrend(s.db, at(1769))).toBe(false); expect(sampleMusicTrend(s.db, at(-600))).toBe(false); expect(sampleMusicTrend(s.db, at(1800))).toBe(true);
    for (let i = 2; i <= 65; i++) expect(sampleMusicTrend(s.db, at(i * 1800))).toBe(true);
    const samples = s.db.prepare("SELECT payload_json FROM music_documents WHERE kind='trend_sample' ORDER BY position").all() as { payload_json: string }[];
    expect(samples).toHaveLength(48); expect(JSON.parse(samples[0]!.payload_json).t).toBe(Math.trunc(now) + 18 * 1800);
    expect(new Set(samples.map(row => JSON.stringify(JSON.parse(row.payload_json).counts))).size).toBe(1);
    expect(s.db.prepare("SELECT * FROM music_documents WHERE kind!='trend_sample'").all()).toEqual(legacy);
    expect(snapshot(s.db).filter(([name]) => name !== 'music_documents')).toEqual(before);
    expect(sampleMusicTrend(s.db, at(10 * 86400))).toBe(true);
    expect(MusicTrend.parse((await s.read()).json()).points).toHaveLength(48);
  });
  it('continues on wall-clock half hours without user visits, reports failures and stops all timers at shutdown', async () => {
    const s = await setup(); vi.useFakeTimers(); vi.setSystemTime(new Date(stamp)); const errors: unknown[] = [];
    const stop = startMusicTrendSampler(s.db, () => new Date(), error => errors.push(error)); cleanup.push(stop);
    expect(vi.getTimerCount()).toBe(1); expect(s.db.prepare("SELECT count(*) n FROM music_documents WHERE kind='trend_sample'").get()).toEqual({ n: 1 });
    await vi.advanceTimersByTimeAsync(1800 * 1000); expect(s.db.prepare("SELECT count(*) n FROM music_documents WHERE kind='trend_sample'").get()).toEqual({ n: 2 });
    s.db.exec("CREATE TRIGGER reject_sample BEFORE INSERT ON music_documents WHEN NEW.kind='trend_sample' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
    await vi.advanceTimersByTimeAsync(1800 * 1000); expect(errors).toHaveLength(1);
    s.db.exec('DROP TRIGGER reject_sample'); await vi.advanceTimersByTimeAsync(1800 * 1000); expect(s.db.prepare("SELECT count(*) n FROM music_documents WHERE kind='trend_sample'").get()).toEqual({ n: 3 });
    stop(); expect(vi.getTimerCount()).toBe(0);
  });
  it('retains imported bytes, skips only invalid original timestamps, reports malformed counts and does not mutate failed reads', async () => {
    const s = await setup();
    s.db.prepare("INSERT INTO music_documents VALUES('trend',50,?)").run(JSON.stringify({ t: 'not-a-time', counts: {} }));
    expect((await s.read()).statusCode).toBe(200);
    s.db.prepare("INSERT INTO music_documents VALUES('trend',51,?)").run(JSON.stringify({ t: Math.trunc(now), counts: { 'sub-0': -1 } }));
    const before = snapshot(s.db), result = await s.read(); expect(result.statusCode).toBe(409); expect(result.json().code).toBe('TREND_HISTORY_INVALID'); expect(snapshot(s.db)).toEqual(before);
  });
  it('starts sampling only in the explicit runtime mode and stops it on Fastify close without touching outbox work', async () => {
    const db = openDatabase(':memory:'); fixture(db);
    const app = createApp({ db, origin, now: () => new Date(stamp), musicTrendSampling: true });
    cleanup.push(async () => { await app.close(); db.close(); });
    await app.ready();
    expect(db.prepare("SELECT count(*) n FROM music_documents WHERE kind='trend_sample'").get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT count(*) n FROM bot_outbox').get()).toEqual({ n: 0 });
    await app.close(); const before = snapshot(db);
    await app.close(); expect(snapshot(db)).toEqual(before);
  });
  it('persists samples across reopen and leaves actual Python bot reads and all compatibility schemas unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qgroup-trend-')), path = join(dir, 'isolated.db');
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const s = await setup(openDatabase(path)), ddl = s.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
    const probe = () => JSON.parse(execFileSync('python3', ['tools/rebuild/probe-auth-bot.py', path], { encoding: 'utf8' }));
    const bot = probe(); sampleMusicTrend(s.db, new Date(stamp)); expect(probe()).toEqual(bot); expect(s.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all()).toEqual(ddl);
    const other = openDatabase(path); expect(sampleMusicTrend(other, new Date(stamp))).toBe(false); expect(other.prepare("SELECT count(*) n FROM music_documents WHERE kind='trend_sample'").get()).toEqual({ n: 1 }); other.close();
  });
});
