import { ListMusic, Save } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import type { MusicSelection } from './music-selection';
import { Button } from './kimi-ui';
import { ActionLink } from './action-link';

export function MusicSaveDock({ selection: form }: { selection: MusicSelection }) {
  const ref=useRef<HTMLElement>(null);
  useLayoutEffect(()=>{
    const dialog=ref.current?.closest<HTMLElement>('[role=dialog]'),footer=ref.current?.parentElement;
    if(!dialog||!footer)return;
    const measure=()=>dialog.style.setProperty('--music-dialog-footer-height',footer.getBoundingClientRect().height+'px');
    const observer=new ResizeObserver(measure);observer.observe(footer);measure();
    return()=>{observer.disconnect();dialog.style.removeProperty('--music-dialog-footer-height');};
  },[]);
  const visible=form.dirty || !!form.draft.requestKey || form.sending;
  const pending = !!form.draft.requestKey;
  return <section ref={ref} hidden={!visible} className="kimi music-save-dock" aria-label="詞條變動保存" aria-busy={form.sending}>
    <div className="music-save-summary">
      <strong role="status">{form.sending ? '正在保存成分…' : pending ? '保存結果待確認' : '有未保存的詞條變動'}</strong>
      <span>領域 {form.mainCount}/5 · 細分 {form.subCount}/15 · 共 {form.selected.size}/20 項</span>
    </div>
    <ActionLink to="/me/music" variant="ghost" size="sm" className="music-save-review" aria-label="檢查我的選擇" title="檢查我的選擇"><ListMusic size={18}/></ActionLink>
    <Button aria-label={pending ? '確認詞條保存結果' : '保存詞條變動'} loading={form.sending} disabled={form.unavailable || form.sending} onClick={() => void form.save()}><Save size={16}/>{pending ? '確認保存結果' : '保存成分'}</Button>
  </section>;
}
