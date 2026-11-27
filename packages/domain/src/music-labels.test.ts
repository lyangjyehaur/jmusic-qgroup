import { describe,it,expect } from 'vitest';
import { emptyMusicNames,musicTranslation,musicNameAliases } from './music-labels';
import { createMusicSearchRank,matchesMusicSearch } from './music-search';
import { musicKanaRomaji } from './music-kana';
describe('structured term labels and multilingual search',()=>{
 it('chooses a distinct regional translation or converts only the supplied Chinese fallback without changing source',()=>{
  const entry={name:'ヨルシカ',names:{...emptyMusicNames(),zhHant:'夜鹿',zhHans:'月鹿'}};expect(musicTranslation(entry,'zh-Hans')).toBe('月鹿');expect(musicTranslation(entry,'zh-Hant')).toBe('夜鹿');
  entry.names.zhHans='';entry.names.zhHant='羊文學';expect(musicTranslation({...entry,translations:{zhHant:'羊文學',zhHans:'羊文学'}},'zh-Hans')).toBe('羊文学');expect(entry.names.zhHant).toBe('羊文學');expect(musicTranslation({name:'羊文學',names:entry.names},'zh-Hant')).toBe('');
 });
 it('searches explicit names, Chinese scripts, kana, Hepburn romanization, long vowels and separators; never guesses kanji readings',()=>{
  const entry={id:'e',name:'米津玄師',names:{...emptyMusicNames(),zhHant:'米津玄師',english:'Kenshi Yonezu',reading:'よねづ けんし',romaji:'Yonezu Kenshi',aliases:['ハチ']}};
  for(const q of ['米津玄师','Kenshi Yonezu','kenshiyonezu','YONEZU KENSHI','ヨネヅ','よねづ','hachi'])expect(matchesMusicSearch(entry,q),q).toBe(true);
  expect(matchesMusicSearch({id:'e',name:'米津玄師'},'kenshi')).toBe(false);
  for(const [name,query] of [['ヨルシカ','yorushika'],['トーキョー','tokyo'],['トーキョー','toukyou'],['キャット','kyatto'],['ずっと真夜中でいいのに。','zutto']] as const)expect(matchesMusicSearch({id:'e',name},query),query).toBe(true);
  expect(musicKanaRomaji('シェルター')).toBe('sherutaa');expect(matchesMusicSearch(entry,'/')).toBe(false);
 });
 it('prefers exact original and alias matches and deduplicates aliases without rewriting label fields',()=>{
  const entries=[{id:'popular',name:'Kenshi Yonezu fan club'},{id:'original',name:'Kenshi Yonezu'},{id:'alias',name:'米津玄師',aliases:['Kenshi Yonezu']}],rank=createMusicSearchRank(entries);
  expect([...entries].sort((a,b)=>rank(a.id,'Kenshi Yonezu')-rank(b.id,'Kenshi Yonezu')).map(e=>e.id)).toEqual(['original','alias','popular']);
  expect(musicNameAliases('YOASOBI',{...emptyMusicNames(),english:'Yoasobi',aliases:[' yoasobi ','夜遊','夜遊']})).toEqual(['夜遊']);
 });
});
