import type { DB } from '@qgroup/database';
import { hash } from '../src/security';

/** Synthetic statistics examples; never included in the runtime entry point. */
export function participationFixture(db: DB) {
  for (const [id, name] of [['stats-chen', '阿辰'], ['stats-yu', '小雨']]) db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(id, hash('fixture-' + id), name, 'synthetic');
  const events = [
    ['stats-karaoke', '週二唱歌', '约K', '2026-11-03T10:00:00+00:00', 'ended'],
    ['stats-dinner', '晚餐聚會', '聚餐', '2026-11-12T10:00:00+00:00', 'ended'],
    ['stats-walk', '河濱散步', '出游', '2026-11-21T08:00:00+00:00', 'scheduled'],
    ['stats-cancelled', '已取消的聚餐', '聚餐', '2026-11-09T10:00:00+00:00', 'cancelled'],
  ];
  for (const [id, title, category, startsAt, lifecycle] of events) db.prepare(`INSERT INTO events(id,owner_id,title,category,location,starts_at,deadline,capacity,description,created_at,lifecycle,duration_hours,timezone)
    VALUES(?,'alice',?,?, '台北',?, ?,12,'','synthetic',?,3,'Asia/Taipei')`).run(id, title, category, startsAt, startsAt, lifecycle);
  const people = [['stats-karaoke','alice'],['stats-karaoke','bob'],['stats-karaoke','stats-chen'],['stats-dinner','alice'],['stats-dinner','bob'],['stats-dinner','stats-yu'],['stats-walk','alice'],['stats-walk','stats-chen'],['stats-walk','stats-yu'],['stats-cancelled','alice']];
  for (const [eventId, userId] of people) db.prepare("INSERT INTO attendees(id,event_id,manager_id,user_id,name,payer_kind,status,created_at,updated_at) VALUES(?,?,'alice',?,'原報名稱呼','self','confirmed','synthetic','synthetic')").run(eventId + '-' + userId, eventId, userId);
  db.prepare("INSERT INTO attendees(id,event_id,manager_id,name,payer_kind,status,created_at,updated_at) VALUES('stats-guest','stats-walk','alice','未認領同行','manager','confirmed','synthetic','synthetic')").run();
}
