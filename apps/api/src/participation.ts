import type { FastifyInstance } from 'fastify';
import type { DB } from '@qgroup/database';
import { ParticipationQuery, type ParticipationRecord } from '@qgroup/contracts';
import { ActivityPath } from '@qgroup/contracts/http-paths';
import { activityState, DomainError } from '@qgroup/domain';
import type { z } from 'zod';
import { hash, type Security } from './security';
import { withApiError } from './error-display';
import { safeAvatar } from './qq-provider';

type Filters = z.infer<typeof ParticipationQuery>;
type Record = z.infer<typeof ParticipationRecord>;
type Event = { id: string; title: string; category: string; starts_at: string; deadline: string; duration_hours: number | null; timezone: string | null; lifecycle: string; archived_at: string | null; status: string; registration_open: number; visibility: 'public' | 'invitation' };
type Person = { event_id: string; user_id: string | null; name: string | null; avatar_url: string | null };
const memberKey = (id: string) => hash('qgroup-participation-member:' + id);
const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' });
function periodDate(value: string) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? localDate.format(new Date(time)) : null;
}
function collection(db: DB, now: Date, viewerId?: string) {
  // Personal results require actual user_id and the same invitation access as the activity.
  // Ownership, management, matching names and payment responsibility never imply attendance.
  const rows = db.prepare(`SELECT e.* FROM events e WHERE e.status!='deleted'
    AND e.lifecycle IN ('scheduled','ongoing','ended')
    AND (e.actual_started_at IS NOT NULL OR e.formation_state IN ('confirmed','formed') OR (SELECT count(*) FROM attendees a WHERE a.event_id=e.id AND a.status='confirmed')>=e.minimum_participants)
    AND ${viewerId ? `(e.visibility='public' OR e.owner_id=? OR EXISTS(SELECT 1 FROM event_access x WHERE x.event_id=e.id AND x.user_id=?))
    AND EXISTS(SELECT 1 FROM attendees a WHERE a.event_id=e.id AND a.status='confirmed' AND a.user_id=?)` : "e.visibility='public'"}`).all(...(viewerId ? [viewerId, viewerId, viewerId] : [])) as Event[];
  const events = rows.filter(e => { const state = activityState(e, now); return periodDate(e.starts_at) !== null && Date.parse(e.starts_at) <= now.getTime() && (state.phase === 'ended' || state.estimatedOver); })
    .map(e => ({ id: e.id, title: e.title, category: e.category, startsAt: e.starts_at, timezone: e.timezone, estimatedOver: activityState(e, now).estimatedOver, archived: !!e.archived_at, visibility: e.visibility }))
    .sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt) || a.id.localeCompare(b.id));
  const periods = new Set<string>();
  for (const event of events) { const date = periodDate(event.startsAt)!; periods.add(date.slice(0, 4)); periods.add(date.slice(0, 7)); }
  return { events, periods: [...periods].sort().reverse(), categories: [...new Set(events.map(e => e.category))].sort() };
}
function filtered(events: Record[], query: Filters) {
  return events.filter(e => (query.category === 'all' || e.category === query.category) && (query.period === 'all' || periodDate(e.startsAt)!.startsWith(query.period)));
}
function records(name: string, events: Record[], query: Filters) {
  const start = (query.page - 1) * 20, last = events[0];
  return { name, count: events.length, lastParticipatedAt: last?.startsAt ?? null, timezone: last?.timezone ?? null, records: events.slice(start, start + 20), page: query.page, hasMore: events.length > start + 20 };
}
function members(db: DB, events: Record[], qqClientId?: string) {
  const eligible = new Set(events.map(e => e.id)), byId = new Map<string, { id: string; name: string; avatarUrl: string; events: Set<string> }>();
  let unclaimedCount = 0;
  const people = db.prepare(`SELECT a.event_id,CASE WHEN u.id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM privacy_requests p WHERE p.user_id=u.id) THEN a.user_id END AS user_id,
    u.nickname AS name,ep.avatar_url FROM attendees a LEFT JOIN users u ON u.id=a.user_id JOIN events e ON e.id=a.event_id
    LEFT JOIN external_identities ei ON ei.user_id=u.id AND ei.provider='qq' AND ei.client_id=?
    LEFT JOIN external_profiles ep ON ep.user_id=ei.user_id AND ep.provider=ei.provider AND ep.client_id=ei.client_id
    WHERE a.status='confirmed' AND e.visibility='public' AND e.status!='deleted' AND e.lifecycle IN ('scheduled','ongoing','ended')`).all(qqClientId ?? '') as Person[];
  for (const person of people) {
    if (!eligible.has(person.event_id)) continue;
    if (!person.user_id) { unclaimedCount++; continue; }
    const key = memberKey(person.user_id), member = byId.get(key) ?? { id: key, name: person.name ?? '', avatarUrl: safeAvatar(person.avatar_url ?? ''), events: new Set<string>() };
    member.events.add(person.event_id); byId.set(key, member);
  }
  return { byId, unclaimedCount };
}
export function registerParticipation(app: FastifyInstance, db: DB, security: Security, now: () => Date, qqClientId?: string) {
  app.get('/api/v2/activities/participation', async request => {
    const query = ParticipationQuery.parse(request.query);
    return db.transaction(() => {
      const data = collection(db, now()), events = filtered(data.events, query), { byId, unclaimedCount } = members(db, events, qqClientId);
      const list = [...byId.values()].map(member => { const last = events.find(e => member.events.has(e.id))!; return { id: member.id, name: member.name, avatarUrl: member.avatarUrl, count: member.events.size, lastParticipatedAt: last.startsAt, timezone: last.timezone }; })
        .sort((a, b) => b.count - a.count || Date.parse(b.lastParticipatedAt) - Date.parse(a.lastParticipatedAt) || a.id.localeCompare(b.id));
      const start = (query.page - 1) * 20;
      return { periods: data.periods, categories: data.categories, activityCount: events.length, participationCount: list.reduce((n, member) => n + member.count, unclaimedCount), memberCount: list.length, unclaimedCount, members: list.slice(start, start + 20), page: query.page, hasMore: list.length > start + 20 };
    })();
  });
  app.get('/api/v2/activities/participation/members/:id', async request => {
    const { id } = ActivityPath.parse(request.params), query = ParticipationQuery.parse(request.query);
    return db.transaction(() => {
      const data = collection(db, now()), member = members(db, data.events).byId.get(id);
      if (!member) throw withApiError(new DomainError('NOT_FOUND', '找不到公開的參加紀錄', 404));
      return records(member.name, filtered(data.events.filter(e => member.events.has(e.id)), query), query);
    })();
  });
  app.get('/api/v2/me/participation', async request => {
    const viewer = security.scopedMember(request), query = ParticipationQuery.parse(request.query);
    return db.transaction(() => {
      const data = collection(db, now(), viewer.id);
      return { ...records(viewer.nickname, filtered(data.events, query), query), periods: data.periods, categories: data.categories };
    })();
  });
}
