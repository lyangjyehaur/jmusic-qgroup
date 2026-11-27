import { useEffect, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { PageHeader, Select } from './kimi-ui';

export type InformationTopic = readonly [id: string, label: string];

export function InformationPage({ title, topics, children }: {
  title: string; topics: readonly InformationTopic[]; children: ReactNode;
}) {
  const { pathname, hash } = useLocation();
  const navigate = useNavigate();
  const current = topics.find(([id]) => hash === '#' + id)?.[0] ?? '';
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (current) document.getElementById(current)?.scrollIntoView({ block: 'start' });
      else window.scrollTo({ top: 0, behavior: 'instant' });
    });
    return () => cancelAnimationFrame(frame);
  }, [pathname, hash, current]);
  return <div className="kimi page information-page">
    <PageHeader title={title}/>
    <div className="information-layout">
      <nav className="information-contents" aria-label="說明章節">
        <div className="information-contents-links">{topics.map(([id, label]) =>
          <Link key={id} to={'#' + id} aria-current={current === id ? 'location' : undefined}>{label}</Link>
        )}</div>
        <div className="information-contents-select"><Select label="跳至章節" value={current}
          onChange={event => navigate('#' + event.target.value)}>
          <option value="" disabled>選擇章節</option>
          {topics.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </Select></div>
      </nav>
      <div className="information-body">{children}</div>
    </div>
  </div>;
}
