import {musicProfileActiveSQL} from '@qgroup/database';
import { withApiError } from './error-display';
import type { FastifyInstance } from 'fastify';
import type { DB } from '@qgroup/database';
import { MusicCircles } from '@qgroup/contracts';
import { DomainError, musicCircles, type MatchEntry, type MatchMember } from '@qgroup/domain';
import { z } from 'zod';
import type { Security } from './security';
import { getProfile } from './repositories';
import { musicNameJoins, musicNameSQL } from './music-fields';
export function registerMusicCircles(app: FastifyInstance, db: DB, security: Security) {
  app.get('/api/v2/music/circles', async request => db.transaction(() => {
    const viewer = security.scopedMember(request);
    if (!getProfile(db, viewer.id)) throw withApiError(new DomainError('MUSIC_PROFILE_REQUIRED', '請先保存成分，再查看同好圈子', 403));
    const { minLink } = z.object({ minLink: z.coerce.number().int().min(1).max(100).default(40) }).strict().parse(request.query);
    const entries = db.prepare('SELECT id,name,kind,0 AS count FROM music_entries ORDER BY rowid').all() as MatchEntry[];
    const picks = new Map<string, MatchMember['selections'][number][]>();
    for (const row of db.prepare(`SELECT s.profile_id,s.entry_id,s.level FROM music_selections s JOIN music_profiles p ON p.id=s.profile_id
      WHERE ${musicProfileActiveSQL('p')} ORDER BY p.rowid,s.position`).all() as { profile_id: string; entry_id: string; level: number }[]) {
      const list = picks.get(row.profile_id) ?? []; list.push({ entryId: row.entry_id, level: row.level }); picks.set(row.profile_id, list);
    }
    // Only the fields required by clustering are loaded. Notes/contact/gender never enter this projection.
    const members = (db.prepare(`SELECT p.id,${musicNameSQL} name FROM music_profiles p ${musicNameJoins} WHERE ${musicProfileActiveSQL('p')} ORDER BY p.rowid`).all() as { id: string; name: string }[])
      .map(member => ({ ...member, selections: picks.get(member.id) ?? [] }));
    return MusicCircles.parse(musicCircles(members, entries, minLink));
  })());
}
