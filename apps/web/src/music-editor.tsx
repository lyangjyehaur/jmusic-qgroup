import { uiText } from './language';
import { Link, useLocation } from 'react-router-dom';
import { Heading, Surface, Text } from 'yahha-ui';
import { Button, Select, Disclosure } from './kimi-ui';
import { categoryLabel } from './music-entries';
import type { MusicSelection } from './music-selection';
import { MusicSearch, useMusicSearch } from './music-search';
import { PageIntro } from './shared';

export function SelectionPanel({ selection: form }: { selection: MusicSelection }) {
  const location = useLocation();
  return <aside><Surface variant="note" className="aside-note" aria-label="我的選擇">
    <Heading level={2}>我的選擇 <small>{form.selected.size} / 20</small></Heading>
    <Text>領域 {form.mainCount}／5 · 細分 {form.subCount}／15</Text>
    {form.draft.selections.length ? <ul className="selected-list">{form.draft.selections.map(selected => {
      const entry = form.entries.find(entry => entry.id === selected.entryId);
      const name = entry?.name ?? uiText('已移除的詞條');
      return <li key={selected.entryId}><label><span>{name}</span>{entry?.kind === 'sub' &&
        <Select aria-label={name + '喜歡程度'} value={selected.level} disabled={form.locked} onChange={event => form.level(selected.entryId, Number(event.target.value))}>
          {[[4, uiText('本命')], [3, uiText('常聽')], [2, uiText('聽過一些')], [1, uiText('只聽過幾首')]].map(([value, label]) =>
            <option key={value} value={value}>{label}</option>)}
        </Select>}</label><Button variant="ghost" size="sm" aria-label={'移除' + name}
          disabled={form.locked} onClick={() => form.remove(selected.entryId)}>移除</Button></li>;
    })}</ul> : <Text tone="muted">請選擇詞條。</Text>}
    {form.dirty && <div className="editor-actions"><span className="mobile-summary" role="status">
      已選 {form.selected.size} / 20<small>{form.draft.requestKey ? '保存結果待確認' : '有未保存的選擇'}</small>
    </span><Button className="save" loading={form.sending} disabled={form.unavailable||form.needsRebase}
      onClick={() => void form.save()}>{form.draft.requestKey ? '確認保存結果' : '保存我的成分'}</Button></div>}
    {form.message && <p role="status" className="save-message">{form.message}</p>}
    {!form.draft.requestKey && form.dirty && <Button variant="ghost" disabled={form.locked}
      onClick={() => void form.rebase()}>核對最新版本，保留我的選擇</Button>}
    {(!form.message || form.dirty) && <Text size="sm" tone="muted">{form.dirty ? '尚有未保存的修改。' : form.saved ? '所有選擇已保存。' : '選擇後即可建立成分。'}</Text>}
    <div className="page-actions"><Link to={(location.pathname !== '/me/music' ? '/me/music' : '/music') + location.search}>
      {location.pathname !== '/me/music' ? '編輯我的成分' : '音樂詞庫'}</Link>
    <Link to={'/me/music/share' + location.search}>分享成分</Link></div>
  </Surface></aside>;
}
export function ProfileEditor({ selection: form }: { selection: MusicSelection }) {
  const filters = useMusicSearch(form.entries);
  const filtered = new Set(filters.filtered.map(entry => entry.id));
  const categories = [...new Set(form.entries.map(entry => entry.category))];
  return <div className="profile-editor"><PageIntro title="我的成分" /><nav className="tabs profile-tabs" aria-label="我的成分功能"><Link to="/me/music" aria-current="page">成分編輯</Link>
    <Link to="/me/music/entries">我的詞條</Link>{form.saved ? <>
      <Link to="/me/music/details">成分資料</Link><Link to="/me/music/contact">聯絡 QQ</Link>
      <Link to={'/people/' + form.saved.id}>查看我的成分卡</Link></> : <Link to="/me/music/recover">找回成分</Link>}
    </nav>{form.returnTo && <Link className="back" to={form.returnTo}>{form.returnTo.startsWith('/people/shouts') ? '回到找搭子' : form.returnTo.startsWith('/people/circles') ? '回到同好圈子' : form.returnTo.startsWith('/people') ? '回到同好成分' : form.returnTo.startsWith('/music/trends') ? '回到音樂趨勢' : '← 回到剛才的活動'}</Link>}
    <div className="content-columns music-editor"><section>
      <MusicSearch filters={filters} categories={categories} label="尋找喜歡的音樂" />
      {(['main', 'sub'] as const).map(kind => {
        const entries = form.entries.filter(entry => entry.kind === kind && filtered.has(entry.id));
        const groups = [...new Set(entries.map(entry => entry.category))];
        return <Surface className="selection-group" key={kind}><Heading level={2}>
          {kind === 'main' ? '領域' : '細分'} <small>{kind === 'main' ? `${form.mainCount} / 5` : `${form.subCount} / 15`}</small>
          </Heading>{groups.map(category => <Disclosure key={category} open className="music-category"  title={<>{categoryLabel(category)} · {entries.filter(entry => entry.category === category).length} 項</>}>

            <div className="choice-list">{entries.filter(entry => entry.category === category).map(entry =>
              <Button key={entry.id} variant={form.selected.has(entry.id) ? 'primary' : 'secondary'}
                aria-pressed={form.selected.has(entry.id)} disabled={form.locked}
                onClick={() => form.toggle(entry)}>{entry.name}</Button>)}</div>
          </Disclosure>)}{!entries.length && <Text tone="muted">{filters.search || filters.kind || filters.category ? '沒有符合的詞條。' : '詞庫尚無詞條。'}</Text>}
        </Surface>;
      })}
    </section><SelectionPanel selection={form} /></div></div>;
}
