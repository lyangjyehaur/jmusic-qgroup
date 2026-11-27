import type { FastifyInstance } from 'fastify';
import { musicProfileActiveSQL, type DB } from '@qgroup/database';
import { SearchQuery, SearchResults } from '@qgroup/contracts';
import { createMusicSearch, createMusicSearchRank, DomainError, musicEntryKey } from '@qgroup/domain';
import { requireActivityAccess } from './activity-access';
import { getActivity, getProfile } from './repositories';
import { musicCatalog } from './music-catalog';
import { musicNameJoins, musicNameSQL } from './music-fields';
import type { Security } from './security';

function page<T>(items: T[], number: number) {
  const start = (number - 1) * 10;
  return { items: items.slice(start, start + 10), total: items.length, hasMore: items.length > start + 10 };
}
/** Search the same visible records as their detail pages. Identity values and
 * private fields are neither search inputs nor result projections. No writes. */
export function registerSearch(app: FastifyInstance, db: DB, security: Security, now: () => Date) {
  app.get('/api/v2/search', { exposeHeadRoute: false }, async request => db.transaction(() => {
    const device = security.scoped(request), query = SearchQuery.parse(request.query), userId = device.kind === 'member' ? device.id : null;
    const key = musicEntryKey(query.q), number = (group: string) => query.group === group ? query.page : 1;
    const activities = (db.prepare("SELECT id,title,location,category FROM events WHERE status!='deleted' ORDER BY starts_at DESC,id").all() as { id: string; title: string; location: string; category: string }[]).filter(row => {
      try { requireActivityAccess(db, row.id, userId); }
      catch (error) { if (error instanceof DomainError && error.code === 'NOT_FOUND') return false; throw error; }
      return [row.title, row.location, row.category].some(value => musicEntryKey(value).includes(key));
    });
    const activityPage = page(activities, number('activities'));
    const entries = musicCatalog(db, now()).entries, rank = createMusicSearchRank(entries);
    const music = entries.filter(entry => Number.isFinite(rank(entry.id, query.q))).sort((a,b)=>rank(a.id,query.q)-rank(b.id,query.q)).map(({ id, name, kind, category, names, translations }) => ({ id, name, kind, category, ...(names?{names,translations}:{}) }));
    const access = device.kind !== 'member' ? 'login_required' : !getProfile(db, device.id) ? 'music_required' : 'ready';
    // Check the viewer's music qualification before reading any member names.
    const profiles = access === 'ready' ? db.prepare(`SELECT p.id,${musicNameSQL} name FROM music_profiles p ${musicNameJoins}
      WHERE ${musicProfileActiveSQL('p')} ORDER BY name,p.id`).all() as { id: string; name: string }[] : [];
    const matchPeople = createMusicSearch(profiles), people = profiles.filter(profile => matchPeople(profile.id, query.q));
    return SearchResults.parse({ ...query,
      activities: { ...activityPage, items: activityPage.items.map(({ id }) => {
        const { title, category, location, startsAt, timezone, phase, archived } = getActivity(db, id, now(), userId);
        return { id, title, category, location, startsAt, timezone, phase, archived };
      }) },
      music: page(music, number('music')), people: { ...page(people, number('people')), access },
    });
  })());
}
