import type { DB } from '@qgroup/database';
import { botMoment } from '@qgroup/domain';
import { appendEventAudit, eventRow, eventSnapshot, legacyStamp } from './activity-arrangements';
import { createActivityBot, type ActivityBotDefaults } from './activity-bot';

/** Persist the start-time decision so later withdrawals cannot cancel a formed activity. */
export function finalizeDueActivityFormations(db: DB, time: Date, defaults: ActivityBotDefaults = {}, hookError: (id: string) => void = () => {}) {
  const ids = db.prepare(`SELECT id,starts_at,timezone,duration_hours,formation_state FROM events WHERE lifecycle='scheduled' AND status!='deleted'
    AND archived_at IS NULL AND actual_started_at IS NULL AND minimum_participants>0
    AND formation_state NOT IN ('confirmed','formed','unformed') ORDER BY starts_at,id`).all() as { id: string; starts_at: string; timezone: string|null; duration_hours: number|null; formation_state: string }[];
  const result: { id: string; formed: boolean }[] = [];
  for (const candidate of ids) {
    const {id}=candidate,start=botMoment(candidate.starts_at,candidate.timezone);
    if (!Number.isFinite(start)) continue;
    // Enrol future activities durably, allowing catch-up even after a full outage.
    // Unenrolled historical records keep their original lifecycle.
    if (start > time.getTime() && candidate.formation_state === 'auto_pending') continue;
    if (start <= time.getTime() && candidate.formation_state !== 'auto_pending' && start+(candidate.duration_hours??0)*3600000 <= time.getTime()) continue;
    db.transaction(() => {
      const event = eventRow(db, id)!;
      // Recheck after acquiring the write lock: another process may have decided or started it.
      if (event.status === 'deleted' || event.minimum_participants <= 0 || event.lifecycle !== 'scheduled' || event.archived_at || event.actual_started_at || ['confirmed','formed','unformed'].includes(event.formation_state)) return;
      const start = botMoment(event.starts_at, event.timezone);
      const end = start + (event.duration_hours ?? 0) * 3600000;
      if (!Number.isFinite(start)) return;
      if (start > time.getTime()) {
        db.prepare("UPDATE events SET formation_state='auto_pending' WHERE id=?").run(id);
        return;
      }
      if (event.formation_state !== 'auto_pending' && end <= time.getTime()) return;
      const confirmed = (db.prepare("SELECT count(*) n FROM attendees WHERE event_id=? AND status='confirmed'").get(id) as { n: number }).n;
      const formed = confirmed >= event.minimum_participants, stamp = legacyStamp(time), before = eventSnapshot(event);
      const reason = formed ? `已到開始時間，正式報名達到成團人數（${confirmed}/${event.minimum_participants}）。`
        : `已到開始時間，正式報名未達成團人數（${confirmed}/${event.minimum_participants}），活動已取消。`;
      if (formed) db.prepare("UPDATE events SET lifecycle='ongoing',formation_state='formed' WHERE id=?").run(id);
      else db.prepare("UPDATE events SET lifecycle='cancelled',status='cancelled',registration_open=0,formation_state='unformed',cancellation_reason=? WHERE id=?").run(reason,id);
      appendEventAudit(db,event,{id:null,nickname:'系統'},formed?'event_auto_formation':'event_auto_cancel',before,eventSnapshot(eventRow(db,id)!),reason,stamp);
      if (!formed) {
        const people = db.prepare(`SELECT owner_id id FROM events WHERE id=? UNION SELECT manager_id id FROM attendees WHERE event_id=?
          AND status NOT IN ('withdrawn','invited') UNION SELECT user_id id FROM event_roles WHERE event_id=?`).all(id,id,id) as { id: string }[];
        for (const person of people) db.prepare('INSERT INTO notifications(user_id,event_id,kind,message,created_at) VALUES(?,?,?,?,?)')
          .run(person.id,id,'event_cancelled',event.title+'：'+reason,stamp);
        // Existing cancellation payload, group policy, reminder invalidation and deduplication.
        try { db.transaction(() => createActivityBot(db,()=>time,defaults).lifecycleUpdated(id,'cancel',[]))(); }
        catch { hookError(id); }
      }
      result.push({id,formed});
    }).immediate();
  }
  return result;
}
