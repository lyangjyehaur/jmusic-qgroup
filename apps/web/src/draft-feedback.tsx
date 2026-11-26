import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Dialog } from 'yahha-ui';
import { displayLocale, uiText } from './language';
import { Button, IconButton } from './kimi-ui';
import { X } from 'lucide-react';
import { DraftLeaveConfirmation, type DraftNavigation } from './draft-navigation';

// One fixed stack per page or dialog keeps messages from independent forms from overlapping.
const feedbackHosts = new WeakMap<Element, { node: HTMLDivElement; users: number }>();

type DraftForm = DraftNavigation & {
  message: string; readError: string; storageError: string;
  recover: () => void; saving: boolean; needsRestore: boolean; restore: () => void;
  conflict: boolean; expired: boolean; versions: import('./draft-store').DraftVersion[];
  restoreVersion: (id: string) => Promise<void>;
  discard?: () => Promise<boolean>;
};

export function DraftFeedback({ form, navigation = true, showProgress = false, placement = 'floating',
  restoreHint = uiText('有一份未提交的本機草稿，可以恢復繼續或捨棄。'),
}: { form: DraftForm; navigation?: boolean; showProgress?: boolean; placement?: 'floating' | 'inline'; restoreHint?: string }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [container, setContainer] = useState<Element | null>(null);
  const [dismissed, setDismissed] = useState(''), [versionsOpen, setVersionsOpen] = useState(false);
  useEffect(() => { setDismissed(''); }, [form.message]);
  useLayoutEffect(() => {
    if (placement === 'inline') return;
    const host = anchor.current?.closest('[role="dialog"], dialog') ?? document.body;
    let entry = feedbackHosts.get(host);
    if (!entry) {
      const node = document.createElement('div'); node.className = 'kimi draft-feedback-float';
      host.appendChild(node); entry = { node, users: 0 }; feedbackHosts.set(host, entry);
    }
    entry.users++; setContainer(entry.node);
    return () => { if (--entry.users === 0) { entry.node.remove(); feedbackHosts.delete(host); } };
  }, [placement]);
  const message = form.message && form.message !== dismissed ? form.message : '';
  const attention = form.needsRestore || form.readError || form.storageError || message;
  const feedback = <div className={placement === 'floating' ? 'draft-feedback-item' : 'draft-feedback-inline'}>
    {attention && <section className="draft-feedback-notice" aria-label="草稿狀態">
      {form.needsRestore && <><p role="status">{restoreHint}</p><div className="draft-feedback-actions">
        <Button size="sm" disabled={form.busy || form.loading} onClick={form.restore}>恢復本機原稿</Button>
        {form.discard && <Button size="sm" variant="secondary" disabled={!form.canDiscard} onClick={() => void form.discard?.()}>捨棄草稿</Button>}
      </div></>}
      {message && <div className="draft-feedback-message"><p role="status">{message}</p><IconButton label="關閉草稿提示" onClick={() => setDismissed(message)}><X size={16}/></IconButton></div>}
      {form.storageError && <p role="alert">{form.storageError}</p>}
      {form.readError && <><p role="alert">{form.readError}</p><div className="draft-feedback-actions">
        {form.expired ? <Button size="sm" onClick={() => window.location.reload()}>重新載入頁面</Button> : <Button size="sm" disabled={form.busy || form.loading} onClick={form.recover}>{form.conflict ? '讀取已保存版本' : '保全原稿後繼續'}</Button>}
      </div></>}
    </section>}
    {!!form.versions.length && <Button variant="ghost" size="sm" className="draft-versions-button" onClick={() => setVersionsOpen(true)}>草稿版本（{form.versions.length}）</Button>}
  </div>;
  return <>
    <span ref={anchor} hidden/>
    {showProgress && (form.loading || form.saving) && <span className="sr-only" role="status">{form.loading ? '正在讀取本機原稿…' : '正在保存本機原稿…'}</span>}
    {(attention || form.versions.length > 0) && (placement === 'inline' ? feedback : container && createPortal(feedback, container))}
    {navigation && <DraftLeaveConfirmation form={form}/>}
    {versionsOpen && <Dialog open title="本機草稿版本" className="kimi draft-confirm-dialog" closeLabel="關閉草稿版本" onOpenChange={setVersionsOpen}>
      <ul className="draft-version-list">{form.versions.map(version => <li key={version.id}>
        <p>{new Date(version.at).toLocaleString(displayLocale())} · {version.reason}</p>
        <div className="draft-feedback-actions"><Button variant="secondary" size="sm" disabled={form.busy || !!form.readError || form.loading || form.hasPending} onClick={async () => { await form.restoreVersion(version.id); setVersionsOpen(false); }}>載入此原稿（保留目前版本）</Button>
          <Button variant="ghost" size="sm" onClick={() => {
            const url = URL.createObjectURL(new Blob([version.raw], { type: 'application/json' }));
            const link = document.createElement('a'); link.href = url; link.download = 'qgroup-draft-' + version.id + '.json'; link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}>下載保全檔</Button></div>
      </li>)}</ul>
    </Dialog>}
  </>;
}
