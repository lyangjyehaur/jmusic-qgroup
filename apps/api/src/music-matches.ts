import { musicAvatars, withMusicAvatar } from './music-identity';
import { MusicProfilePath } from '@qgroup/contracts/http-paths';
import { withApiError } from './error-display';
import type { FastifyInstance } from 'fastify';
import type { DB } from '@qgroup/database';
import { MusicSortQuery, MusicMatches, MusicComparison, MusicShareContext, LookupMusicProfile } from '@qgroup/contracts';
import { DomainError, musicComparison, musicMatches } from '@qgroup/domain';

import type { Security } from './security';
import { getProfile } from './repositories';
import { matchingIdentity, musicMatchData } from './music-match-data';
import { resolveMusicProfileId } from './music-profile-id';
function viewerProfile(db: DB, userId: string) {
  const profile = getProfile(db, userId);
  if (!profile) throw withApiError(new DomainError('MUSIC_PROFILE_REQUIRED', '請先保存成分，再查看同好成分', 403));
  return profile;
}
function compare(db: DB, userId: string, target: string, clientId?: string) {
  const profile = viewerProfile(db, userId), otherId = resolveMusicProfileId(db, target);
  if (profile.id === otherId) throw withApiError(new DomainError('COMPARE_SELF', '這是你自己的成分，請選擇另一份成分', 400));
  const { entries, members } = musicMatchData(db), me = members.find(m => m.id === profile.id)!, other = members.find(m => m.id === otherId)!;
  const allowed = musicMatches(me, members, entries).matches[0]?.member.id === other.id;
  const avatars = musicAvatars(db, clientId);
  return MusicComparison.parse({ ...musicComparison(me.selections, other.selections, entries), me: withMusicAvatar(matchingIdentity(me, true, true), avatars), other: withMusicAvatar(matchingIdentity(other, allowed), avatars) });
}
export function registerMusicMatches(app: FastifyInstance, db: DB, security: Security, clientId?: string) {
  // Export projection is separate from matchingIdentity: it never loads notes into a response.
  app.get('/api/v2/me/music/share', async request => db.transaction(() => {
    const viewer = security.scopedMember(request), profile = getProfile(db, viewer.id);
    const { sort } = MusicSortQuery.parse(request.query);
    const musicEpoch = (db.prepare('SELECT epoch FROM music_account_epochs WHERE user_id=?').get(viewer.id) as { epoch: number } | undefined)?.epoch ?? 0;
    if (!profile) return MusicShareContext.parse({ profileId: null, musicEpoch, name: viewer.nickname, contactQQ: '', contactSource: '', sort, topMatch: null });
    const { entries, members } = musicMatchData(db), me = members.find(member => member.id === profile.id)!;
    const top = musicMatches(me, members, entries, sort).matches[0];
    return MusicShareContext.parse({ profileId: profile.id, musicEpoch, name: me.name, contactQQ: me.contactQQ, contactSource: me.contactSource, sort,
      topMatch: top ? { id: top.member.id, name: top.member.name, contactQQ: top.member.contactQQ, contactSource: top.member.contactSource,
        matchPercent: top.stats.matchPercent, sharedCount: top.stats.sharedCount } : null });
  })());
  app.get('/api/v2/music/matches', async request => db.transaction(() => {
    const viewer = security.scopedMember(request), profile = viewerProfile(db, viewer.id);
    const { sort } = MusicSortQuery.parse(request.query);
    const { entries, members } = musicMatchData(db), me = members.find(m => m.id === profile.id)!;
    const result = musicMatches(me, members, entries, sort);
    const avatars = musicAvatars(db, clientId);
    const expose = (row: typeof result.matches[number], index: number, sparse: boolean) => ({ member: withMusicAvatar(matchingIdentity(row.member, !sparse && index === 0), avatars), stats: row.stats, shared: row.shared, onlyTheirs: row.onlyTheirs });
    return MusicMatches.parse({ me: withMusicAvatar(matchingIdentity(me, true, true), avatars), mine: musicComparison(me.selections, [], entries).mine, sort,
      matches: result.matches.map((row, index) => expose(row, index, false)), sparseMatches: result.sparseMatches.map((row, index) => expose(row, index, true)) });
  })());
  app.post('/api/v2/music/compare', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async request => db.transaction(() => {
    const viewer = security.memberWrite(request); viewerProfile(db, viewer.id);
    return compare(db, viewer.id, LookupMusicProfile.parse(request.body).query, clientId);
  })());
  app.get('/api/v2/music/profiles/:id/comparison', async request => db.transaction(() => {
    const viewer = security.scopedMember(request); viewerProfile(db, viewer.id);
    const { id } = MusicProfilePath.parse(request.params);
    return compare(db, viewer.id, id, clientId);
  })());
}
