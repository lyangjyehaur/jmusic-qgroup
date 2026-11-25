import type { ReactNode } from 'react';

/** Operational feedback stays outside the document's layout, including dialogs. */
export function FeedbackLayer({ children }: { children: ReactNode }) {
  return <div className="kimi feedback-layer">{children}</div>;
}
