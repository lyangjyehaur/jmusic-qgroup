import { displayLocale, uiText } from './language';
import { Text } from 'yahha-ui';
import { Button } from './kimi-ui';
import { Notice } from './shared';
export function DraftFeedback({
  form,
  navigation = true,
  showProgress = true,
  restoreHint = uiText('有一份本機原稿，請核對後繼續。'),
}: {
  navigation?: boolean;
  showProgress?: boolean;
  restoreHint?: string;
  form: {
    message: string;
    readError: string;
    storageError: string;
    recover: () => void;
    loading: boolean;
    saving: boolean;
    needsRestore: boolean;
    restore: () => void;
    conflict: boolean;
    expired: boolean;
    busy: boolean;
    versions: import('./draft-store').DraftVersion[];
    restoreVersion: (id: string) => Promise<void>;
    leave?: () => Promise<void>;
    blocker?: ReturnType<typeof import('react-router-dom').useBlocker>;
  };
}) {
  return (
    <>
      {showProgress && form.loading && <Text role="status">正在讀取本機原稿…</Text>}
      {showProgress && form.saving && <Text role="status">正在保存本機原稿…</Text>}
      {form.needsRestore && <Notice>{restoreHint}<Button onClick={form.restore}>恢復本機原稿</Button></Notice>}
      {form.message && <Text role="status">{form.message}</Text>}
      {form.storageError && <Text role="alert">{form.storageError}</Text>}
      {form.readError && (
        <Notice>
          {form.readError}
          {form.expired ? <Button onClick={() => window.location.reload()}>重新載入頁面</Button> : <Button disabled={form.busy || form.loading} onClick={form.recover}>{form.conflict ? '讀取已保存版本' : '保全原稿後繼續'}</Button>}
        </Notice>
      )}
      {!!form.versions.length && <details><summary>本機保全版本（{form.versions.length}）</summary>
        <ul>{form.versions.map(version => <li key={version.id}>
          {new Date(version.at).toLocaleString(displayLocale())} · {version.reason}
          <Button variant="ghost" disabled={form.busy || !!form.readError || form.loading} onClick={() => void form.restoreVersion(version.id)}>載入此原稿（保留目前版本）</Button>
          <Button variant="ghost" onClick={() => {
            const url = URL.createObjectURL(new Blob([version.raw], { type: 'application/json' }));
            const link = document.createElement('a'); link.href = url; link.download = 'qgroup-draft-' + version.id + '.json'; link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}>下載保全檔</Button>
        </li>)}</ul>
      </details>}
      {navigation && form.blocker?.state === 'blocked' && (
        <Notice>
          仍有未完成原稿。<Button onClick={() => form.blocker?.reset?.()}>繼續核對</Button>
          <Button variant="secondary" disabled={form.busy || form.loading} onClick={() => void form.leave?.()}>
            保留原稿並離開
          </Button>
        </Notice>
      )}
    </>
  );
}
