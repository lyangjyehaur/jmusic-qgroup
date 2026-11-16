import type { wallDate as WallDate, wallToISO as WallToISO } from "./domain.ts";
type Slot = { date: string; time: string };
export function pollAddDays(day: string, offset: number) {
  const date = new Date(day + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}
export function pollMonthDays(month: string) {
  const first = new Date(month + "-01T12:00:00Z");
  if (!/^\d{4}-\d{2}$/.test(month) || !Number.isFinite(first.getTime()))
    throw new Error("请选择有效月份");
  const end = new Date(first);
  end.setUTCMonth(end.getUTCMonth() + 1);
  end.setUTCDate(0);
  return {
    offset: (first.getUTCDay() + 6) % 7,
    days: Array.from(
      { length: end.getUTCDate() },
      (_, i) => month + "-" + String(i + 1).padStart(2, "0"),
    ),
  };
}
export function pollShiftMonth(month: string, offset: number) {
  const date = new Date(month + "-01T12:00:00Z");
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 7);
}
export function pollToggleCalendarDate<T extends Slot>(
  slots: T[],
  day: string,
  makeSlot: () => T,
) {
  let next;
  if (slots.some((s) => s.date === day))
    next = slots.filter((s) => s.date !== day);
  else {
    next = slots.map((s) => ({ ...s }));
    const empty = next.find((s) => !s.date);
    if (empty) empty.date = day;
    else next.push({ ...makeSlot(), date: day });
  }
  while (next.length < 2) next.push(makeSlot());
  return next.sort(
    (a, b) => Number(!a.date) - Number(!b.date) || a.date.localeCompare(b.date),
  );
}
export function pollDeadlineBounds(
  slots: Slot[],
  exact: boolean,
  zone: string,
  wallDate: typeof WallDate,
  wallToISO: typeof WallToISO,
  now = Date.now(),
) {
  const filled = slots.filter((slot) => slot.date);
  if (!filled.length) return null;
  const end = filled.reduce(
    (latest, slot) =>
      Math.max(
        latest,
        Date.parse(
          wallToISO(
            (exact ? slot.date : pollAddDays(slot.date, 1)) +
              "T" +
              (exact ? slot.time : "00:00"),
            zone,
          ),
        ),
      ),
    -Infinity,
  );
  const latest = end - 60000;
  const suggested = exact
    ? Math.min(
        latest,
        Math.max(Math.ceil((now + 1) / 60000) * 60000, end - 3600000),
      )
    : latest;
  return {
    end,
    latest: wallDate(latest, zone),
    suggested: suggested > now ? wallDate(suggested, zone) : "",
  };
}
export function pollDeadlineValue(
  day: string,
  time: string,
  exact: boolean,
  zone: string,
  bounds: ReturnType<typeof pollDeadlineBounds>,
  wallToISO: typeof WallToISO,
  now = Date.now(),
) {
  const value = wallToISO(day + "T" + (exact ? time : "23:59"), zone);
  if (Date.parse(value) <= now)
    throw new Error("投票截止时间已过，请选择晚于现在的时间");
  if (bounds && Date.parse(value) >= bounds.end)
    throw new Error(
      exact
        ? "投票截止需早于最后一个候选的开始时间，最晚可选 " +
            bounds.latest.replace("T", " ") +
            "（" +
            zone +
            "）"
        : "日期投票于所选截止日 23:59 结束，截止日期最晚可选 " +
            bounds.latest.slice(0, 10) +
            "（" +
            zone +
            "）",
    );
  return value;
}
