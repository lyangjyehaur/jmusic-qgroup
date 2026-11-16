import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Text } from 'yahha-ui';
import type { Viewer } from '@qgroup/contracts';

const reminded = new Set<string>();
const interval = 24 * 60 * 60 * 1000;
const reminderKey = (scope: string) => 'kanban-qq-reauth-v1:' + scope;
export function stampQQReminder(scope: string) {
  reminded.add(scope);
  try { localStorage.setItem(reminderKey(scope), String(Date.now())); } catch { /* Memory still prevents repeated prompts on this visit. */ }
}
export function QQAvatar({ url, nickname }: { url: string; nickname: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return url && failedUrl !== url ? <img className="qq-avatar" src={url} alt="QQ 頭像" width="48" height="48" referrerPolicy="no-referrer" onError={() => setFailedUrl(url)} /> : <span className="qq-avatar avatar-fallback" role="img" aria-label={url ? 'QQ 頭像無法載入' : 'QQ 頭像未提供'}>{Array.from(nickname)[0] ?? '?'}</span>;
}
export function QQReauthReminder({ viewer, returnTo }: { viewer: Extract<Viewer, { authenticated: true }>; returnTo: string }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!viewer.qqEnabled || !viewer.qq.needsReauth || reminded.has(viewer.scope)) return;
    try {
      const stamp = Number(localStorage.getItem(reminderKey(viewer.scope)));
      const age = Date.now() - stamp;
      if (stamp > 0 && Number.isFinite(stamp) && age >= 0 && age < interval) return;
    } catch { /* Browser storage is optional for this non-blocking reminder. */ }
    stampQQReminder(viewer.scope); setVisible(true);
  }, [viewer.scope, viewer.qqEnabled, viewer.qq.needsReauth]);
  if (!visible || !viewer.qqEnabled || !viewer.qq.needsReauth) return null;
  return <aside className="notice reauth-reminder" aria-label="QQ 資料更新提醒"><Text>尚未取得 UnionID，bot 可能無法對應此帳號。網站仍可使用。</Text><Link to={'/login?mode=bind&returnTo=' + encodeURIComponent(returnTo)}>重新授權原 QQ</Link><Button variant="ghost" onClick={() => { stampQQReminder(viewer.scope); setVisible(false); }}>稍後處理</Button></aside>;
}
