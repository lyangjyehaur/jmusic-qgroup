import { TextField } from 'yahha-ui';
import { Button } from './kimi-ui';
import { uiText } from './language';
import type { MusicNames } from '@qgroup/domain';

export function MusicNameFields({names,disabled,change}:{names:MusicNames;disabled:boolean;change:(names:MusicNames)=>void}) {
  const fields=[['zhHant',uiText('繁中譯名')],['zhHans',uiText('簡中譯名')],['english',uiText('官方英文名')],['reading',uiText('日文讀音')],['romaji',uiText('羅馬字')]] as const;
  return <fieldset className="music-name-fields"><legend>名稱與檢索</legend>
    <div className="music-name-grid">{fields.map(([key,label])=><TextField key={key} label={label} value={names[key]} disabled={disabled} onChange={event=>change({...names,[key]:event.target.value})}/>)}</div>
    <p className="field-hint">簡繁僅字形不同時填一份即可；不同譯法可分別填寫。讀音請填假名，或直接填羅馬字。</p>
    <div className="music-alias-heading"><span>其他別名</span><Button variant="secondary" size="sm" disabled={disabled||names.aliases.length>=32} onClick={()=>change({...names,aliases:[...names.aliases,'']})}>新增別名</Button></div>
    <div className="music-alias-list">{names.aliases.map((alias,index)=><div className="music-alias-row" key={index}><TextField label={uiText('別名')+' '+(index+1)} value={alias} disabled={disabled} onChange={event=>change({...names,aliases:names.aliases.map((value,i)=>i===index?event.target.value:value)})}/><Button variant="ghost" aria-label={uiText('移除別名')+' '+(index+1)} disabled={disabled} onClick={()=>change({...names,aliases:names.aliases.filter((_,i)=>i!==index)})}>移除</Button></div>)}</div>
  </fieldset>;
}
