import { useLocation, useNavigate } from 'react-router-dom';
import { Tabs } from './kimi-ui';
import { uiText } from './language';

export function MusicBrowseTabs({ value, onChange }: { value: string; onChange?: (value: string) => void }) {
  const location = useLocation(), navigate = useNavigate();
  function change(nextValue: string) {
    const next = new URLSearchParams(location.search);
    next.delete('entry');
    if (nextValue === 'trends') {
      navigate('/music/trends' + (next.size ? '?' + next : ''));
      return;
    }
    if (onChange) { onChange(nextValue); return; }
    next.set('explorer', nextValue);
    if (nextValue === 'all') next.set('library', 'all'); else next.delete('library');
    navigate('/music?' + next);
  }
  return <div className="explorer-tabs music-browse-tabs"><Tabs label="詞庫範圍" value={value} onChange={change} items={[
    { value: 'popular', label: uiText('熱門排行') }, { value: 'all', label: uiText('完整詞庫') },
    { value: 'trends', label: uiText('音樂趨勢') },
  ]}/></div>;
}
