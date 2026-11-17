import type { DB } from '@qgroup/database';
/** Deterministic synthetic matches, isolated from the default preview and production. */
export const matchId = (n: number) => 'm_' + n.toString(16).padStart(24, '0');
export function musicMatchingFixture(db: DB) {
  const rows: { n: number; user?: string; name: string; picks: [string, number][]; public?: boolean }[] = [
    { n: 1, user: 'alice', name: '我的成分', picks: [['main-0', 1], ['main-1', 1], ['sub-0', 4], ['sub-1', 4], ['sub-2', 2], ['sub-3', 1]] },
    { n: 2, user: 'bob', name: '共同最多', public: true, picks: [['main-0', 1], ['main-1', 1], ['sub-2', 2], ['sub-3', 1], ['sub-4', 3]] },
    { n: 3, name: '共同本命', picks: [['sub-0', 4], ['sub-1', 4], ['sub-5', 2], ['sub-6', 1]] },
    { n: 4, name: '三項同好', picks: [['main-0', 1], ['main-1', 1], ['sub-2', 2], ['sub-7', 3]] },
    { n: 5, name: '同名', picks: [['main-0', 1], ['sub-3', 1], ['sub-8', 3], ['sub-9', 3]] },
    { n: 6, name: '同名', picks: [['main-0', 1], ['sub-3', 1], ['sub-8', 3], ['sub-9', 3]] },
    { n: 7, name: '一項同好', picks: [['main-0', 1], ['sub-10', 3], ['sub-11', 3], ['sub-12', 3]] },
    { n: 8, name: '少量成分', picks: [['sub-0', 4]] },
    { n: 9, name: '沒有共同項', picks: [['sub-14', 3], ['sub-15', 3]] },
    { n: 10, name: '空成分', picks: [] },
  ];
  for (const row of rows) {
    const id = matchId(row.n);
    db.prepare("INSERT INTO music_profiles VALUES(?,?,1,'synthetic',NULL)").run(id, row.user ?? null);
    db.prepare("INSERT INTO music_profile_fields VALUES(?,?,?,1,?,?,0,'synthetic')").run(id, row.name, '留言 ' + row.name, row.public ? '自訂性別' : '不可外洩性別', Number(!!row.public));
    row.picks.forEach(([entryId, level], position) => db.prepare('INSERT INTO music_selections VALUES(?,?,?,?)').run(id, entryId, level, position));
  }
  db.prepare("INSERT INTO music_profile_contacts VALUES(?,'234567','self_reported',0,'synthetic')").run(matchId(2));
  // Legacy aliases remain valid after changing the canonical contact.
  db.prepare("INSERT INTO music_legacy_profiles VALUES(?,'20003','舊名稱',1,'synthetic-private-pin','345678','{}','[]','unlinked')").run(matchId(3));
  db.prepare("INSERT INTO music_profile_contacts VALUES(?,'345678','self_reported',0,'synthetic')").run(matchId(3));
}
