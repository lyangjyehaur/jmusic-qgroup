import {musicProfileActiveSQL,musicSourceOrderSQL} from '@qgroup/database';
import { legacyMusicFields, type DB } from '@qgroup/database';
import { musicMatches, type MatchEntry } from '@qgroup/domain';
import { musicNameJoins, musicNameSQL } from './music-fields';
export function musicMatchData(db: DB) {
  const entries = db.prepare(`SELECT e.id,e.name,e.kind,count(p.id) AS count FROM music_entries e
    LEFT JOIN music_selections s ON s.entry_id=e.id LEFT JOIN music_profiles p ON p.id=s.profile_id AND ${musicProfileActiveSQL('p')}
    GROUP BY e.id ORDER BY ${musicSourceOrderSQL('entry','e')}`).all() as MatchEntry[];
  const raw = db.prepare(`SELECT p.id,${musicNameSQL} AS name,
    COALESCE(c.contact_qq,'') AS contactQQ,CASE WHEN c.contact_qq!='' THEN c.source ELSE '' END AS contactSource,
    f.note,f.gender,f.gender_public AS genderPublic,l.fields_json AS sourceFields
    FROM music_profiles p ${musicNameJoins} LEFT JOIN music_profile_contacts c ON c.profile_id=p.id
    WHERE ${musicProfileActiveSQL('p')} ORDER BY ${musicSourceOrderSQL('profile','p')}`).all() as {
      id: string; name: string; contactQQ: string; contactSource: 'legacy' | 'self_reported' | '';
      note: string | null; gender: string | null; genderPublic: number | null; sourceFields: string | null;
    }[];
  const selections = new Map<string, { entryId: string; level: number }[]>();
  for (const row of db.prepare(`SELECT s.profile_id,s.entry_id,s.level FROM music_selections s JOIN music_profiles p ON p.id=s.profile_id
    WHERE ${musicProfileActiveSQL('p')} ORDER BY ${musicSourceOrderSQL('profile','p')},s.position`).all() as { profile_id: string; entry_id: string; level: number }[]) {
    const list = selections.get(row.profile_id) ?? [];
    list.push({ entryId: row.entry_id, level: row.level }); selections.set(row.profile_id, list);
  }
  const members = raw.map(row => {
    const fields = row.genderPublic === null ? legacyMusicFields(row.name, row.sourceFields ?? '{}')
      : { note: row.note!, gender: row.gender!, genderPublic: !!row.genderPublic };
    return { id: row.id, name: row.name, contactQQ: row.contactQQ, contactSource: row.contactSource,
      note: fields.note, ownerGender: fields.gender, gender: fields.genderPublic ? fields.gender : '', selections: selections.get(row.id) ?? [] };
  });
  return { entries, members };
}
export type MusicMatchData = ReturnType<typeof musicMatchData>;
export type MatchingMember = MusicMatchData['members'][number];
export const matchingIdentity = (member: MatchingMember, note: boolean, owner = false) => ({
  id: member.id, name: member.name, contactQQ: member.contactQQ, contactSource: member.contactSource,
  gender: owner ? member.ownerGender : member.gender, note: note ? member.note : '',
});
export function musicNoteAllowed(db: DB, viewerId: string, otherId: string) {
  const owned = db.prepare(`SELECT id FROM music_profiles WHERE user_id=? AND ${musicProfileActiveSQL('music_profiles')}`).get(viewerId) as { id: string } | undefined;
  if (!owned) return false;
  if (owned.id === otherId) return true;
  const data = musicMatchData(db), me = data.members.find(member => member.id === owned.id)!;
  return musicMatches(me, data.members, data.entries).matches[0]?.member.id === otherId;
}
