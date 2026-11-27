import { Check } from 'lucide-react';
import { Dialog } from 'yahha-ui';
import { Button } from './kimi-ui';
import { uiText } from './language';
import type { MusicSelection } from './music-selection';

export const musicLevels = [
  { value: 4, label: uiText('本命'), hint: uiText('全專都聽／會唱') },
  { value: 3, label: uiText('常聽'), hint: uiText('大部分歌都熟') },
  { value: 2, label: uiText('聽過一些'), hint: uiText('熟悉的歌有幾首') },
  { value: 1, label: uiText('只聽過幾首'), hint: uiText('聽過名字或一兩首') },
] as const;

export function musicLevelLabel(value: number) {
  return musicLevels.find(level => level.value === value)?.label ?? uiText('常聽');
}

/** One picker serves quick-add, catalog rows and nested term details. */
export function MusicLevelPicker({ selection: form }: { selection: MusicSelection }) {
  const entry = form.entries.find(entry => entry.id === form.levelEntryId && entry.kind === 'sub');
  if (!entry || !form.selected.has(entry.id)) return null;
  return <Dialog open title={'「' + entry.name + '」的喜歡程度'}
    description="關閉會保留目前選擇；保存成分後才會同步。"
    className="kimi music-level-dialog" closeLabel="關閉喜歡程度"
    onOpenChange={open => { if (!open) form.closeLevelPicker(); }}
    footer={<Button variant="ghost" disabled={form.locked} onClick={() => form.remove(entry.id)}>從已選中移除</Button>}>
    <div className="music-level-options" aria-label="喜歡程度">
      {musicLevels.map(level => <Button key={level.value} variant={form.selected.get(entry.id) === level.value ? 'secondary' : 'ghost'}
        aria-label={level.label} aria-pressed={form.selected.get(entry.id) === level.value} disabled={form.locked}
        onClick={() => { form.level(entry.id, level.value); form.closeLevelPicker(); }}>
        <span><strong>{level.label}</strong><small>{level.hint}</small></span>
        {form.selected.get(entry.id) === level.value && <Check size={18} aria-hidden="true"/>}
      </Button>)}
    </div>
    {(form.readError || form.storageError) && <p role="alert">{form.readError || form.storageError}</p>}
  </Dialog>;
}
