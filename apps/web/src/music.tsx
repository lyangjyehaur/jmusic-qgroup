import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { EmptyState, Heading, Surface, TextField } from 'yahha-ui';
import { Catalog } from '@qgroup/contracts';
import { api } from './api';
import { Failure, Notice, PageIntro } from './shared';
export function Music() {
  const [search, setSearch] = useState('');
  const query = useQuery({ queryKey: ['catalog'], queryFn: () => api('/music/entries', Catalog) });
  const entries = query.data?.entries.filter(e => e.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) ?? [];
  return <><PageIntro title="音樂" /><div className="page-actions"><Link to="/me/music">編輯我的成分</Link></div><section>
    <TextField label="搜尋音樂詞條" type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="風格、歌手、樂團…" />
    {query.isPending ? <Notice>正在讀取詞條…</Notice> : query.error ? <Failure error={query.error} retry={() => void query.refetch()} /> : <Surface className="library"><Heading level={2}>音樂詞庫</Heading>{entries.length ? <div className="entry-list">{entries.map(e => <span className="entry" key={e.id}><small>{e.kind === 'main' ? '大類' : '細項'}</small>{e.name}</span>)}</div> : <EmptyState title="還沒有符合的詞條" description={search ? '試試其他名稱。' : '詞庫尚未匯入。'} />}</Surface>}
    </section></>;
}
