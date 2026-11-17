import { createHash } from 'node:crypto';
import type { DB } from '@qgroup/database';
import { legacyMusicFields } from '@qgroup/database';
import { RoomLabSource } from '@qgroup/contracts';
import { DomainError, musicMatches, type MatchEntry, type RoomMember } from '@qgroup/domain';
import { getProfile } from './repositories';
import { musicNameJoins, musicNameSQL } from './music-fields';
import { activityRoster } from './activity-roster';
import { eventRow } from './activity-arrangements';
import { settlementVersion } from './settlement-context';
/** Minimal projection: private notes/contact/credentials never enter room work. */
export function musicRoomSource(db: DB, userId: string, eventId: string | null) {
  const own = getProfile(db, userId);
  if (!own) throw new DomainError('MUSIC_PROFILE_REQUIRED', '請先保存成分，再使用分房試算', 403);
  const entries = db
    .prepare(
      `SELECT e.id,e.name,e.kind,count(p.id) count FROM music_entries e LEFT JOIN music_selections s ON s.entry_id=e.id
    LEFT JOIN music_profiles p ON p.id=s.profile_id AND p.erased_at IS NULL GROUP BY e.id ORDER BY e.rowid`,
    )
    .all() as MatchEntry[];
  const profiles = db
    .prepare(
      `SELECT p.id,p.user_id,${musicNameSQL} name,f.gender,f.gender_public,l.fields_json FROM music_profiles p ${musicNameJoins} WHERE p.erased_at IS NULL ORDER BY p.rowid`,
    )
    .all() as {
    id: string;
    user_id: string | null;
    name: string;
    gender: string | null;
    gender_public: number | null;
    fields_json: string | null;
  }[];
  const picks = new Map<string, RoomMember['selections'][number][]>();
  for (const row of db
    .prepare('SELECT profile_id,entry_id,level FROM music_selections ORDER BY profile_id,position')
    .all() as { profile_id: string; entry_id: string; level: number }[]) {
    const list = picks.get(row.profile_id) ?? [];
    list.push({ entryId: row.entry_id, level: row.level });
    picks.set(row.profile_id, list);
  }
  const music = profiles.map((profile) => {
    const legacy = profile.gender_public === null ? legacyMusicFields(profile.name, profile.fields_json ?? '{}') : null;
    const gender = (legacy ? legacy.genderPublic : !!profile.gender_public)
      ? (legacy?.gender ?? profile.gender ?? '')
      : '';
    return {
      id: profile.id,
      name: profile.name,
      selections: picks.get(profile.id) ?? [],
      gender,
      userId: profile.user_id,
    };
  });
  let members: {
      id: string;
      name: string;
      profileId: string | null;
      pickCount: number;
      status: string;
      isMe: boolean;
      recommendation: number | null;
    }[],
    work: RoomMember[],
    revision: number | null = null,
    title = '自由分房',
    canAdopt = false;
  if (eventId) {
    const roster = activityRoster(db, eventId, userId),
      event = eventRow(db, eventId)!;
    revision = roster.revision;
    title = event.title;
    const links = new Map(
      (
        db.prepare('SELECT id,user_id FROM attendees WHERE event_id=?').all(eventId) as {
          id: string;
          user_id: string | null;
        }[]
      ).map((row) => [row.id, row.user_id]),
    );
    const closed = new Set(
      (
        db.prepare('SELECT user_id FROM privacy_requests').all() as {
          user_id: string;
        }[]
      ).map((row) => row.user_id),
    );
    const byUser = new Map(
      music.filter((member) => member.userId && !closed.has(member.userId)).map((member) => [member.userId, member]),
    );
    work = [];
    members = roster.participants.map((person) => {
      const profile = byUser.get(links.get(person.id) ?? null);
      work.push({
        id: person.id,
        name: person.name,
        selections: profile?.selections ?? [],
        gender: profile?.gender ?? '',
      });
      return {
        id: person.id,
        name: person.name,
        profileId: profile?.id ?? null,
        pickCount: profile?.selections.length ?? 0,
        status: person.status,
        isMe: person.isMe,
        recommendation: null,
      };
    });
    canAdopt =
      event.owner_id === userId &&
      !event.archived_at &&
      !['draft', 'cancelled'].includes(event.lifecycle) &&
      !settlementVersion(db, eventId);
  } else {
    work = music.map(({ id, name, selections, gender }) => ({
      id,
      name,
      selections,
      gender,
    }));
    const me = music.find((member) => member.id === own.id)!,
      scores = new Map(musicMatches(me, music, entries).matches.map((row) => [row.member.id, row.stats.matchPercent]));
    members = music.map((member) => ({
      id: member.id,
      name: member.name,
      profileId: member.id,
      pickCount: member.selections.length,
      status: '',
      isMe: member.id === own.id,
      recommendation: scores.get(member.id) ?? null,
    }));
  }
  const sourceVersion = createHash('sha256')
    .update(
      JSON.stringify({
        userId,
        ownId: own.id,
        eventId,
        revision,
        canAdopt,
        members,
        work,
        entries,
      }),
    )
    .digest('hex');
  return {
    source: RoomLabSource.parse({
      eventId,
      title,
      sourceVersion,
      revision,
      canAdopt,
      members,
      selfId: members.find((member) => member.isMe)?.id ?? null,
    }),
    work,
    entries,
  };
}
