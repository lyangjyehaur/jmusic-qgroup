import { withApiError } from './error-display';
import type { FastifyInstance } from 'fastify';
import type { DB } from '@qgroup/database';
import { RoomLabCommand } from '@qgroup/contracts';
import { DomainError } from '@qgroup/domain';
import { z } from 'zod';
import type { Security } from './security';
import { musicRoomSource } from './music-room-source';
import { createRoomJobs } from './music-room-jobs';
export function registerMusicRooms(app: FastifyInstance, db: DB, security: Security) {
  const jobs = createRoomJobs();
  app.addHook('onClose', async () => jobs.close());
  const query = z.object({ eventId: z.string().min(1).max(80).optional() }).strict();
  app.get('/api/v2/music/rooms/source', async (request) =>
    db.transaction(() => {
      const user = security.scopedMember(request),
        { eventId } = query.parse(request.query);
      return musicRoomSource(db, user.id, eventId ?? null).source;
    })(),
  );
  app.post(
    '/api/v2/music/rooms/calculate',
    {
      bodyLimit: 128 * 1024,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request) => {
      const snapshot = db.transaction(() => {
        const user = security.memberWrite(request),
          { eventId } = query.parse(request.query),
          input = RoomLabCommand.parse(request.body),
          snapshot = musicRoomSource(db, user.id, eventId ?? null);
        if (input.sourceVersion !== snapshot.source.sourceVersion)
          throw withApiError(new DomainError('ROOM_SOURCE_CHANGED', '名單或成分已變更，請核對最新來源；原試算仍保留', 409));
        const allowed = new Map(snapshot.source.members.map((member) => [member.id, member]));
        if (input.selected.some((id) => !allowed.get(id)?.profileId))
          throw withApiError(new DomainError('ROOM_MEMBER', '自動試算成員已不存在或尚未關聯成分', 400));
        if (
          input.command === 'split' &&
          input.config.mode === 'sizes' &&
          input.config.sizes.reduce((sum, size) => sum + size, 0) < input.selected.length
        )
          throw withApiError(new DomainError('ROOM_CAPACITY', '自訂容量總和小於參與人數', 400));
        if (input.command === 'recalc') {
          const assigned = input.rooms.flatMap((room) => room.members);
          if (
            new Set(input.rooms.map((room) => room.id)).size !== input.rooms.length ||
            assigned.length > 40 ||
            new Set(assigned).size !== assigned.length ||
            assigned.some((id) => !allowed.has(id))
          )
            throw withApiError(new DomainError('ROOM_MEMBERS', '包間成員重複、超過 40 人或不屬於這份來源', 400));
          if (input.rooms.some((room) => room.members.length > room.capacity))
            throw withApiError(new DomainError('ROOM_CAPACITY', '包間人數超過設定容量，請先調整容量', 400));
          // Activity members without music may be arranged manually; unselected
          // profiles may not silently enter the scoring pool.
          if (assigned.some((id) => allowed.get(id)?.profileId && !input.selected.includes(id)))
            throw withApiError(new DomainError('ROOM_MEMBER', '請先將有成分的成員加入本次試算', 400));
        }
        const required = new Set([
          ...input.selected,
          ...(input.command === 'recalc' ? input.rooms.flatMap((room) => room.members) : []),
        ]);
        const members = snapshot.work.filter((member) => required.has(member.id) && allowed.get(member.id)?.profileId);
        const used = new Set(members.flatMap((member) => member.selections.map((pick) => pick.entryId)));
        return {
          input,
          members,
          entries: snapshot.entries.filter((entry) => used.has(entry.id)),
          eventId: eventId ?? null,
          userId: user.id,
        };
      })();
      const result = await jobs.run({ input: snapshot.input, members: snapshot.members, entries: snapshot.entries });
      // Recheck current credentials, role, membership and source after CPU work.
      return db.transaction(() => {
        const user = security.memberWrite(request),
          current = musicRoomSource(db, user.id, snapshot.eventId);
        if (user.id !== snapshot.userId || current.source.sourceVersion !== result.sourceVersion)
          throw withApiError(new DomainError('ROOM_SOURCE_CHANGED', '來源或身份已變更，這次結果已失效，請核對最新來源', 409));
        return result;
      })();
    },
  );
}
