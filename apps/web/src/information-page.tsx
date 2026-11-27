import { useEffect, useRef, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { PageHeader } from './kimi-ui';

export function InformationPage({ title, children }: {
  title: string; children: ReactNode;
}) {
  const { pathname, hash } = useLocation();
  const page = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const chapter = hash ? document.getElementById(hash.slice(1)) : null;
      if (chapter && page.current?.contains(chapter)) chapter.scrollIntoView({ block: 'start' });
      else window.scrollTo({ top: 0, behavior: 'instant' });
    });
    return () => cancelAnimationFrame(frame);
  }, [pathname, hash]);
  return <div ref={page} className="kimi page information-page">
    <PageHeader title={title}/>
    {children}
  </div>;
}
