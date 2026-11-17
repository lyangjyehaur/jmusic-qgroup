import { useId, useState } from 'react';
import { Button, Text } from 'yahha-ui';
function todayInZone(zone: string) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    return null;
  }
}
function shifted(month: string, delta: number) {
  const date = new Date(month + '-01T12:00:00Z');
  date.setUTCMonth(date.getUTCMonth() + delta);
  return date.toISOString().slice(0, 7);
}
/** A persistent month view permits non-contiguous dates across months without resetting earlier choices. */
export function PollCalendar({
  zone,
  values,
  change,
}: {
  zone: string;
  values: string[];
  change: (values: string[]) => void;
}) {
  const today = todayInZone(zone),
    heading = useId(),
    [month, setMonth] = useState(
      () =>
        values.find((v) => /^\d{4}-\d{2}-\d{2}$/.test(v))?.slice(0, 7) ??
        today?.slice(0, 7) ??
        new Date().toISOString().slice(0, 7),
    );
  if (!today) return <Text role="status">請先填寫有效時區，再使用月曆。</Text>;
  const year = Number(month.slice(0, 4)),
    index = Number(month.slice(5)),
    date = new Date(month + '-01T12:00:00Z');
  if (!Number.isFinite(date.getTime()) || year < 1 || year > 9999 || index < 1 || index > 12) return null;
  const count = new Date(Date.UTC(year === 0 ? 400 : year, index, 0)).getUTCDate(),
    selected = new Set(values.filter(Boolean));
  function toggle(day: string) {
    let next = selected.has(day) ? values.filter((v) => v !== day) : [...values];
    if (!selected.has(day)) {
      const empty = next.indexOf('');
      if (empty < 0) next.push(day);
      else next[empty] = day;
    }
    while (next.length < 2) next.push('');
    change(next);
  }
  return (
    <section className="poll-calendar" aria-labelledby={heading}>
      <Text id={heading}>選擇候選日期</Text>
      <div className="poll-month-navigation">
        <Button variant="ghost" disabled={month <= today.slice(0, 7)} onClick={() => setMonth(shifted(month, -1))}>
          上個月
        </Button>
        <label>
          月份
          <input
            aria-label="月曆月份"
            type="month"
            min={today.slice(0, 7)}
            value={month}
            onChange={(e) => {
              if (/^\d{4}-\d{2}$/.test(e.target.value)) setMonth(e.target.value);
            }}
          />
        </label>
        <Button variant="ghost" disabled={month === '9999-12'} onClick={() => setMonth(shifted(month, 1))}>
          下個月
        </Button>
        <Button variant="ghost" onClick={() => setMonth(today.slice(0, 7))}>
          本月
        </Button>
      </div>
      <div className="poll-calendar-days">
        {['日', '一', '二', '三', '四', '五', '六'].map((day) => (
          <span aria-hidden="true" key={day}>
            {day}
          </span>
        ))}
        {Array.from({ length: date.getUTCDay() }, (_, i) => (
          <span key={'gap:' + i} aria-hidden="true" />
        ))}
        {Array.from({ length: count }, (_, i) => {
          const day = month + '-' + String(i + 1).padStart(2, '0');
          return (
            <button
              type="button"
              key={day}
              aria-label={'選擇日期 ' + day}
              aria-pressed={selected.has(day)}
              aria-current={day === today ? 'date' : undefined}
              disabled={day < today && !selected.has(day)}
              onClick={() => toggle(day)}
            >
              {i + 1}
            </button>
          );
        })}
      </div>
      <Text role="status">已選 {selected.size} 個日期</Text>
    </section>
  );
}
