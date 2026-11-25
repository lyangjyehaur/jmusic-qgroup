import { createContext, useContext, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Heading, Surface, Text } from 'yahha-ui';
import { Button } from './kimi-ui';

import { createWebHttpClient } from './http';
import { errorText } from './language';
import { useActivityAction } from './activity-action-context';
import { DialogPageContext } from './discovery-dialog';
export const EmbeddedPageContext=createContext(false);
export const sessionQuery = { queryKey: ['session'], queryFn: () => createWebHttpClient().requestContract('GET /api/v2/session', {}), refetchOnWindowFocus: 'always' as const, refetchOnReconnect: 'always' as const, refetchInterval: 30000 };
export const useSession = () => useQuery(sessionQuery);
export function Notice({ children }: { children: ReactNode }) { return <div className="notice" role="status">{children}</div>; }
export function Failure({ error, retry }: { error: Error; retry: () => void }) {
  return <Surface className="failure"><Text role="alert">{errorText(error)}</Text><Button variant="secondary" onClick={retry}>重新讀取</Button></Surface>;
}
export function PageIntro({ title, children }: { title: string; children?: ReactNode }) {
  const embedded=useContext(EmbeddedPageContext);
  const action = useActivityAction();
  const dialog = useContext(DialogPageContext);
  if (action || dialog) return children ? <Text tone="muted">{children}</Text> : null;
  return <header className={embedded?"section-heading":"page-header"}><div className="page-heading"><div><Heading level={embedded?2:1}>{title}</Heading>{children && <Text tone="muted">{children}</Text>}</div></div></header>;
}
