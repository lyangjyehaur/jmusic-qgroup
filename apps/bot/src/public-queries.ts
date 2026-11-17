import type { DB } from '@qgroup/database';
import { botMoment } from '@qgroup/domain';
import type { EventRow } from '../../api/src/activity-arrangements';
import { financeSummary } from '../../api/src/finance-context';
import { BOT_FINANCE_COMMANDS, type PublicBotCommand } from './commands';

/** Public queries intentionally do not depend on the broadcast opt-in. */
const publicSQL = "visibility='public' AND lifecycle!='draft' AND status!='deleted'";
export class BotSelectionError extends Error {}
export function botEstimatedOver(event: EventRow, now: Date) {
  if (!['scheduled', 'ongoing'].includes(event.lifecycle) || !event.duration_hours) return false;
  const match=/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/i.exec(event.starts_at);
  if(!match)return false;
  const [year,month,day,hour,minute,second]=match.slice(1).map(v=>Number(v??0));
  const calendar=new Date(0);calendar.setUTCFullYear(year!,month!-1,day!);
  if(!year||calendar.getUTCFullYear()!==year||calendar.getUTCMonth()!==month!-1||calendar.getUTCDate()!==day||hour!>23||minute!>59||second!>59)return false;
  let end: number;
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(event.starts_at)) {
    end = Date.parse(event.starts_at) + event.duration_hours * 3600000;
  } else {
    // Python adds duration in wall time before attaching ZoneInfo. Preserve
    // that order when the planned end crosses a DST transition.
    const wall = Date.parse(event.starts_at + 'Z') + event.duration_hours * 3600000;
    if (!Number.isFinite(wall)) return false;
    end = botMoment(new Date(wall).toISOString().slice(0, -1), event.timezone);
  }
  return Number.isFinite(end) && end <= now.getTime();
}
export function botCandidates(db: DB, command: string, now: Date): EventRow[] {
  const active = !BOT_FINANCE_COMMANDS.has(command) && !['往期', '待办', '管理', '再约'].includes(command);
  const phase = command === '往期' ? " AND lifecycle IN ('ended','cancelled')" : active ? " AND lifecycle IN ('scheduled','ongoing')" : '';
  const archive = command === '往期' ? '' : ' AND archived_at IS NULL';
  const order = BOT_FINANCE_COMMANDS.has(command) ? "CASE WHEN lifecycle IN ('ended','cancelled') THEN 0 ELSE 1 END,starts_at DESC" : "ABS(strftime('%s',starts_at)-strftime('%s',?)),id";
  const rows = db.prepare('SELECT * FROM events WHERE ' + publicSQL + phase + archive + ' ORDER BY ' + order)
    .iterate(...(BOT_FINANCE_COMMANDS.has(command) ? [] : [now.toISOString()]));
  const result: EventRow[] = [];
  for (const row of rows) {
    const event = row as EventRow;
    if (active && botEstimatedOver(event, now)) continue;
    result.push(event);
    if (result.length === 9) break;
  }
  return result;
}
export function currentBotEvent(db: DB, argument: string, command: PublicBotCommand, now: Date): EventRow | undefined {
  const rows = botCandidates(db, command, now);
  if (!argument) return rows.length === 1 ? rows[0] : undefined;
  if (/^[1-8]$/.test(argument)) {
    const event = rows.slice(0, 8)[Number(argument) - 1];
    if (!event) throw new BotSelectionError('序号 ' + argument + ' 不在本次清单（共 ' + Math.min(rows.length, 8) + ' 场）；请重新发送 /' + command + ' 查看最新序号。');
    return event;
  }
  if (!/^[a-fA-F0-9]{8,16}$/.test(argument)) throw new BotSelectionError('活动选择请用清单里的 1–8 序号，或 8–16 位活动短码；请重新选择活动。');
  const found = db.prepare('SELECT * FROM events WHERE id LIKE ? AND ' + publicSQL + ' LIMIT 2').all(argument.toLowerCase() + '%') as EventRow[];
  if (!found.length) throw new BotSelectionError('找不到可在本群查询的指定活动；请检查短码，并确认活动已发布且公开可见。');
  if (found.length > 1) throw new BotSelectionError('活动短码不唯一，请使用完整活动编号。');
  return found[0];
}
export function botPublicCounts(db: DB, id: string) {
  return db.prepare(`SELECT COALESCE(SUM(status='confirmed'),0) AS confirmed,COALESCE(SUM(status='waiting'),0) AS waiting,
    COALESCE(SUM(status='tentative'),0) AS tentative,
    COALESCE(SUM(confirmation_state='pending' AND status IN ('confirmed','waiting','tentative')),0) AS pending,
    COALESCE(SUM(confirmation_state='declined' AND status IN ('confirmed','waiting','tentative')),0) AS declined,
    COALESCE(SUM(withdrawal_requested!=0 AND status IN ('confirmed','waiting','tentative')),0) AS withdrawals
    FROM attendees WHERE event_id=?`).get(id) as {confirmed:number;waiting:number;tentative:number;pending:number;declined:number;withdrawals:number};
}
/** Only return public aggregate state; never expose the journal or payer data. */
export function botFinanceClosed(db: DB, event: EventRow) { return financeSummary(db, event, null).state === 'closed'; }
export function botPublicTasks(db: DB, event: EventRow, now: Date): string[] {
  const c = botPublicCounts(db, event.id), tasks: string[] = [];
  if (c.pending || c.declined) tasks.push(c.pending + ' 人待确认新安排，' + c.declined + ' 人暂不同意，请逐人协调');
  if (c.withdrawals) tasks.push('有退出申请，请有报名管理权限的人到站内处理');
  const active = ['scheduled', 'ongoing'].includes(event.lifecycle) && !event.archived_at;
  if (active && event.minimum_participants && event.formation_state !== 'confirmed' && (c.confirmed >= event.minimum_participants || botMoment(event.deadline, event.timezone) <= now.getTime())) tasks.push('请发起者决定是否成团；达到人数不代表已确认成团');
  if (active && botEstimatedOver(event, now)) tasks.push('已超过预计结束时间，请确认结束或延长');
  const bill = db.prepare('SELECT 1 FROM settlements WHERE event_id=?').get(event.id);
  if (['ended', 'cancelled'].includes(event.lifecycle) && !bill && !event.archived_at) tasks.push('请发起者核对出席、原约定并发布结算');
  if (bill && !botFinanceClosed(db, event)) tasks.push('结算已发布，收退款及账务结清状态请到站内核对');
  return tasks;
}
