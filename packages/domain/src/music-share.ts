export type ShareEntry = { id: string; name: string; kind: 'main' | 'sub'; count: number };
export type SharePick = ShareEntry & { level: number };
/** Both exports use the current draft order; grouping the image never reorders the copied list. */
export function musicSharePicks(selections: readonly { entryId: string; level: number }[], entries: readonly ShareEntry[]) {
  const map = new Map(entries.map(entry => [entry.id, entry]));
  return selections.flatMap(pick => {
    const entry = map.get(pick.entryId);
    return entry ? [{ id: entry.id, name: entry.name, kind: entry.kind, count: entry.count, level: pick.level }] : [];
  });
}
export const musicSelectionText = (picks: readonly SharePick[]) => picks.map(pick => pick.name).join('、');
/** Wrap graphemes instead of code units. Image truncation never changes the full text export. */
export function musicShareLines(text: string, maxWidth: number, maxLines: number, measure: (text: string) => number) {
  const units = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text.replace(/[\r\n\t]+/g, ' '))].map(part => part.segment);
  const lines: string[] = []; let line = '';
  for (let i = 0; i < units.length; i++) {
    const unit = units[i]!;
    if (measure(line + unit) <= maxWidth || !line) { line += unit; continue; }
    if (lines.length === maxLines - 1) {
      while (line && measure(line + '…') > maxWidth) line = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(line)].slice(0, -1).map(part => part.segment).join('');
      lines.push(line + '…'); return lines;
    }
    lines.push(line); line = unit;
  }
  if (line || !lines.length) lines.push(line);
  return lines;
}
