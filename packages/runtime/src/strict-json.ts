import { createHash } from 'node:crypto';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ObjectValue = { [key: string]: Json };
export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const sourceKeys = new WeakMap<object, readonly string[]>();
/** JSON object discovery order differs from JS enumeration for numeric keys. */
export function jsonObjectKeys(value: object): string[] {
  const original = sourceKeys.get(value) ?? [];
  const present = Object.keys(value);
  return [...original.filter(key => Object.hasOwn(value, key)), ...present.filter(key => !original.includes(key))];
}
/** Build a JSON dictionary whose discovery order survives numeric keys. */
export function jsonObjectFromEntries<T>(pairs: Iterable<readonly [string, T]>): Record<string, T> {
  const entries = [...pairs], result = Object.fromEntries(entries);
  sourceKeys.set(result, [...new Set(entries.map(([key]) => key))]);
  return result;
}
/** Serialize plain JSON data in recorded discovery order. Normal JSON.stringify
 * remains unchanged for contracts and canonical hashes that intentionally sort. */
export function stringifyJson(value: unknown, spaces = 0): string {
  const indent = ' '.repeat(Math.max(0, Math.min(10, Math.trunc(spaces))));
  const seen = new Set<object>();
  function encode(node: unknown, depth: number): string | undefined {
    if (!node || typeof node !== 'object') return JSON.stringify(node);
    if (seen.has(node)) throw new TypeError('Circular JSON data');
    seen.add(node);
    try {
      const array = Array.isArray(node), items: string[] = [];
      if (array) for (const item of node) items.push(encode(item, depth + 1) ?? 'null');
      else for (const key of jsonObjectKeys(node)) {
        const item = encode((node as Record<string, unknown>)[key], depth + 1);
        if (item !== undefined) items.push(JSON.stringify(key) + (indent ? ': ' : ':') + item);
      }
      const [open, close] = array ? ['[', ']'] : ['{', '}'];
      if (!items.length) return open! + close!;
      return indent ? open + '\n' + indent.repeat(depth + 1) + items.join(',\n' + indent.repeat(depth + 1)) + '\n' + indent.repeat(depth) + close : open + items.join(',') + close;
    } finally { seen.delete(node); }
  }
  const result = encode(value, 0);
  if (result === undefined) throw new TypeError('Missing JSON data');
  return result;
}
/** Reject ambiguous JSON and unsafe numeric conversion before accepting any source. */
export function parseJson(source: string): Json {
  const parsed: Json = JSON.parse(source); let cursor = 0;
  function space() { while (/\s/.test(source[cursor] ?? '') && cursor < source.length) cursor++; }
  function string() { const start = cursor++; while (cursor < source.length) { const char = source[cursor++]!; if (char === '\\') cursor++; else if (char === '"') return JSON.parse(source.slice(start, cursor)) as string; } throw new Error('Incomplete JSON string'); }
  function value(node: Json): void {
    space(); const char = source[cursor];
    if (char === '{') {
      cursor++; space(); const seen = new Set<string>();
      while (source[cursor] !== '}') { const key = string(); if (seen.has(key)) throw new Error('Duplicate JSON object key'); seen.add(key); space(); cursor++; value((node as ObjectValue)[key]!); space(); if (source[cursor] !== ',') break; cursor++; space(); }
      sourceKeys.set(node as ObjectValue, [...seen]); cursor++; return;
    }
    if (char === '[') { cursor++; space(); let index = 0; while (source[cursor] !== ']') { value((node as Json[])[index++]!); space(); if (source[cursor] !== ',') break; cursor++; } cursor++; return; }
    if (char === '"') { string(); return; }
    const start = cursor; while (cursor < source.length && !/[\s,}\]]/.test(source[cursor]!)) cursor++;
    const token = source.slice(start, cursor); const number = Number(token);
    if (token !== 'null' && token !== 'true' && token !== 'false' && (!Number.isFinite(number) || Math.abs(number) > Number.MAX_SAFE_INTEGER)) throw new Error('Unsafe JSON number');
  }
  value(parsed); return parsed;
}
