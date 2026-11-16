import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Heading, Surface, Text } from 'yahha-ui';
import { Session } from '@qgroup/contracts';
import { api } from './api';
export const sessionQuery = { queryKey: ['session'], queryFn: () => api('/session', Session), refetchOnWindowFocus: 'always' as const, refetchOnReconnect: 'always' as const, refetchInterval: 30000 };
export const useSession = () => useQuery(sessionQuery);
export function Notice({ children }: { children: ReactNode }) { return <div className="notice" role="status">{children}</div>; }
export function Failure({ error, retry }: { error: Error; retry: () => void }) {
  return <Surface className="failure"><Text role="alert">{error.message}</Text><Button variant="secondary" onClick={retry}>重新讀取</Button></Surface>;
}
export function PageIntro({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="intro"><Heading level={1}>{title}</Heading>{children && <Text tone="muted">{children}</Text>}</div>;
}
