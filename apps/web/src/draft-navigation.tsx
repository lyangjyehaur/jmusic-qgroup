import { Dialog, Text } from 'yahha-ui';
import type { useBlocker } from 'react-router-dom';
import { Button } from './kimi-ui';

export type DraftNavigation = {
  blocker?: ReturnType<typeof useBlocker>;
  busy: boolean;
  loading: boolean;
  saving?: boolean;
  hasPending?: boolean;
  canDiscard?: boolean;
  storageError?: string;
  readError?: string;
  leaveHint?: string;
  leave?: () => Promise<void>;
  discardAndLeave?: () => Promise<void>;
};

/** Navigation decisions have their own focus trap, independent of the form's scroll. */
export function DraftLeaveConfirmation({ form }: { form: DraftNavigation }) {
  if (form.blocker?.state !== 'blocked') return null;
  const pending = !!form.hasPending, locked = form.busy || form.loading || !!form.saving;
  return <Dialog open title={pending ? '操作結果尚未確認' : '尚未提交的修改'}
    className="kimi draft-confirm-dialog" closeLabel="取消離開" disablePointerDismissal
    onOpenChange={open => { if (!open && !locked) form.blocker?.reset?.(); }}
    footer={<div className="draft-leave-actions">
      <Button variant="secondary" disabled={locked} onClick={() => form.blocker?.reset?.()}>繼續編輯</Button>
      <Button variant="secondary" disabled={locked} onClick={() => void form.leave?.()}>{pending ? '保留操作並離開' : '保留原稿並離開'}</Button>
      {!pending && form.discardAndLeave && <Button variant="danger" disabled={locked || !form.canDiscard} onClick={() => void form.discardAndLeave?.()}>捨棄並離開</Button>}
    </div>}>
    <Text>{pending ? '操作可能已送出。離開會保留原操作編號，回來後可確認結果。' : '可以保留本機草稿稍後繼續，或捨棄這次未提交的修改；已提交的資料不受影響。'}</Text>
    {form.leaveHint && <Text>{form.leaveHint}</Text>}
    {form.readError && <Text role="alert">{form.readError}</Text>}
    {form.storageError && <Text role="alert">{form.storageError}</Text>}
  </Dialog>;
}
