import { useNavigate } from 'react-router-dom';
import { Tabs } from './kimi-ui';
import { uiText } from './language';

export function ActivityBrowseTabs({ value, onChange }: { value: string; onChange?: (value: string) => void }) {
  const navigate = useNavigate();
  return <div className="activity-browse-tabs"><Tabs label="活動篩選" value={value} onChange={onChange ?? (next => {
    void navigate(next === 'polls' ? '/time-polls' : next === 'mine' ? '/me/activities' : next === 'past' ? '/activities?period=history' : '/activities');
  })} items={[
    { value: 'all', label: uiText('近期活動') }, { value: 'mine', label: uiText('我的活動') },
    { value: 'past', label: uiText('往期與歸檔') }, { value: 'polls', label: uiText('時間投票') },
  ]}/></div>;
}
