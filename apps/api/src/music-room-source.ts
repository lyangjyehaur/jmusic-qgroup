import {musicProfileActiveSQL,musicSourceOrderSQL} from '@qgroup/database';
import { withApiError } from './error-display';
import { createHash } from 'node:crypto';
import type { DB } from '@qgroup/database';
import { legacyMusicFields } from '@qgroup/database';
import { RoomLabSource } from '@qgroup/contracts';
import { DomainError, musicCodepointOrder, musicMatches, type MatchEntry, type RoomMember } from '@qgroup/domain';
import { musicNameJoins, musicNameSQL } from './music-fields';
import { activityRoster } from './activity-roster';
import { eventRow } from './activity-arrangements';
import { roomPlan, settlementRoomDetail, settlementVersion } from './settlement-context';
/** Minimal projection: private notes/contact/credentials never enter room work. */
export function musicRoomSource(db: DB, userId: string, eventId: string | null, admit?: () => void) {
  const own = db.prepare(`SELECT id FROM music_profiles WHERE user_id=? AND ${musicProfileActiveSQL('music_profiles')}`).get(userId) as { id: string } | undefined;
  if (!own) throw withApiError(new DomainError('MUSIC_PROFILE_REQUIRED', '請先保存成分，再使用分房試算', 403));
  // Validate event visibility before admission, and reject saturated calculation
  // requests before loading the full music projection. Reads need no CPU slot.
  const context = eventId ? { roster: activityRoster(db, eventId, userId), event: eventRow(db, eventId)! } : null;
  admit?.();
  const entries = db
    .prepare(
      `SELECT e.id,e.name,e.kind,count(p.id) count FROM music_entries e LEFT JOIN music_selections s ON s.entry_id=e.id
    LEFT JOIN music_profiles p ON p.id=s.profile_id AND ${musicProfileActiveSQL('p')} GROUP BY e.id ORDER BY ${musicSourceOrderSQL('entry','e')}`,
    )
    .all() as MatchEntry[];
  const profiles = db
    .prepare(
      `SELECT p.id,p.user_id,${musicNameSQL} name,f.gender,f.gender_public,l.fields_json,l.legacy_key FROM music_profiles p ${musicNameJoins} WHERE ${musicProfileActiveSQL('p')} ORDER BY ${musicSourceOrderSQL('profile','p')}`,
    )
    .all() as {
    id: string;
    user_id: string | null;
    name: string;
    gender: string | null;
    gender_public: number | null;
    fields_json: string | null;
    legacy_key: string | null;
  }[];
  // Original Python ties compare identity strings, not migrated profile IDs.
  // Only ordinal ranks enter workers; original keys stay in this projection.
  const identityOrder = new Map(
    [...profiles]
      .sort((a, b) => musicCodepointOrder(a.legacy_key ?? a.id, b.legacy_key ?? b.id))
      .map((profile, index) => [profile.id, index]),
  );
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
      tieBreakOrder: identityOrder.get(profile.id)!,
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
  if (eventId && context) {
    const { roster, event } = context;
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
        ...(profile ? { tieBreakOrder: profile.tieBreakOrder } : {}),
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
    work = music.map(({ id, name, selections, gender, tieBreakOrder }) => ({
      id,
      name,
      selections,
      gender,
      tieBreakOrder,
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
  let currentRooms;
  if (eventId) {
    const invoice = settlementRoomDetail(db, eventId), plan = roomPlan(db, eventId);
    const version = invoice?.rooms ? settlementVersion(db, eventId) : plan.version;
    if (version) currentRooms = {
      kind: invoice?.rooms ? 'actual' as const : 'plan' as const,
      version,
      rooms: (invoice?.rooms ?? plan.rooms).map(room => ({
        id: room.id, name: room.name, members: room.person_ids,
      })),
    };
  }
  const sourceVersion = createHash('sha256')
    .update(
      JSON.stringify({
        userId,
        ownId: own.id,
        eventId,
        revision,
        canAdopt,
        currentRooms,
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
      ...(currentRooms ? { currentRooms } : {}),
      members,
      selfId: members.find((member) => member.isMe)?.id ?? null,
    }),
    work,
    entries,
  };
}
