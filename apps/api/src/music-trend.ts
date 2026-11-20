import {musicProfileActiveSQL} from '@qgroup/database';
import { withApiError } from './error-display';
import type { FastifyInstance } from 'fastify';
import type { DB } from '@qgroup/database';
import { z } from 'zod';
import { MusicTrend, MusicTrendMembers, MusicTrendPoint } from '@qgroup/contracts';
import { DomainError, musicTrendPoints, type TrendPoint } from '@qgroup/domain';
import type { Security } from './security';
import { getProfile } from './repositories';
import { musicStats, musicTimestamp } from './music-stats';
import { musicNameJoins, musicNameSQL } from './music-fields';
const interval = 1800, keep = 48;
const nativeKind = 'trend_sample';
function countsNow(db: DB): Record<string, number> {
  // Source dictionaries first encounter IDs in member/selection order. The chart
  // retains that order for equal gains, so GROUP BY's implicit key order is wrong.
  const counts = new Map<string, number>();
  for (const row of db.prepare(`SELECT s.entry_id FROM music_selections s JOIN music_profiles p ON p.id=s.profile_id
    WHERE ${musicProfileActiveSQL('p')} ORDER BY p.rowid,s.position`).all() as { entry_id: string }[]) counts.set(row.entry_id, (counts.get(row.entry_id) ?? 0) + 1);
  return Object.fromEntries(counts);
}
function history(db: DB): TrendPoint[] {
  const rows = db.prepare(`SELECT kind,payload_json FROM music_documents WHERE kind IN ('trend',?) ORDER BY CASE kind WHEN 'trend' THEN 0 ELSE 1 END,position`).all(nativeKind) as { payload_json: string }[];
  return rows.flatMap(row => {
    const raw = JSON.parse(row.payload_json) as { t?: unknown; counts?: unknown };
    // The old handler skips invalid timestamps. Aggregate payload corruption stays visible.
    const t = integerTime(raw.t);
    if (t === null) return [];
    const point = MusicTrendPoint.safeParse({ t, counts: raw.counts ?? {} });
    if (!point.success) throw withApiError(new DomainError('TREND_HISTORY_INVALID', '趨勢快照格式不符，請管理員核對匯入資料；原始資料仍保留', 409));
    return [point.data];
  }).slice(-keep);
}
function integerTime(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'string' && !/^[+-]?\p{Decimal_Number}(?:_?\p{Decimal_Number})*$/u.test(value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, ''))) return null;
  if (!['number', 'string', 'boolean'].includes(typeof value)) return null;
  const time = Math.trunc(musicTimestamp(value)); return Number.isSafeInteger(time) ? time : null;
}
function profiles(db: DB) {
  return (db.prepare(`SELECT p.id,${musicNameSQL} name,l.fields_json,c.created_at FROM music_profiles p ${musicNameJoins}
    LEFT JOIN music_profile_creation c ON c.profile_id=p.id WHERE ${musicProfileActiveSQL('p')} ORDER BY p.rowid`).all() as { id: string; name: string; fields_json: string | null; created_at: string | null }[])
    .map(row => ({ id: row.id, name: row.name, createdAt: row.fields_json !== null ? integerTime((JSON.parse(row.fields_json) as { createdAt?: unknown }).createdAt)
      : row.created_at && Number.isFinite(Date.parse(row.created_at)) ? Math.trunc(Date.parse(row.created_at) / 1000) : null }));
}
export function readMusicTrend(db: DB, now: Date) {
  const asOf = now.getTime() / 1000, counts = countsNow(db), members = profiles(db);
  const rawEntries = db.prepare(`SELECT e.id,e.name,e.kind,COALESCE(d.category,CASE e.kind WHEN 'main' THEN '领域' ELSE '其他' END) category,
    COALESCE(d.created_at_json,'0') created_at_json FROM music_entries e LEFT JOIN music_entry_details d ON d.entry_id=e.id ORDER BY e.rowid`).all() as { id: string; name: string; kind: 'main' | 'sub'; category: string; created_at_json: string }[];
  const entries = rawEntries.map(row => ({ id: row.id, name: row.name, kind: row.kind, category: row.category, count: counts[row.id] ?? 0, createdAt: integerTime(JSON.parse(row.created_at_json)) }));
  const recent = (days: number) => ({ entries: entries.filter(row => row.createdAt !== null && row.createdAt > asOf - days * 86400).length, members: members.filter(row => row.createdAt !== null && row.createdAt > asOf - days * 86400).length });
  const stats = musicStats(db, rawEntries.map(row => row.created_at_json), now);
  return MusicTrend.parse({ points: musicTrendPoints(history(db), counts, asOf), intervalSeconds: interval, asOf,
    entries: entries.map(({ id, name, kind }) => ({ id, name, kind })), recentEntries: [...entries].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, 8),
    recent24h: { entries: stats.recentEntries24h, members: stats.recentMembers24h }, new7d: recent(7), totals: { entries: entries.length, members: members.length } });
}
/** Only the sampler writes aggregates. No credentials, per-member IDs or outbox work. */
export function sampleMusicTrend(db: DB, now: Date) {
  return db.transaction(() => {
    const t = Math.trunc(now.getTime() / 1000), last = history(db).at(-1);
    // Idempotent across startup, concurrent processes and clock rollback. Never backfill invented points.
    if (last && t - last.t < interval - 30) return false;
    const counts = countsNow(db);
    db.prepare('INSERT INTO music_documents(kind,position,payload_json) VALUES(?,?,?)').run(nativeKind, t, JSON.stringify({ t, counts }));
    db.prepare('DELETE FROM music_documents WHERE kind=? AND position NOT IN (SELECT position FROM music_documents WHERE kind=? ORDER BY position DESC LIMIT ?)').run(nativeKind, nativeKind, keep);
    return true;
  }).immediate();
}
export function startMusicTrendSampler(db: DB, now: () => Date, onError: (error: unknown) => void) {
  let stopped = false, timer: ReturnType<typeof setTimeout>;
  const tick = () => { try { sampleMusicTrend(db, now()); } catch (error) { onError(error); } };
  const schedule = () => { const time = now().getTime(), delay = Math.max(5000, (Math.floor(time / (interval * 1000)) + 1) * interval * 1000 - time);
    timer = setTimeout(() => { if (stopped) return; tick(); schedule(); }, delay); timer.unref(); };
  tick(); schedule();
  return () => { stopped = true; clearTimeout(timer); };
}
export function registerMusicTrend(app: FastifyInstance, db: DB, security: Security, now: () => Date) {
  app.get('/api/v2/music/trend', async request => db.transaction(() => {
    z.object({}).strict().parse(request.query);
    return readMusicTrend(db, now());
  })());
  app.get('/api/v2/music/trend/members', async request => db.transaction(() => {
    const viewer = security.scopedMember(request); z.object({}).strict().parse(request.query);
    if (!getProfile(db, viewer.id)) throw withApiError(new DomainError('MUSIC_PROFILE_REQUIRED', '請先保存成分，再查看新增同好', 403));
    return MusicTrendMembers.parse({ members: profiles(db).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, 8) });
  })());
}
