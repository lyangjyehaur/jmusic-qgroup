import type { DB } from '@qgroup/database';
import { hash } from '../src/app';
/** Synthetic only. Never imported by either runtime entry point. */
export function fixture(db: DB) {
  const created = '2026-11-17T00:00:00+00:00';
  for (const [id, nickname, token] of [['alice', '小青', 'fixture-alice'], ['bob', '小白', 'fixture-bob']]) {
    db.prepare('INSERT INTO users(id,token_hash,nickname,created_at) VALUES(?,?,?,?)').run(id, hash(token!), nickname, created);
    db.prepare('INSERT INTO browser_sessions VALUES(?,?,?)').run(hash(token!), id, created);
  }
  const events = [
    ['listen', '週末一起聽日系音樂', '音樂聚會', '台北 · 河岸小屋', 'public', 'scheduled', 'open'],
    ['karaoke', '冬日的第一場合唱', '卡拉 OK', '台中 · 日光包廂', 'public', 'scheduled', 'open'],
    ['past', '上次的相聚', '音樂聚會', '台北', 'public', 'ended', 'open'],
    ['invite', '私人活動', '音樂聚會', '私人地點', 'invite', 'scheduled', 'open'],
    ['draft', '未發布活動', '音樂聚會', '私人地點', 'public', 'draft', 'open'],
    ['deleted', '已刪除活動', '音樂聚會', '私人地點', 'public', 'cancelled', 'deleted'],
  ];
  for (const [id, title, category, location, visibility, lifecycle, status] of events) {
    db.prepare(`INSERT INTO events(id,owner_id,title,category,location,starts_at,deadline,capacity,description,status,created_at,visibility,lifecycle,duration_hours,timezone)
      VALUES(?,'alice',?,?,?,'2099-12-12T06:00:00+00:00','2099-12-11T06:00:00+00:00',12,?, ?,?,?,?,3,'Asia/Taipei')`)
      .run(id, title, category, location, '帶一首最近喜歡的歌來分享。\n聽歌、聊天，認識新的同好。', status, created, visibility, lifecycle);
  }
  const names = ['J-POP', '動畫歌曲', '搖滾', '電子', '獨立音樂', '古典'];
  const insert = db.prepare('INSERT INTO music_entries VALUES(?,?,?)');
  names.forEach((name, index) => insert.run('main-' + index, name, 'main'));
  ['YOASOBI', 'ヨルシカ', 'Aimer', 'ずっと真夜中でいいのに。', '米津玄師', '宇多田光', 'Eve', 'RADWIMPS', 'BUMP OF CHICKEN', '椎名林檎', 'King Gnu', '羊文學', '藤井風', 'Vaundy', 'スピッツ', 'あいみょん'].forEach((name, index) => insert.run('sub-' + index, name, 'sub'));
}
