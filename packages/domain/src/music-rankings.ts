export type RankedMusic = { id: string; name: string; count: number; kind: 'main' | 'sub' };
/** The source display explicitly re-sorts the Python payload with Chinese collation. */
export function rankMusic<T extends RankedMusic>(entries: readonly T[]) {
  return [...entries].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh') || a.id.localeCompare(b.id));
}
export function musicRankLimit(kind: 'main' | 'sub', expanded: boolean, complete: boolean) {
  return complete ? Infinity : !expanded ? 10 : kind === 'main' ? Infinity : 20;
}
/** Deterministic shelf packing keeps every term readable instead of hiding overflow. */
export function musicBubbleLayout<T extends RankedMusic>(entries: readonly T[], availableWidth: number) {
  const width = Math.max(40, availableWidth), pad = 8, gap = 12;
  const max = entries.reduce((maximum, entry) => Math.max(maximum, entry.count), 1);
  const circles = entries.map(entry => ({ entry, radius: Math.min((width - 2 * pad) / 2, 42 + 38 * Math.sqrt(entry.count / max)), x: 0, y: 0 }));
  let y = pad, row: typeof circles = [], used = 0;
  const flush = () => {
    if (!row.length) return;
    const radius = Math.max(...row.map(circle => circle.radius));
    let x = (width - used) / 2;
    for (const circle of row) { circle.x = x + circle.radius; circle.y = y + radius; x += 2 * circle.radius + gap; }
    y += radius * 2 + gap; row = []; used = 0;
  };
  for (const circle of circles) {
    const diameter = circle.radius * 2;
    if (row.length && used + gap + diameter > width - 2 * pad) flush();
    used += (row.length ? gap : 0) + diameter; row.push(circle);
  }
  flush();
  return { width, height: entries.length ? y - gap + pad : 0, circles };
}
const graphemes = new Intl.Segmenter('zh', { granularity: 'grapheme' });
/** Full names remain in the link label/title; visible text is bounded to three lines. */
export function musicBubbleLabel(name: string, radius: number) {
  const pieces = Array.from(graphemes.segment(name), segment => segment.segment);
  const width = Math.max(26, radius * 1.5);
  const measure = (piece: string) => /^[\p{Script=Latin}0-9\s.,:;!?&()'’+-]/u.test(piece) ? 7.15 : 13;
  const lines: string[] = [];
  let start = 0;
  while (start < pieces.length && lines.length < 3) {
    let end = start, used = 0, space = -1;
    while (end < pieces.length && used + measure(pieces[end]!) <= width) {
      used += measure(pieces[end]!);
      if (/^\s$/u.test(pieces[end]!)) space = end;
      end++;
    }
    end = Math.max(start + 1, end);
    if (end < pieces.length && space > start) end = space;
    const line = pieces.slice(start, end);
    if (lines.length === 2 && end < pieces.length) {
      while (line.length && line.reduce((sum, piece) => sum + measure(piece), 13) > width) line.pop();
      line.push('…');
    }
    lines.push(line.join('').trim()); start = end;
    while (start < pieces.length && /^\s$/u.test(pieces[start]!)) start++;
  }
  return lines;
}
