import legacyCasefold from './legacy-casefold.json';
export * from './bot-markdown';
export * from './bot-templates';
export * from './bot-clock';
// Python's str.split()/re \s includes C0 separators and U+0085, but not BOM.
export const musicWhitespace = /[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g;
export const musicText = (value: string) => value.replace(musicWhitespace, ' ').replace(/^ +| +$/g, '');
export const pythonCasefold = (value: string) => Array.from(value, char => (legacyCasefold as Record<string, string>)[char] ?? char.toLowerCase()).join('');
/** Same NFKC, zero-width removal, whitespace removal and casefold as legacy name_key. */
export function musicNameKey(value: string) {
  const normalized = value.normalize('NFKC').replace(/[\u200b-\u200f\ufeff\u00ad]/g, '').replace(musicWhitespace, '');
  return Array.from(normalized, char => (legacyCasefold as Record<string, string>)[char] ?? char.toLowerCase()).join('');
}
/** Entry keys keep one separating space; member names remove all whitespace. */
export function musicEntryKey(value: string) {
  return pythonCasefold(musicText(value.normalize('NFKC').replace(/[\u200b-\u200f\ufeff\u00ad]/g, '')));
}
export class DomainError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); }
}

/** Store weights as thousandths; every calculation stays integer and exact. */
export function parseAmount(value: string): bigint {
  if (value.trim() !== value || !/^[0-9]{1,7}(?:\.[0-9]{1,2})?$/.test(value)) throw new DomainError('INVALID_AMOUNT', '金額最多七位整數、兩位小數，不能為負數');
  const [whole = '', decimal = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(decimal.padEnd(2, '0'));
}
export function parseWeight(value: string): bigint {
  if (value.trim() !== value || !/^[0-9]{1,4}(?:\.[0-9]{1,3})?$/.test(value)) throw new DomainError('INVALID_WEIGHT', '比例最多三位小數');
  const [whole = '', decimal = ''] = value.split('.');
  const weight = BigInt(whole) * 1000n + BigInt(decimal.padEnd(3, '0'));
  if (weight > 1000000n) throw new DomainError('INVALID_WEIGHT', '比例須為 0–1000');
  return weight;
}
/** Largest remainder; ties preserve frozen roster order, including negative items. */
export function splitCents(cents: bigint, weights: readonly bigint[]): bigint[] {
  if (weights.some(w => w < 0n)) throw new DomainError('INVALID_WEIGHT', '比例不能為負數');
  const total = weights.reduce((a, b) => a + b, 0n);
  if (total === 0n) {
    if (cents !== 0n) throw new DomainError('NO_PAYERS', '這項費用沒有有效分攤對象');
    return weights.map(() => 0n);
  }
  const absolute = cents < 0n ? -cents : cents;
  const result = weights.map(w => absolute * w / total);
  const order = weights.map((w, index) => ({ index, remainder: absolute * w % total }))
    .sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  const missing = Number(absolute - result.reduce((a, b) => a + b, 0n));
  for (const { index } of order.slice(0, missing)) result[index] = result[index]! + 1n;
  return result.map(v => cents < 0n ? -v : v);
}

export function validateSelections(selections: readonly { entryId: string; level: number }[], entries: readonly { id: string; kind: 'main' | 'sub' }[]) {
  const catalog = new Map(entries.map(e => [e.id, e]));
  let main = 0; let sub = 0;
  for (const selection of selections) {
    const entry = catalog.get(selection.entryId);
    if (!entry) throw new DomainError('UNKNOWN_ENTRY', '有詞條已不存在，請重新核對選擇');
    if (entry.kind === 'main') main++; else sub++;
  }
  if (main > 5 || sub > 15 || main + sub > 20) throw new DomainError('SELECTION_LIMIT', '大類最多 5 項、細項最多 15 項，合計最多 20 項');
}

export function activityState(event: { lifecycle: string; starts_at: string; deadline: string; duration_hours: number | null; archived_at: string | null; status: string; registration_open: number }, now: Date) {
  const start = Date.parse(event.starts_at);
  return {
    phase: event.lifecycle === 'scheduled' && start <= now.getTime() ? 'ongoing' : event.lifecycle,
    registrationOpen: event.lifecycle === 'scheduled' && !!event.registration_open && !event.archived_at && event.status === 'open' && Date.parse(event.deadline) > now.getTime() && start > now.getTime(),
    estimatedOver: ['scheduled', 'ongoing'].includes(event.lifecycle) && event.duration_hours !== null && start + event.duration_hours * 3600000 <= now.getTime(),
  };
}
