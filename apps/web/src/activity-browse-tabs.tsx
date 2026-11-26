import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Tabs } from './kimi-ui';
import { uiText } from './language';

export function ActivityBrowseTabs({ value, onChange }: { value: string; onChange?: (value: string) => void }) {
  const navigate = useNavigate();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = root.current?.querySelector<HTMLElement>('[role="tablist"]');
    if (!list) return;
    function revealSelected() {
      const selected = list!.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!selected) return;
      const frame = list!.getBoundingClientRect(), tab = selected.getBoundingClientRect();
      if (tab.right > frame.right) list!.scrollLeft += tab.right - frame.right + 8;
      else if (tab.left < frame.left) list!.scrollLeft += tab.left - frame.left - 8;
    }
    revealSelected();
    const observer = new ResizeObserver(revealSelected);
    observer.observe(list);
    return () => observer.disconnect();
  }, [value]);
  return <div className="activity-browse-tabs" ref={root}><Tabs label="活動篩選" value={value} onChange={onChange ?? (next => {
    void navigate(next === 'stats' ? '/activities/participation' : next === 'polls' ? '/time-polls' : next === 'mine' ? '/me/activities' : next === 'past' ? '/activities?period=history' : '/activities');
  })} items={[
    { value: 'all', label: uiText('近期活動') }, { value: 'mine', label: uiText('我的活動') },
    { value: 'past', label: uiText('往期與歸檔') }, { value: 'polls', label: uiText('時間投票') },
    { value: 'stats', label: uiText('參與統計') },
  ]}/></div>;
}
