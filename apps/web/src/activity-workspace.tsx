import { useRef } from 'react';
import { Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Dialog, Heading } from 'yahha-ui';
import { ActivityDetail } from './activities';
import { ActivityActionContext } from './activity-action-context';
import { uiText } from './language';

const titles: Record<string, string> = {
  signup: uiText('新增報名'), registration: uiText('管理報名'),
  share: uiText('分享活動'), conditions: uiText('安排版本與確認'),
  arrangements: uiText('編輯活動安排'), lifecycle: uiText('管理活動狀態'),
  attendance: uiText('現場出席'), delegation: uiText('管理分工'),
  invitations: uiText('補報名邀請'), claims: uiText('代報認領'),
  rooms: uiText('分配包間'), 'rooms/history': uiText('預分安排歷史'),
  settlement: uiText('逐人結算'), 'settlement/edit': uiText('編輯結算'),
  'settlement/images': uiText('結算圖片'), finance: uiText('收付款帳本'),
  history: uiText('活動歷史'), 'bot-deliveries': uiText('群通知紀錄'),
};

/** Keep the activity mounted while its existing URL-addressable operations open. */
export function ActivityWorkspace() {
  const { id = '' } = useParams(), location = useLocation(), navigate = useNavigate();
  const base = '/activities/' + encodeURIComponent(id);
  const action = location.pathname.slice(base.length + 1);
  const inline = action === 'settlement' || action === 'finance';
  const open = !inline && Object.hasOwn(titles, action);
  const overview = useRef(base);
  const visitedOverview = useRef<string | null>(null);
  if (!open && location.pathname === base) overview.current = base + location.search + location.hash;
  if (!open) visitedOverview.current = id;
  return <>
    {(!open || visitedOverview.current === id) && <div className="activity-workspace-base" aria-hidden={open || undefined} inert={open || undefined}><ActivityDetail activeTab={inline?'settlement':undefined} panel={inline?<ActivityActionContext.Provider value={true}><Heading level={2}>{titles[action]}</Heading><Outlet/></ActivityActionContext.Provider>:undefined}/></div>}
    <ActivityActionContext.Provider value={true}>
      <Dialog open={open} title={titles[action] ?? uiText('活動操作')} closeLabel="返回活動"
        className="activity-action-dialog kimi yj-dialog yj-dialog-wide" disablePointerDismissal
        onOpenChange={next => { if (!next) void navigate(overview.current, { replace: true }); }}>
        {open && <Outlet />}
      </Dialog>
    </ActivityActionContext.Provider>
  </>;
}
