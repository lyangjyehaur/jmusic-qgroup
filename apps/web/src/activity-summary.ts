import { uiText, displayLocale } from './language';
import type { ActivityView } from '@qgroup/contracts';

const instant = (value: string) => /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
function formatter(zone: string | null, withOffset = true) {
  if (!zone) return null;
  try {
    return new Intl.DateTimeFormat(displayLocale(), { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zone, ...(withOffset ? { timeZoneName: 'shortOffset' as const } : {}) });
  } catch { return null; }
}
export function activityDate(value: string, zone: string | null) {
  const format = formatter(zone);
  return `${format && instant(value) ? format.format(new Date(value)) : value.replace('T', ' ')}（${zone || uiText('未指定時區')}）`;
}
/** On-screen dates omit the site's default UTC+8 offset; shared summaries remain explicit. */
export function activityDisplayDate(value: string, zone: string | null) {
  const format = formatter(zone);
  if (!format || !instant(value)) return activityDate(value, zone);
  const parts = format.formatToParts(new Date(value));
  const offset = parts.find(part => part.type === 'timeZoneName')?.value;
  const date = formatter(zone, false)!.format(new Date(value));
  return date + (offset && offset !== 'GMT+8' ? `（${offset}）` : '');
}
export function activityTimeRange(event: Pick<ActivityView, 'startsAt' | 'durationHours' | 'timezone'>) {
  const start = activityDate(event.startsAt, event.timezone), hours = event.durationHours;
  if (hours === null) return start + uiText(' · 時長未定');
  if (!Number.isFinite(hours) || hours <= 0 || !formatter(event.timezone) || !instant(event.startsAt)) return start + `${uiText(" · 持續 ")}${hours}${uiText(" 小時")}`;
  return start + ' — ' + activityDate(new Date(Date.parse(event.startsAt) + hours * 3600000).toISOString(), event.timezone);
}
export function activityShareURL(origin: string, id: string, share: { id: string; path: string; invitation: boolean }) {
  const base = '/activities/' + encodeURIComponent(id);
  const valid = share.invitation ? share.path.startsWith(base + '/access/') && /^[A-Za-z0-9_-]{32}$/.test(share.path.slice((base + '/access/').length)) : share.path === base;
  if (share.id !== id || !valid || new URL(origin).origin !== origin) throw Error('活動分享連結不符，請重新讀取。');
  return origin + share.path;
}
export function activitySummary(event: ActivityView, link: string, kind: 'activity' | 'conditions') {
  return [event.title,
    ...(kind === 'conditions' && event.changeSummary ? [event.changeSummary] : []),
    activityTimeRange(event), uiText('地點：') + event.location,
    ...(event.description ? [event.description] : []),
    ...(event.feePolicy ? [uiText('費用規則：') + event.feePolicy] : []),
    uiText('報名截止：') + activityDate(event.deadline, event.timezone),
    ...(event.withdrawalDeadline && event.withdrawalDeadline !== event.deadline ? [uiText('退出期限：') + activityDate(event.withdrawalDeadline, event.timezone)] : []),
    uiText('安排版本：') + event.conditionsVersion,
    ...(kind === 'activity' && event.changeSummary ? [uiText('本版變更：') + event.changeSummary] : []),
    ...(kind === 'conditions' ? [uiText('請開啟活動核對安排；原報名與原約定保留，變更需要逐人確認。')] : []),
    link,
  ].join('\n');
}
