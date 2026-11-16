import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { EmptyState, Heading, Surface, Text, TextField } from 'yahha-ui';
import { Catalog } from '@qgroup/contracts';
import { api } from './api';
import { Failure, Notice, PageIntro } from './shared';
export function Music() {
  const [search, setSearch] = useState('');
  const query = useQuery({ queryKey: ['catalog'], queryFn: () => api('/music/entries', Catalog) });
  const entries = query.data?.entries.filter(e => e.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) ?? [];
  return <><PageIntro eyebrow="YOUR MUSIC, OUR CONNECTION" title="從一首歌，找到共鳴。">看看大家的音樂詞條，再把喜歡的留在自己的成分裡。</PageIntro><div className="content-columns"><section>
    <TextField label="搜尋音樂詞條" type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="風格、歌手、樂團…" />
    {query.isPending ? <Notice>正在讀取詞條…</Notice> : query.error ? <Failure error={query.error} retry={() => void query.refetch()} /> : <Surface className="library"><Heading level={2}>音樂詞庫</Heading>{entries.length ? <div className="entry-list">{entries.map(e => <span className="entry" key={e.id}><small>{e.kind === 'main' ? '大類' : '細項'}</small>{e.name}</span>)}</div> : <EmptyState title="還沒有符合的詞條" description={search ? '試試其他名稱。' : '詞庫將在資料遷移後帶入。'} />}</Surface>}
    </section><aside><Surface variant="note" className="aside-note"><Heading level={2}>喜歡有很多種程度</Heading><Text>本命、常聽、聽過一些、只聽過幾首。用自己的方式記錄。</Text><Link className="text-link" to="/me/music">編輯我的成分 →</Link></Surface></aside></div></>;
}
