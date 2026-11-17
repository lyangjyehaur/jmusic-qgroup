import { musicEntryKey, musicWhitespace } from './music-text';

export function replaceMusicId(ids: readonly string[], source: string, target?: string) {
  return [...new Set(ids.flatMap(id => id === source ? target ? [target] : [] : [id]))];
}
export function mergeMusicSelections<T extends {entryId:string;level:number}>(items: readonly T[], source: string, target?: string) {
  const seen = new Set<string>();
  return items.flatMap(item => {
    const entryId = item.entryId === source ? target : item.entryId;
    if (!entryId || seen.has(entryId)) return [];
    seen.add(entryId); return [{entryId,level:item.level}];
  });
}
const trim = (value:string) => value.replace(new RegExp('^'+musicWhitespace.source+'|'+musicWhitespace.source+'$','g'),'');
export function mergeMusicAliases(target:{name:string;aliases:readonly string[]}, source:{name:string;aliases:readonly string[]}) {
  const aliases = target.aliases.filter(alias => !!trim(alias));
  const seen = new Set([musicEntryKey(target.name), ...aliases.map(musicEntryKey)]);
  for (const candidate of [source.name, ...source.aliases]) {
    const alias = trim(candidate), key = musicEntryKey(alias);
    if (alias && !seen.has(key)) { aliases.push(alias); seen.add(key); }
  }
  return aliases;
}
