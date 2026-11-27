import { MusicNameDetails, MusicTranslation } from './music-name-display';
import { uiText } from './language';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Heading, Text } from 'yahha-ui';
import { Avatar, Button } from './kimi-ui';
import { MusicCatalog } from '@qgroup/contracts';
import type { z } from 'zod';
import { createWebHttpClient, scopedHttp } from './http';
import { Failure, Notice, PageIntro } from './shared';
import { MusicMemberAccess, type Member } from './member-access';
import { musicEntryTypeLabel } from './music-category';
import { useMusicWorkspace } from './music-selection';
import { KimiSelectionSummary } from './kimi-music-editor';
import { musicPeopleReturn, musicTrendReturn, musicCircleReturn } from './music-return';
import { CopyMusicValue } from './music-copy';
import { useDiscoveryDetails } from './discovery-details';
import { useContext, useState } from 'react';
import { DialogPageContext } from './discovery-dialog';

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

export function MusicEntryDetails({ entry }: {
  entry: z.infer<typeof MusicCatalog>['entries'][number];
}) {
  const workspace = useMusicWorkspace(), location = useLocation();
  const inDialog=useContext(DialogPageContext);
  useDiscoveryDetails(entry.name,musicEntryTypeLabel(entry));
  const selection = workspace.state === 'ready' ? workspace.selection : null;
  const detailPath = musicEntryPath(entry.id, location.search);
  return <section className="music-entry-detail" role="region" aria-label="詞條資料">
    {!inDialog&&<Heading level={2}>{entry.name}</Heading>}
    <MusicTranslation entry={entry}/><dl className="inline-definitions"><MusicNameDetails entry={entry}/><div><dt>選用人數</dt><dd>{entry.count} 人</dd></div>{entry.creatorName&&<div><dt>建立者</dt><dd>{entry.creatorName}</dd></div>}</dl>
    <div className="page-actions">
      {selection ? <Button aria-pressed={selection.selected.has(entry.id)} disabled={selection.locked}
        onClick={() => selection.toggle(entry)}>{selection.selected.has(entry.id) ? '調整喜歡程度' : '選取此詞條'}</Button>
        : <Link to={'/me/music' + location.search}>編輯我的選擇</Link>}
    </div>
    {workspace.state !== 'error' && <section aria-label="誰選了">
      <Heading level={3}>誰選了</Heading>
      {workspace.state === 'pending' ? <Notice>正在確認成分…</Notice> : <MusicMemberAccess purpose={uiText("查看選取者")}>{viewer => <EntryMembers
        key={viewer.scope + ':' + viewer.musicEpoch + ':' + entry.id} viewer={viewer} id={entry.id} returnTo={detailPath} />}</MusicMemberAccess>
      }
    </section>}
  </section>;
}
function EntryMembers({ viewer, id, returnTo }: { viewer: Member; id: string; returnTo: string }) {
  const [copyFeedback,setCopyFeedback]=useState<Record<string,string>>({});
  const query = useQuery({ queryKey: ['private', viewer.scope, 'music-entry-members', viewer.musicEpoch, id],
    queryFn: ({ signal }) => scopedHttp(viewer.scope).requestContract('GET /api/v2/music/entries/:id/members',
      { signal, params: { id } }), refetchOnMount: 'always' });
  if (query.isPending || !query.isFetchedAfterMount) return <Notice>正在讀取選取者…</Notice>;
  if (query.error) return <Failure error={query.error} retry={() => void query.refetch()} />;
  if (!query.data.members.length) return <Notice>尚無人選用此詞條。</Notice>;
  return <ul className="entry-selector-list">{query.data.members.map(member => <li key={member.id}>
    <Link className="entry-selector-identity" aria-label={member.name} to={'/people/' + encodeURIComponent(member.id) + '?' + new URLSearchParams({ from: returnTo })}><Avatar user={{name:member.name,avatar:member.name.slice(0,1),avatarUrl:member.avatarUrl,color:'var(--moss)'}} size="sm"/><span>{member.name}</span></Link>
    {member.contactQQ&&<Text>QQ {member.contactQQ}</Text>}
    <div className="page-actions entry-selector-copy">
      <CopyMusicValue key={member.name} value={member.name} label="名稱" compact onMessage={message=>setCopyFeedback(previous=>({...previous,[member.id]:message}))}/>
      {member.contactQQ&&<CopyMusicValue key={member.contactQQ} value={member.contactQQ} label="QQ" compact onMessage={message=>setCopyFeedback(previous=>({...previous,[member.id]:message}))}/>}
    </div>
    {copyFeedback[member.id]&&<p className="entry-selector-feedback" role="status">{copyFeedback[member.id]}</p>}
  </li>)}</ul>;
}
export function MusicEntryPage() {
  const { id = '' } = useParams(), [params] = useSearchParams(), workspace = useMusicWorkspace();
  const query = useQuery({ queryKey: ['music-catalog'], queryFn: () => createWebHttpClient().requestContract('GET /api/v2/music/catalog', {}) });
  const entry = query.data?.entries.find(value => value.id === id);
  const back = new URLSearchParams(params); back.delete('entry');
  const selection = workspace.state === 'ready' ? workspace.selection : null;
  const peopleBack = musicPeopleReturn(params.get('from'));
  const trendBack = musicTrendReturn(params.get('from'));
  return <><PageIntro title="詞條資料" /><div className="page-actions">{trendBack && <Link to={trendBack}>回到音樂趨勢</Link>}{peopleBack && <Link to={peopleBack}>{peopleBack.startsWith('/people/shouts') ? '回到找搭子' : musicCircleReturn(peopleBack) ? '回到同好圈子' : '回到同好成分'}</Link>}<Link to={'/music' + (back.size ? '?' + back : '')}>回到音樂詞庫</Link></div>
    {workspace.state === 'error' && !query.error && <Failure error={workspace.error} retry={workspace.retry} />}
    <div className="term-detail"><section className="term-detail-main">
      {query.isPending ? <Notice>正在讀取詞條…</Notice> : query.error ? <Failure error={query.error} retry={() => void query.refetch()} />
        : entry ? <MusicEntryDetails key={entry.id} entry={entry} /> : <Notice>這個詞條不存在或已刪除。</Notice>}
    </section>{selection && entry && <KimiSelectionSummary selection={selection} compact entryId={entry.id}/>}</div>
  </>;
}
