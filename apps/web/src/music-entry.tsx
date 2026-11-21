import { uiText } from './language';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button, Heading, Surface, Text } from 'yahha-ui';
import { MusicCatalog, MusicEntryMembers } from '@qgroup/contracts';
import type { z } from 'zod';
import { createWebHttpClient, scopedHttp } from './http';
import { Failure, Notice, PageIntro } from './shared';
import { MusicMemberAccess, type Member } from './member-access';
import { categoryLabel } from './music-entries';
import { useMusicWorkspace } from './music-selection';
import { SelectionPanel } from './music-editor';
import { musicPeopleReturn, musicTrendReturn, musicCircleReturn } from './music-return';
import { CopyMusicValue } from './music-copy';

export function musicEntryPath(id: string, search = '') {
  const params = new URLSearchParams(search);
  params.delete('entry');
  const query = params.toString();
  return '/music/entries/' + encodeURIComponent(id) + (query ? '?' + query : '');
}
// A profile can return only to a local term page, never to a caller-supplied external URL.
export function musicEntryReturn(value: string | null) {
  if (!value || !/^\/music\/entries\/[^/?#]+(?:\?[^#]*)?$/.test(value)) return null;
  const url = new URL(value, 'https://local.invalid');
  return url.pathname + url.search === value ? value : null;
}

export function MusicEntryDetails({ entry, close }: {
  entry: z.infer<typeof MusicCatalog>['entries'][number]; close?: () => void;
}) {
  const workspace = useMusicWorkspace(), location = useLocation();
  const selection = workspace.state === 'ready' ? workspace.selection : null;
  const detailPath = musicEntryPath(entry.id, location.search);
  return <Surface className="detail music-entry-detail" role="region" aria-label="詞條資料">
    <Heading level={2}>{entry.name}</Heading>
    <Text>{entry.kind === 'main' ? '領域' : '細分'} · {categoryLabel(entry.category)} · {entry.count} 人選用</Text>
    {entry.aliases.length > 0 && <Text>別名：{entry.aliases.join('、')}</Text>}
    {entry.creatorName && <Text>建立者：{entry.creatorName}</Text>}
    <div className="page-actions">
      {selection ? <Button aria-pressed={selection.selected.has(entry.id)} disabled={selection.locked}
        onClick={() => selection.toggle(entry)}>{selection.selected.has(entry.id) ? '取消選取' : '選取此詞條'}</Button>
        : <Link to={'/me/music' + location.search}>編輯我的選擇</Link>}
      {close && <><Link to={detailPath}>開啟詞條頁面</Link>
        <Button variant="ghost" onClick={close}>關閉詞條資料</Button></>}
    </div>
    {workspace.state !== 'error' && <section aria-label="誰選了">
      <Heading level={3}>誰選了</Heading>
      {workspace.state === 'pending' ? <Notice>正在確認成分…</Notice> : <MusicMemberAccess purpose={uiText("查看選取者")}>{viewer => <EntryMembers
        key={viewer.scope + ':' + viewer.musicEpoch + ':' + entry.id} viewer={viewer} id={entry.id} returnTo={detailPath} />}</MusicMemberAccess>
      }
    </section>}
  </Surface>;
}
function EntryMembers({ viewer, id, returnTo }: { viewer: Member; id: string; returnTo: string }) {
  const query = useQuery({ queryKey: ['private', viewer.scope, 'music-entry-members', viewer.musicEpoch, id],
    queryFn: ({ signal }) => scopedHttp(viewer.scope).request('GET /api/v2/music/entries/:id/members',
      { signal, params: { id } }, MusicEntryMembers), refetchOnMount: 'always' });
  if (query.isPending || !query.isFetchedAfterMount) return <Notice>正在讀取選取者…</Notice>;
  if (query.error) return <Failure error={query.error} retry={() => void query.refetch()} />;
  if (!query.data.members.length) return <Notice>尚無人選用此詞條。</Notice>;
  return <ul className="music-entry-members">{query.data.members.map(member => <li key={member.id}>
    <Link to={'/people/' + encodeURIComponent(member.id) + '?' + new URLSearchParams({ from: returnTo })}>{member.name}</Link>
    <Text>{member.contactQQ ? member.contactQQ + ' · ' + (member.contactSource === 'legacy' ? '舊成分查詢號碼' : '自填號碼') + '，未經騰訊驗證'
      : '固定成分 ID：' + member.id}</Text>
    <div className="page-actions">
      <CopyMusicValue key={member.name} value={member.name} label="名稱" />
      <CopyMusicValue key={member.contactQQ || member.id} value={member.contactQQ || member.id} label={member.contactQQ ? '聯絡 QQ' : '成分 ID'} />
    </div>
  </li>)}</ul>;
}
export function MusicEntryPage() {
  const { id = '' } = useParams(), [params] = useSearchParams(), workspace = useMusicWorkspace();
  const query = useQuery({ queryKey: ['music-catalog'], queryFn: () => createWebHttpClient().request('GET /api/v2/music/catalog', {}, MusicCatalog) });
  const entry = query.data?.entries.find(value => value.id === id);
  const back = new URLSearchParams(params); back.delete('entry');
  const selection = workspace.state === 'ready' ? workspace.selection : null;
  const peopleBack = musicPeopleReturn(params.get('from'));
  const trendBack = musicTrendReturn(params.get('from'));
  return <><PageIntro title="詞條資料" /><div className="page-actions">{trendBack && <Link to={trendBack}>回到音樂趨勢</Link>}{peopleBack && <Link to={peopleBack}>{peopleBack.startsWith('/people/shouts') ? '回到找搭子' : musicCircleReturn(peopleBack) ? '回到同好圈子' : '回到同好成分'}</Link>}<Link to={'/music' + (back.size ? '?' + back : '')}>回到音樂詞庫</Link></div>
    {workspace.state === 'error' && !query.error && <Failure error={workspace.error} retry={workspace.retry} />}
    <div className={selection ? 'content-columns music-editor' : undefined}><section>
      {query.isPending ? <Notice>正在讀取詞條…</Notice> : query.error ? <Failure error={query.error} retry={() => void query.refetch()} />
        : entry ? <MusicEntryDetails key={entry.id} entry={entry} /> : <Notice>這個詞條不存在或已刪除。</Notice>}
    </section>{selection && <SelectionPanel selection={selection} />}</div>
  </>;
}
