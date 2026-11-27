import { Check, Plus } from 'lucide-react';
import { Button } from './kimi-ui';
import { useMusicWorkspace } from './music-selection';

export function MusicTermButton({ entryId }: { entryId: string }) {
  const workspace = useMusicWorkspace();
  if (workspace.state !== 'ready') return null;
  const form = workspace.selection, entry = form.entries.find(entry => entry.id === entryId);
  if (!entry) return null;
  const selected = form.selected.has(entry.id);
  const label = (selected ? '調整喜歡程度：' : '選取') + entry.name;
  return <Button className="music-term-choice" variant={selected ? 'secondary' : 'ghost'} size="sm"
    aria-label={label} title={label} aria-pressed={selected} disabled={form.locked} onClick={() => form.toggle(entry)}>
    {selected ? <Check size={15} aria-hidden="true"/> : <Plus size={15} aria-hidden="true"/>}
  </Button>;
}
