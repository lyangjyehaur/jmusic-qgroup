import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { scopedHttp } from './http';
import { Failure, Notice } from './shared';
import { OverviewStats } from './overview-stats';
import { uiText } from './language';

export function ParticipationSummary({ scope }: { scope: string }) {
  const query = useQuery({ queryKey: ['private', scope, 'my-participation', { period: 'all', category: 'all', page: 1 }], refetchOnMount: 'always', refetchInterval: 30000,
    queryFn: () => scopedHttp(scope).requestContract('GET /api/v2/me/participation', {}) });
  return <section className="participation-me-summary" aria-label="我的參與統計"><div className="section-title-row"><h2>參與統計</h2><Link className="text-link" to="/me/participation">參加紀錄</Link></div>{query.isPending ? <Notice>正在讀取參加次數…</Notice> : query.error ? <Failure error={query.error} retry={() => void query.refetch()} /> : <OverviewStats label="我的參加次數" items={[{ label: uiText('累計參加'), value: query.data.count }]} />}</section>;
}
