/** Object key order is incidental; array order remains meaningful unless a caller models a set. */
export function sameDraftValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => sameDraftValue(value, b[i]));
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left).filter(key => left[key] !== undefined);
  return keys.length === Object.keys(right).filter(key => right[key] !== undefined).length && keys.every(key => sameDraftValue(left[key], right[key]));
}

export function sameMusicSelections(a: readonly { entryId: string; level: number }[], b: readonly { entryId: string; level: number }[]): boolean {
  const choices = new Map(b.map(choice => [choice.entryId, choice.level]));
  return a.length === b.length && choices.size === b.length && new Set(a.map(choice => choice.entryId)).size === a.length && a.every(choice => choices.get(choice.entryId) === choice.level);
}

export function normalizedRoomMembers<T extends { person_ids: string[] }>(rooms: T[] | undefined) {
  return rooms?.map(room => ({...room,person_ids:[...room.person_ids].sort()}));
}
