import type { DB } from '@qgroup/database';

// Source timestamps use float(value or 0), not JavaScript coercion or date parsing.
// Accept decimal Unicode digits and Python's between-digit underscores; reject hex,
// arrays and objects. Invalid imported values contribute zero instead of breaking reads.
export function musicTimestamp(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return Number(value);
  if (typeof value !== 'string') return 0;
  const text = value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '').replace(/\p{Decimal_Number}/gu, digit => {
    let point = digit.codePointAt(0)!;
    const end = point;
    while (point > 0 && /\p{Decimal_Number}/u.test(String.fromCodePoint(point - 1))) point--;
    return String((end - point) % 10);
  });
  if (/^[+-]?inf(?:inity)?$/i.test(text)) return text.startsWith('-') ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(text)) return NaN;
  const digits = '[0-9](?:_?[0-9])*';
  return new RegExp('^[+-]?(?:' + digits + '(?:\\.(?:' + digits + ')?)?|\\.' + digits + ')(?:[eE][+-]?' + digits + ')?$').test(text)
    ? Number(text.replaceAll('_', '')) : 0;
}
export function musicStats(db: DB, entryTimes: readonly string[], now: Date) {
  const asOf = now.getTime() / 1000, cutoff = asOf - 86400;
  const profiles = db.prepare(`SELECT l.fields_json,c.created_at
    FROM music_profiles p LEFT JOIN music_legacy_profiles l ON l.profile_id=p.id
    LEFT JOIN music_profile_creation c ON c.profile_id=p.id WHERE p.erased_at IS NULL`)
    .all() as { fields_json: string | null; created_at: string | null }[];
  return {
    members: profiles.length,
    entries: entryTimes.length,
    recentMembers24h: profiles.filter(p => (p.fields_json !== null
      ? musicTimestamp((JSON.parse(p.fields_json) as { createdAt?: unknown }).createdAt)
      : p.created_at ? Date.parse(p.created_at) / 1000 : 0) > cutoff).length,
    recentEntries24h: entryTimes.filter(time => musicTimestamp(JSON.parse(time)) > cutoff).length,
    asOf,
  };
}
