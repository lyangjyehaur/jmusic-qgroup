import { it, expect } from 'vitest';
import { activityDisplayTimeRange } from './activity-summary';

it('shows the complete same-day range immediately without repeating the date or default zone', () => {
  const text=activityDisplayTimeRange({startsAt:'2026-11-29T04:00:00Z',durationHours:5,timezone:'Asia/Shanghai'});
  expect(text).toContain('2026/11/29');expect(text).toContain('12:00–17:00');expect(text).toContain('5 小時');
  expect(text.match(/2026\/11\/29/g)).toHaveLength(1);expect(text).not.toMatch(/GMT|Asia/);
});
it('shows both dates and cross-day guidance across a year boundary', () => {
  const text=activityDisplayTimeRange({startsAt:'2026-12-31T15:00:00Z',durationHours:3,timezone:'Asia/Shanghai'});
  for(const value of ['2026/12/31','23:00','2027/01/01','02:00','跨日'])expect(text).toContain(value);
});
it('distinguishes repeated clocks at both ends of a compact DST range', () => {
  const text=activityDisplayTimeRange({startsAt:'2026-11-01T01:30:00-04:00',durationHours:1,timezone:'America/New_York'});
  expect(text.match(/01:30/g)).toHaveLength(2);expect(text).toContain('GMT-4');expect(text).toContain('GMT-5');
});
it('keeps uncertain saved time data explicit instead of inventing an end', () => {
  expect(activityDisplayTimeRange({startsAt:'2099-12-12T23:00:00+09:00',durationHours:null,timezone:'Asia/Tokyo'})).toContain('時長未定');
  const text=activityDisplayTimeRange({startsAt:'2099-12-12T23:00:00+09:00',durationHours:3,timezone:null});
  expect(text).toContain('23:00:00+09:00');expect(text).toContain('未指定時區');expect(text).not.toContain('–');
});
