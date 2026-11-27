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
it('labels the next local calendar day in cards, including midnight and month/year boundaries', () => {
  for (const startsAt of ['2026-11-27T14:00:00Z', '2026-11-30T14:00:00Z', '2026-12-31T14:00:00Z']) {
    const text=activityDisplayTimeRange({startsAt,durationHours:4,timezone:'Asia/Shanghai'},'compact');
    expect(text).toContain('22:00–次日 02:00 · 4 小時');expect(text).not.toMatch(/GMT|跨日/);
  }
  expect(activityDisplayTimeRange({startsAt:'2026-11-27T14:00:00Z',durationHours:2,timezone:'Asia/Shanghai'},'compact')).toContain('22:00–次日 00:00 · 2 小時');
});
it('uses local calendar dates rather than elapsed hours for compact ranges, retaining DST offsets', () => {
  const sameDay=activityDisplayTimeRange({startsAt:'2026-11-01T00:00:00-04:00',durationHours:24,timezone:'America/New_York'},'compact');
  expect(sameDay).toContain('00:00（GMT-4）–23:00（GMT-5） · 24 小時');expect(sameDay).not.toContain('次日');
  const nextDay=activityDisplayTimeRange({startsAt:'2026-03-07T23:00:00-05:00',durationHours:4,timezone:'America/New_York'},'compact');
  expect(nextDay).toContain('23:00（GMT-5）–次日 04:00（GMT-4） · 4 小時');
});
it('shows the actual end date for a compact range spanning multiple calendar days', () => {
  const text=activityDisplayTimeRange({startsAt:'2026-12-31T14:00:00Z',durationHours:30,timezone:'Asia/Shanghai'},'compact');
  for(const value of ['2026/12/31','22:00','2027/01/02','04:00','30 小時'])expect(text).toContain(value);
  expect(text).not.toContain('次日');
});
