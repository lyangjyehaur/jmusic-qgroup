import { createHash } from 'node:crypto';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ObjectValue = { [key: string]: Json };
export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
/** Reject ambiguous JSON and unsafe numeric conversion before accepting any source. */
export function parseJson(source: string): Json {
  const parsed: Json = JSON.parse(source); let cursor = 0;
  function space() { while (/\s/.test(source[cursor] ?? '') && cursor < source.length) cursor++; }
  function string() { const start = cursor++; while (cursor < source.length) { const char = source[cursor++]!; if (char === '\\') cursor++; else if (char === '"') return JSON.parse(source.slice(start, cursor)) as string; } throw new Error('Incomplete JSON string'); }
  function value(): void {
    space(); const char = source[cursor];
    if (char === '{') {
      cursor++; space(); const seen = new Set<string>();
      while (source[cursor] !== '}') { const key = string(); if (seen.has(key)) throw new Error('Duplicate JSON object key'); seen.add(key); space(); cursor++; value(); space(); if (source[cursor] !== ',') break; cursor++; space(); }
      cursor++; return;
    }
    if (char === '[') { cursor++; space(); while (source[cursor] !== ']') { value(); space(); if (source[cursor] !== ',') break; cursor++; } cursor++; return; }
    if (char === '"') { string(); return; }
    const start = cursor; while (cursor < source.length && !/[\s,}\]]/.test(source[cursor]!)) cursor++;
    const token = source.slice(start, cursor); const number = Number(token);
    if (token !== 'null' && token !== 'true' && token !== 'false' && (!Number.isFinite(number) || Math.abs(number) > Number.MAX_SAFE_INTEGER)) throw new Error('Unsafe JSON number');
  }
  value(); return parsed;
}
