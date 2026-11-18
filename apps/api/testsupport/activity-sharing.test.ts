import { it, expect } from 'vitest';
import type { ActivityView } from '@qgroup/contracts';
import { activityDate, activityShareURL, activitySummary, activityTimeRange } from '../../web/src/activity-summary';
const event: ActivityView = { id: 'one', title: '原名 台灣音乐 <b>字</b>', category: '约K', location: '原地點 &keyword=其他 #地址', startsAt: '2099-12-12T23:00:00+09:00', deadline: '2099-12-11T23:00:00+09:00', durationHours: 3, timezone: 'Asia/Tokyo', description: '用戶原文\n第二行', capacity: 5, minimumParticipants: 0, lifecycle: 'scheduled', phase: 'scheduled', registrationOpen: true, estimatedOver: false, archived: false, confirmed: 1, waiting: 0, tentative: 0, feePolicy: '費用按原約定', withdrawalDeadline: '2099-12-12T20:00:00+09:00', conditionsVersion: 2, changeSummary: '更改地點', visibility: 'public' };
it('copies complete displayed activity values without transforming user content or adding private roster or finance values', () => {
  const text = activitySummary(event, 'https://fixture.example/activities/one', 'activity');
  for (const original of [event.title, event.location, event.description, event.feePolicy, '本版變更：更改地點', '安排版本：2', '報名截止：', '退出期限：']) expect(text).toContain(original);
  expect(text).toContain('2099/12/13'); expect(text).toContain('02:00'); expect(text).toContain('Asia/Tokyo');
  expect(text.split('\n').at(-1)).toBe('https://fixture.example/activities/one');
});
it('includes the current arrangement decision guidance and omits absent optional values without inventing data', () => {
  const text = activitySummary({ ...event, description: '', feePolicy: '', withdrawalDeadline: event.deadline }, 'link', 'conditions');
  expect(text).toContain('更改地點'); expect(text).toContain('原報名與原約定保留，變更需要逐人確認。');
  expect(text).not.toContain('本版變更：'); expect(text).not.toContain('費用規則：'); expect(text).not.toContain('退出期限：');
});
it('preserves ambiguous original wall times and missing or invalid zones rather than converting them with the device timezone', () => {
  expect(activityDate('2099-12-12T23:00:00', 'Asia/Tokyo')).toBe('2099-12-12 23:00:00（Asia/Tokyo）');
  expect(activityDate(event.startsAt, null)).toBe('2099-12-12 23:00:00+09:00（未指定時區）');
  expect(activityDate(event.startsAt, 'invalid/zone')).toBe('2099-12-12 23:00:00+09:00（invalid/zone）');
  expect(activityTimeRange({ ...event, timezone: null })).toContain('持續 3 小時');
  expect(activityTimeRange({ ...event, durationHours: null })).toContain('時長未定');
});
it('distinguishes repeated local hours across a DST transition and keeps the actual elapsed duration', () => {
  const text = activityTimeRange({ startsAt: '2026-11-01T01:30:00-04:00', durationHours: 1, timezone: 'America/New_York' });
  expect(text.match(/01:30/g)).toHaveLength(2); expect(text).toContain('GMT-4'); expect(text).toContain('GMT-5');
});
it('only accepts the matching canonical activity link or complete invitation link on the current origin', () => {
  const origin = 'https://fixture.example', id = 'has/slash', path = '/activities/has%2Fslash';
  expect(activityShareURL(origin, id, { id, path, invitation: false })).toBe(origin + path);
  expect(activityShareURL(origin, id, { id, path: path + '/access/' + 'a'.repeat(32), invitation: true })).toContain('/access/');
  for (const share of [{ id: 'other', path, invitation: false }, { id, path: '//external.example', invitation: false }, { id, path: path + '?secret=x', invitation: false }, { id, path: path + '/access/short', invitation: true }, { id, path: path + '/access/' + 'a'.repeat(32) + '/extra', invitation: true }]) expect(() => activityShareURL(origin, id, share)).toThrow();
});
