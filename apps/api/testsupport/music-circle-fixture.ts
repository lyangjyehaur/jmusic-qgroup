import type { DB } from '@qgroup/database';
export const circleId = (n: number) => 'm_c' + n.toString(16).padStart(23, '0');
export function musicCircleFixture(db: DB) {
  const term = (id: string) => { db.prepare('INSERT OR IGNORE INTO music_entries VALUES(?,?,?)').run(id, '圈子詞 ' + id, 'sub'); return id; };
  const member = (n: number, name: string, ids: string[], user: string | null = null) => {
    const id = circleId(n);
    db.prepare("INSERT INTO music_profiles VALUES(?,?,1,'synthetic',NULL)").run(id, user);
    db.prepare("INSERT INTO music_profile_fields VALUES(?,?,?,0,?,0,0,'synthetic')").run(id, name, '不可匯出私人留言', '不可匯出性別');
    ids.forEach((entryId, i) => db.prepare('INSERT INTO music_selections VALUES(?,?,3,?)').run(id, term(entryId), i));
  };
  // Admission order A,B,C differs from source order A,C,B. A and C share nothing.
  member(1, '鏈首', ['chain-a','chain-b'], 'alice'); member(2, '鏈尾', ['chain-c','chain-d'], 'bob'); member(3, '橋接', ['chain-b','chain-c']);
  for (let i = 0; i < 10; i++) { member(10 + i * 2, '同名' + i, ['group-' + i]); member(11 + i * 2, '同名' + i, ['group-' + i]); }
  member(40, '獨立選擇', Array.from({length:10},(_,i)=>'independent-'+i)); member(41, '另一位獨立成分', ['separate']); member(42, '空白成分', []);
  db.prepare("INSERT INTO music_profile_contacts VALUES(?,'998877','self_reported',0,'synthetic')").run(circleId(1));
}
