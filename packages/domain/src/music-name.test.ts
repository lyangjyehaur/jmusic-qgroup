import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import exceptions from './legacy-casefold.json';
import { musicNameKey, musicText } from './index';
describe('legacy Unicode music text', () => {
  it('matches the original Python name_key for every legacy casefold exception and compatibility/whitespace combinations', () => {
    const samples = ['', 'Ｓtraße', 'stras\u200bse', 'ςΣσ', 'İıI', 'ﬃ', '\u00ad\ufeff', 'A\u001c B\u0085C', '中文　稱呼', 'ＡＢＣ', '🟢音樂'];
    for (const char of Object.keys(exceptions)) samples.push(char, 'Ａ\u200b' + char + '\u0085Ｚ');
    const expected = JSON.parse(execFileSync('python3', ['-c', 'import json,sys;from music_site.upstream import name_key;print(json.dumps([name_key(s) for s in json.load(sys.stdin)]))'], { input: JSON.stringify(samples), encoding:'utf8' }));
    expect(samples.map(musicNameKey)).toEqual(expected);
  });
  it('normalizes only Python whitespace without truncating or dropping meaningful codepoints', () => {
    const samples = Array.from({length: 0x3100}, (_,i) => String.fromCharCode(i)).filter(char => /\s/.test(char) || /[\u001c-\u001f\u0085]/.test(char)).map(char => char + '私' + char + char + '人' + char);
    samples.push('\ufeff私人\ufeff', '🟢'.repeat(141));
    const expected = JSON.parse(execFileSync('python3', ['-c', 'import json,sys;print(json.dumps([" ".join(s.split()) for s in json.load(sys.stdin)]))'], { input:JSON.stringify(samples),encoding:'utf8' }));
    expect(samples.map(musicText)).toEqual(expected);
  });
});
