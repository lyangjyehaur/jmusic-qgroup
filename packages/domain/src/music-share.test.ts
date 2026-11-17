import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, it, expect } from 'vitest';
import { musicSharePicks, musicSelectionText, musicShareLines } from './music-share';
const entries = Array.from({ length: 22 }, (_, i) => ({ id: 'e' + i, name: ['音樂', '𠀀', '👩🏽‍🎤', 'Aimer', 'ヨルシカ'][i % 5]! + i, kind: i < 6 ? 'main' as const : 'sub' as const, count: i }));
describe('music sharing data and text', () => {
  it('copies exactly the source selection order and separator, including unknown-term filtering and unsaved choices', () => {
    const source = readFileSync(new URL('../../../music_site/public/app.js', import.meta.url), 'utf8');
    const start = source.indexOf('  function copySelection()'), end = source.indexOf('  function showUpdateBanner()', start);
    for (let size = 1; size <= 20; size++) {
      const selections = [...entries].reverse().slice(0, size).map((entry, i) => ({ entryId: entry.id, level: i % 4 + 1 }));
      selections.splice(1, 0, { entryId: 'removed', level: 3 }); let expected = '';
      runInNewContext('(' + source.slice(start, end).trim() + ')()', {
        previewMode: false, selectedIds: () => new Set(selections.map(pick => pick.entryId)), state: { entries: entries.map(entry => ({ ...entry, text: entry.name })) },
        copyText: (value: string) => { expected = value; }, toast: () => { throw new Error('Unexpected source rejection'); },
      });
      const result = musicSharePicks(selections, entries); expect(musicSelectionText(result)).toBe(expected);
      expect(result.map(pick => pick.level)).toEqual(selections.filter(pick => pick.entryId !== 'removed').map(pick => pick.level));
    }
    expect(musicSelectionText(musicSharePicks([], entries))).toBe('');
  });
  it('exports only whitelisted term fields and keeps full long names outside the image truncation', () => {
    const name = '👩🏽‍🎤' + '完整名稱'.repeat(4000), selections = [{ entryId: 'x', level: 4, token: 'private' }], extra = [{ id: 'x', name, kind: 'sub' as const, count: 3, note: 'private', gender: 'hidden' }];
    const result = musicSharePicks(selections, extra);
    expect(Object.keys(result[0]!).sort()).toEqual(['count', 'id', 'kind', 'level', 'name']); expect(musicSelectionText(result)).toBe(name);
    const lines = musicShareLines(name, 10, 3, value => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].length);
    expect(lines).toHaveLength(3); expect(lines[2]!.endsWith('…')).toBe(true);
    expect(lines.every(line => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(line)].length <= 10)).toBe(true);
  });
  it('wraps whole graphemes, respects line budgets and normalizes source line breaks for the image only', () => {
    const cluster = '👩🏽‍🎤', measure = (value: string) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].length;
    expect(musicShareLines(cluster.repeat(12), 4, 2, measure)).toEqual([cluster.repeat(4), cluster.repeat(3) + '…']);
    expect(musicShareLines('A\nB\tC', 20, 2, measure)).toEqual(['A B C']);
    expect(musicShareLines('𠀀éヨルシカ', 3, 3, measure).join('')).toBe('𠀀éヨルシカ');
    expect(musicShareLines('', 10, 2, measure)).toEqual(['']);
  });
});
