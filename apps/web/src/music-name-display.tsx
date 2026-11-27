import { musicTranslation, type MusicNames } from '@qgroup/domain';
import { displayText, uiText } from './language';

type Entry={name:string;names?:MusicNames;translations?:{zhHant:string;zhHans:string};aliases?:readonly string[]};
export function MusicTranslation({entry}:{entry:Entry}) {
  const text=musicTranslation(entry,displayText('zh-Hans','zh-Hant') as 'zh-Hans'|'zh-Hant');
  return text?<small className="music-translation" lang={displayText('zh-Hans','zh-Hant')}>{text}</small>:null;
}
export function MusicNameDetails({entry}:{entry:Entry}) {
  const fields=entry.names?[ [uiText('繁中譯名'),entry.names.zhHant], [uiText('簡中譯名'),entry.names.zhHans], [uiText('英文名'),entry.names.english], [uiText('日文讀音'),entry.names.reading], [uiText('羅馬字'),entry.names.romaji] ]:[];
  const aliases=entry.names?.aliases??entry.aliases??[];
  return <>{fields.filter(([,value])=>!!value).map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}{aliases.length>0&&<div><dt>其他別名</dt><dd>{aliases.join('、')}</dd></div>}</>;
}
