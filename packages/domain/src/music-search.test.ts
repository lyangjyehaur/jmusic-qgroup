import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { createMusicSearch, matchesMusicSearch, musicSearchKeys } from './music-search';

function original() {
  const script = readFileSync('music_site/public/app.js', 'utf8');
  const source = script.slice(script.indexOf('  const KANA_ROW ='), script.indexOf('  function hashId('));
  return runInNewContext(readFileSync('music_site/public/initials.js', 'utf8') + '\n' +
    readFileSync('music_site/public/pinyin.js', 'utf8') + '\n' + source + '\n({initialsOf,textPinyin,matchSearch})', { window: {} }) as {
    initialsOf: (text: string) => string; textPinyin: (text: string) => string;
    matchSearch: (text: string, query: string, aliases: string[]) => boolean;
  };
}
describe('shared native music search', () => {
  it('preserves the original initial and full-pinyin dictionary for every mapped character and kana row', () => {
    const old = original();
    for (let code = 0x4e00; code < 0xa000; code++) {
      const char = String.fromCodePoint(code), keys = musicSearchKeys(char);
      expect(keys.initials, char).toBe(old.initialsOf(char).toLowerCase());
      expect(keys.pinyin, char).toBe(old.textPinyin(char));
    }
    for (let code = 0x3041; code <= 0x30fa; code++) {
      const char = String.fromCodePoint(code);
      // NFKC intentionally expands compatibility kana and combining marks before searching.
      if (char.normalize('NFKC') === char) expect(musicSearchKeys(char).initials, char).toBe(old.initialsOf(char).toLowerCase());
    }
  });
  it('matches original name, alias, prefix initials, embedded pinyin and kana behavior across catalog candidates', () => {
    const old = original();
    const names = ['米津玄師', '宇多田光', '羊文學', '椎名林檎', '藤井風', '動畫歌曲', 'ヨルシカ', 'あいみょん', 'ずっと真夜中でいいのに。', 'ヴァンパイア', 'YOASOBI', 'BUMP OF CHICKEN'];
    const queries = ['', '米', 'MJXS', 'mijin', 'xuanshi', 'ytdg', 'yuwen', 'WRSK', 'am', '真夜', 'BV', 'YOA', 'bump', 'u田', '不存在', '玄師'];
    for (const name of names) for (const query of queries) {
      const aliases = ['別名樂團', 'alias'];
      expect(matchesMusicSearch({ id: 'e', name, aliases }, query), name + ':' + query).toBe(old.matchSearch(name, query, aliases));
    }
    expect(matchesMusicSearch({ id: 'e', name: '米津玄師' }, '津')).toBe(true);
    expect(matchesMusicSearch({ id: 'e', name: '米津玄師' }, 'jxs')).toBe(false);
    expect(matchesMusicSearch({ id: 'e', name: '米津玄師' }, 'jin')).toBe(true);
  });
  it('keeps normalized original text, aliases and per-entry indexes separate without changing content', () => {
    const entries = [{ id: 'a', name: 'Ｓtraße', aliases: ['米津玄師', 'Ａ　Ｂ'] }, { id: 'b', name: 'ﾖﾙｼｶ' }];
    const before = structuredClone(entries), match = createMusicSearch(entries);
    for (const query of ['STRASSE', 'stra\u200bsse', 'a b', 'ｍｊｘｓ', 'mijin']) expect(match('a', query)).toBe(true);
    expect(match('a', 'ab')).toBe(true); // Initials intentionally join letters across whitespace.
    expect(match('b', 'yrsk')).toBe(true);
    expect(match('missing', 'x')).toBe(false);
    expect(entries).toEqual(before);
  });
});
