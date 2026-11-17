import { createHash, timingSafeEqual } from 'node:crypto';
import Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { assertDatabaseUsable, type DB } from '@qgroup/database';
import { z } from 'zod';
import type { EventRow } from './activity-arrangements';
import { legacyStamp } from './activity-arrangements';

const prefix = '/api/public/v1';
const visible = "visibility='public' AND lifecycle!='draft' AND status!='deleted'";
const active = ['confirmed', 'waiting', 'tentative'] as const;
const keyPattern = '[A-Za-z0-9_-]{32,128}';
class PartnerError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
function authorize(request: FastifyRequest, configuration: string) {
  const keys = configuration.split(',').map(key => key.trim());
  if (keys.length > 20 || keys.some(key => !new RegExp('^' + keyPattern + '$').test(key)))
    throw new PartnerError('Partner API is not configured', 503);
  // Node discards duplicate Authorization values in headers; inspect raw lines.
  const values: string[] = [];
  for (let i = 0; i < request.raw.rawHeaders.length; i += 2)
    if (request.raw.rawHeaders[i]!.toLowerCase() === 'authorization') values.push(request.raw.rawHeaders[i + 1]!);
  const match = values.length === 1 ? new RegExp('^Bearer[ \\t]+(' + keyPattern + ')$', 'i').exec(values[0]!) : null;
  if (!match) throw new PartnerError('Valid API key required', 401);
  const digest = (value: string) => createHash('sha256').update(value, 'ascii').digest();
  const supplied = digest(match[1]!);
  let valid = 0;
  for (const key of keys) valid |= Number(timingSafeEqual(supplied, digest(key)));
  if (!valid) throw new PartnerError('Valid API key required', 401);
}
function queryValues(raw: string, allowed: string[]) {
  if (raw && raw.split('&').length > 10) throw new PartnerError('Invalid query parameters', 400);
  const query = new URLSearchParams(raw), result = new Map<string, string>();
  for (const [key, value] of query) {
    if (!allowed.includes(key) || result.has(key)) throw new PartnerError('Unknown or repeated query parameter', 400);
    result.set(key, value);
  }
  return result;
}
function number(query: Map<string, string>, key: string, fallback: number, minimum: number, maximum: number) {
  const value = query.get(key) ?? String(fallback);
  if (value.length < 1 || value.length > 9 || /[^0-9]/.test(value) || Number(value) < minimum || Number(value) > maximum)
    throw new PartnerError('Invalid ' + key, 400);
  return Number(value);
}
function summary(db: DB, event: EventRow, now: Date) {
  const counts = { confirmed: 0, waiting: 0, tentative: 0 };
  for (const row of db.prepare('SELECT status,count(*) AS n FROM attendees WHERE event_id=? GROUP BY status').all(event.id) as {status: string; n: number}[])
    if (active.includes(row.status as typeof active[number])) counts[row.status as typeof active[number]] = row.n;
  const fields = ['id', 'title', 'category', 'location', 'starts_at', 'duration_hours', 'timezone', 'deadline', 'capacity', 'minimum_participants', 'status', 'lifecycle', 'formation_state', 'actual_started_at', 'actual_ended_at', 'archived_at', 'revision', 'conditions_version', 'created_at'] as const;
  const stamp = legacyStamp(now);
  // Preserve v1's explicit offset and second precision, including imported times.
  const zone = /([+-])(\d{2}):(\d{2})$/.exec(event.starts_at);
  const offset = zone ? (Number(zone[2]) * 60 + Number(zone[3])) * (zone[1] === '-' ? -1 : 1) : 0;
  const end = new Date(Date.parse(event.starts_at) + (event.duration_hours ?? 0) * 3600000);
  return {
    ...Object.fromEntries(fields.map(key => [key, event[key]])),
    ends_at: event.duration_hours ? new Date(end.getTime() + offset * 60000).toISOString().slice(0, 19) + (zone?.[0] ?? (event.starts_at.endsWith('Z') ? '+00:00' : '')) : null,
    phase: event.lifecycle === 'scheduled' && event.starts_at <= stamp ? 'ongoing' : event.lifecycle,
    estimated_over: ['scheduled', 'ongoing'].includes(event.lifecycle) && event.duration_hours !== null && end.getTime() <= now.getTime(),
    registration_open: event.lifecycle === 'scheduled' && !!event.registration_open && !event.archived_at && event.status === 'open' && event.deadline > stamp && event.starts_at > stamp,
    withdrawal_deadline: event.withdrawal_deadline || event.deadline,
    counts, minimum_met: counts.confirmed >= event.minimum_participants,
    remaining_capacity: event.capacity ? Math.max(0, event.capacity - counts.confirmed) : null,
    owner_name: (db.prepare('SELECT nickname FROM users WHERE id=?').get(event.owner_id) as {nickname: string}).nickname,
    url: '/?event=' + event.id,
  };
}
function identities(db: DB, eventId: string) {
  return db.prepare(`SELECT a.id,a.status,a.confirmation_state,COALESCE(u.nickname,a.name) AS name,
    CASE WHEN EXISTS(SELECT 1 FROM privacy_requests r WHERE r.user_id=a.user_id) THEN NULL ELSE a.user_id END AS user_id
    FROM attendees a JOIN users m ON m.id=a.manager_id LEFT JOIN users u ON u.id=a.user_id
    LEFT JOIN roster_parties p ON p.id=a.party_id WHERE a.event_id=? ORDER BY p.seq,a.seq`).all(eventId) as {
      id: string; status: string; confirmation_state: string; name: string; user_id: string | null;
    }[];
}
function participants(db: DB, event: EventRow) {
  return identities(db, event.id).filter(p => active.includes(p.status as typeof active[number]))
    .sort((a, b) => active.indexOf(a.status as typeof active[number]) - active.indexOf(b.status as typeof active[number]))
    .map(p => ({ attendee_id: p.id, user_id: p.user_id, name: p.name, status: p.status, confirmation_state: p.confirmation_state }));
}
// Parse only the public projection inputs. Financial and payer fields never flow
// through a browser serializer or a spread of a stored settlement snapshot.
const Rooms = z.array(z.object({ id: z.string(), name: z.string(), person_ids: z.array(z.string()) }));
const Detail = z.object({ people: z.array(z.object({ id: z.string(), name: z.string() })), rooms: Rooms.optional() });
function roomAssignments(db: DB, event: EventRow) {
  const people = identities(db, event.id), accounts = new Map(people.map(p => [p.id, p.user_id]));
  const current = new Map(people.filter(p => active.includes(p.status as typeof active[number])).map(p => [p.id, p.name]));
  function project(source: z.infer<typeof Rooms>, members: Map<string, string>) {
    const assigned = new Set<string>();
    const rooms = source.map(room => {
      const ids = room.person_ids.filter(id => members.has(id));
      ids.forEach(id => assigned.add(id));
      return { id: room.id, name: room.name, attendee_ids: ids, members: ids.map(id => ({ attendee_id: id, user_id: accounts.get(id) ?? null, name: members.get(id)! })) };
    });
    return { rooms, unassigned_attendee_ids: [...members.keys()].filter(id => !assigned.has(id)) };
  }
  const plan = db.prepare('SELECT version,snapshot_json FROM event_room_plans WHERE event_id=? ORDER BY version DESC LIMIT 1').get(event.id) as {version: number; snapshot_json: string} | undefined;
  const version = (db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM settlement_history WHERE event_id=?').get(event.id) as {version: number}).version;
  const stored = db.prepare('SELECT snapshot_json FROM settlement_details WHERE event_id=? AND version=?').get(event.id, version) as {snapshot_json: string} | undefined;
  const detail = stored ? Detail.parse(JSON.parse(stored.snapshot_json)) : null;
  return {
    planned: { version: plan?.version ?? 0, ...project(plan ? Rooms.parse(JSON.parse(plan.snapshot_json)) : [], current) },
    actual: detail ? { settlement_version: version, ...project(detail.rooms ?? [], new Map(detail.people.map(p => [p.id, p.name]))) } : null,
  };
}
export function readPublicAPI(db: DB, path: string, rawQuery: string, now: Date): object {
  if (path === prefix) {
    queryValues(rawQuery, []);
    return { api_version: 1, endpoints: { events: prefix + '/events', event: prefix + '/events/{event_id}', participants: prefix + '/events/{event_id}/participants', rooms: prefix + '/events/{event_id}/rooms' }, identity: { account: 'user_id', registration: 'attendee_id', unclaimed_guest_user_id: null }, pagination: { default_limit: 20, maximum_limit: 100 } };
  }
  if (path === prefix + '/events') {
    const query = queryValues(rawQuery, ['limit', 'offset', 'lifecycle', 'status']);
    const limit = number(query, 'limit', 20, 1, 100), offset = number(query, 'offset', 0, 0, 100000000);
    let where = visible;
    const args: string[] = [];
    for (const [key, allowed] of [['lifecycle', ['scheduled', 'ongoing', 'ended', 'cancelled']], ['status', ['open', 'closed', 'cancelled']]] as const) {
      if (query.has(key)) {
        const value = query.get(key)!;
        if (!(allowed as readonly string[]).includes(value)) throw new PartnerError('Invalid ' + key, 400);
        where += ' AND ' + key + '=?'; args.push(value);
      }
    }
    const total = (db.prepare('SELECT count(*) AS n FROM events WHERE ' + where).get(...args) as {n: number}).n;
    const found = db.prepare('SELECT * FROM events WHERE ' + where + ' ORDER BY starts_at,id LIMIT ? OFFSET ?').all(...args, limit, offset) as EventRow[];
    return { api_version: 1, events: found.map(event => summary(db, event, now)), total, limit, offset, next_offset: offset + limit < total ? offset + limit : null };
  }
  const match = /^\/api\/public\/v1\/events\/([a-f0-9]{16})(\/participants|\/rooms)?$/.exec(path);
  if (!match) throw new PartnerError('Public API endpoint not found', 404);
  queryValues(rawQuery, []);
  const event = db.prepare('SELECT * FROM events WHERE id=? AND ' + visible).get(match[1]!) as EventRow | undefined;
  if (!event) throw new PartnerError('Public event not found', 404);
  const base = { api_version: 1, event_id: event.id, revision: event.revision };
  if (match[2] === '/participants') return { ...base, participants: participants(db, event) };
  if (match[2] === '/rooms') return { ...base, ...roomAssignments(db, event) };
  return { ...base, event: { ...summary(db, event, now), description: event.description, fee_policy: event.fee_policy, cancellation_reason: event.cancellation_reason }, participants: participants(db, event), room_assignments: roomAssignments(db, event) };
}
function readSnapshot<T>(source: DB, read: (db: DB) => T): T {
  const owned = source.name !== ':memory:' && source.name !== '';
  const db = owned ? new Database(source.name, { readonly: true, fileMustExist: true, timeout: 100 }) : source;
  const previous = db.pragma('query_only', { simple: true });
  try {
    db.pragma('query_only = ON');
    // All reads are synchronous; no request can interleave on an in-memory DB.
    return db.transaction(() => { assertDatabaseUsable(db); return read(db); })();
  } finally {
    if (owned) db.close();
    else db.pragma('query_only = ' + (previous ? 'ON' : 'OFF'));
  }
}
export function registerPublicAPI(app: FastifyInstance, db: DB, now: () => Date, keys: () => string, assertReadable: () => void) {
  app.register(async function partnerRoutes(app) {
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof PartnerError) {
        if (error.status === 401) reply.header('WWW-Authenticate', 'Bearer realm="qgroup-partner-api"');
        return reply.code(error.status).send({ error: error.message });
      }
      // Do not log raw URLs, headers, SQL, snapshots or credentials on failure.
      app.log.error('Partner API request failed');
      return reply.code(503).send({ error: 'Partner API temporarily unavailable' });
    });
    app.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store').header('Allow', 'GET, HEAD, OPTIONS');
      if (request.method === 'OPTIONS') return reply.header('Allow', 'GET, HEAD, OPTIONS').code(204).send();
      authorize(request, keys());
      if (!['GET', 'HEAD'].includes(request.method)) return reply.header('Allow', 'GET, HEAD, OPTIONS').code(405).send({ error: 'Public API is read-only' });
    });
    for (const url of [prefix, prefix + '/*'])
      app.all(url, { config: { rateLimit: false } }, async request => {
        assertReadable();
        const target = request.raw.url!, separator = target.indexOf('?');
        const path = separator < 0 ? target : target.slice(0, separator);
        const query = separator < 0 ? '' : target.slice(separator + 1);
        return readSnapshot(db, snapshot => readPublicAPI(snapshot, path, query, now()));
      });
  });
}
