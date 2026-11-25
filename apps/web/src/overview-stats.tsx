import type { CSSProperties, ReactNode } from 'react';

export function OverviewStats({ label, items, action }: {
  label: string;
  items: { label: string; value: ReactNode }[];
  action?: ReactNode;
}) {
  return <dl className={'activity-overview overview-stats'+(items.length===4?' overview-stats-four':'')} aria-label={label}
    style={{ '--overview-columns': items.length === 4 ? 2 : items.length } as CSSProperties}>
    {items.map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}
    {action&&<div className="overview-actions"><dt className="sr-only">操作</dt><dd>{action}</dd></div>}
  </dl>;
}
