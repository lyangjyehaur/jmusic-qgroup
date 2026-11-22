import {musicProfileActiveSQL,musicSourceOrderSQL} from '@qgroup/database';
import { createHash } from 'node:crypto';
import { withApiError } from './error-display';
import type { FastifyInstance } from 'fastify';
import type { DB } from '@qgroup/database';
import { MusicCirclesQuery, MusicCircles } from '@qgroup/contracts';
import { DomainError, type MatchEntry, type MatchMember } from '@qgroup/domain';
import type { Security } from './security';
import { musicNameJoins, musicNameSQL } from './music-fields';
import { createCircleJobs } from './music-circle-jobs';
import type { MusicComputeBudget } from './music-compute-budget';
export function registerMusicCircles(app: FastifyInstance, db: DB, security: Security, budget: MusicComputeBudget) {
  const jobs = createCircleJobs(budget);
  app.addHook('onClose', async () => jobs.close());
  const snapshot = (request: Parameters<Security['scopedMember']>[0], admit = false) => db.transaction(() => {
    const viewer = security.scopedMember(request);
    const profile = db.prepare(`SELECT id FROM music_profiles WHERE user_id=? AND ${musicProfileActiveSQL('music_profiles')}`).get(viewer.id) as { id: string } | undefined;
    if (!profile) throw withApiError(new DomainError('MUSIC_PROFILE_REQUIRED', '請先保存成分，再查看同好圈子', 403));
    const { minLink } = MusicCirclesQuery.parse(request.query);
    if (admit) jobs.available();
    const entries = db.prepare(`SELECT e.id,e.name,e.kind,0 AS count FROM music_entries e ORDER BY ${musicSourceOrderSQL('entry','e')}`).all() as MatchEntry[];
    const picks = new Map<string, MatchMember['selections'][number][]>();
    for (const row of db.prepare(`SELECT s.profile_id,s.entry_id,s.level FROM music_selections s JOIN music_profiles p ON p.id=s.profile_id
      WHERE ${musicProfileActiveSQL('p')} ORDER BY ${musicSourceOrderSQL('profile','p')},s.position`).all() as { profile_id: string; entry_id: string; level: number }[]) {
      const list = picks.get(row.profile_id) ?? []; list.push({ entryId: row.entry_id, level: row.level }); picks.set(row.profile_id, list);
    }
    // Only the fields required by clustering are loaded. Notes/contact/gender never enter this projection.
    const members = (db.prepare(`SELECT p.id,${musicNameSQL} name FROM music_profiles p ${musicNameJoins} WHERE ${musicProfileActiveSQL('p')} ORDER BY ${musicSourceOrderSQL('profile','p')}`).all() as { id: string; name: string }[])
      .map(member => ({ ...member, selections: picks.get(member.id) ?? [] }));
    const task = { members, entries, minLink };
    return { userId: viewer.id, profileId: profile.id, task, version: createHash('sha256').update(JSON.stringify(task)).digest('hex') };
  })();
  app.get('/api/v2/music/circles', async (request, reply) => {
    const before = snapshot(request, true);
    const controller = new AbortController();
    const abort = () => controller.abort();
    const disconnected = () => { if (!reply.raw.writableEnded) abort(); };
    request.raw.once('aborted', abort);
    reply.raw.once('close', disconnected);
    try {
      const result = await jobs.run(before.task, controller.signal);
      // The worker cannot authorize its result: recheck current credentials,
      // qualification, names, selections and term data after computation.
      const current = snapshot(request);
      if (current.userId !== before.userId || current.profileId !== before.profileId || current.version !== before.version)
        throw withApiError(new DomainError('CIRCLE_SOURCE_CHANGED', '成分或詞庫已變更，請重新分析同好圈子', 409));
      return MusicCircles.parse(result);
    } finally {
      request.raw.removeListener('aborted', abort);
      reply.raw.removeListener('close', disconnected);
    }
  });
}
