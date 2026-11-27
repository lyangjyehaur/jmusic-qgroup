import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { Member } from './member-access';
import { scopedHttp } from './http';
import { ContactValue } from './music-contact-value';

export function MusicQQPrompt({ viewer, showNumber=false }: { viewer: Member; showNumber?: boolean }) {
  const query = useQuery({ queryKey: ['private', viewer.scope, 'music-contact', viewer.musicEpoch],
    queryFn: ({ signal }) => scopedHttp(viewer.scope).requestContract('GET /api/v2/me/music/contact', { signal }), refetchOnMount: 'always' });
  if (!query.isFetchedAfterMount || query.error || !query.data) return null;
  if (query.data.contactQQ) return showNumber ? <div className="music-qq-setting"><span>QQ</span><ContactValue number={query.data.contactQQ} compact/></div> : null;
  return <div className="music-qq-prompt"><p>填寫 QQ，方便同好查詢和比較你的成分。</p><Link to="/me/music/contact">填寫 QQ（選填）</Link></div>;
}
