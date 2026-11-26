import { ListMusic, RefreshCw, Save } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import type { MusicSelection } from './music-selection';
import { Button, Disclosure } from './kimi-ui';
import { ActionLink } from './action-link';
import { DraftFeedback } from './draft-feedback';
import { uiText } from './language';

export const musicSaveDockVisible=(form:MusicSelection)=>form.dirty||!!form.draft.requestKey||form.sending||form.record.needsRestore||!!form.readError||!!form.storageError;

export function MusicSaveDock({ selection: form }: { selection: MusicSelection }) {
  const ref=useRef<HTMLElement>(null);
  useLayoutEffect(()=>{
    const dialog=ref.current?.closest<HTMLElement>('[role=dialog]'),footer=ref.current?.parentElement;
    if(!dialog||!footer)return;
    const measure=()=>dialog.style.setProperty('--music-dialog-footer-height',footer.getBoundingClientRect().height+'px');
    const observer=new ResizeObserver(measure);observer.observe(footer);measure();
    return()=>{observer.disconnect();dialog.style.removeProperty('--music-dialog-footer-height');};
  },[]);
  const visible=musicSaveDockVisible(form);
  const pending = !!form.draft.requestKey;
  const mustRead=form.needsRebase&&!form.unavailable;
  const title=form.sending?(form.operation==='read'?uiText('正在讀取最新版本…'):uiText('正在保存成分…')):
    form.readError?uiText('本機草稿暫時無法使用'):form.record.needsRestore?uiText('有尚未保存的本機草稿'):
    pending?uiText('保存結果待確認'):form.storageError?uiText('本機草稿保存失敗'):mustRead?uiText('成分版本不同，尚未保存'):uiText('有未保存的詞條變動');
  const levels=[uiText('只聽過幾首'),uiText('聽過一些'),uiText('常聽'),uiText('本命')];
  return <section ref={ref} hidden={!visible} className="kimi music-save-dock" aria-label="詞條變動保存" aria-busy={form.sending}>
    {visible&&<>
    <div className="music-save-summary">
      <strong role="status">{title}</strong>
      <span>領域 {form.mainCount}/5 · 細分 {form.subCount}/15 · 共 {form.selected.size}/20 項</span>
    </div>
    <ActionLink to="/me/music" variant="ghost" size="sm" className="music-save-review" aria-label="檢查我的選擇" title="檢查我的選擇"><ListMusic size={18}/></ActionLink>
    <Button aria-label={mustRead?'讀取最新版本':pending ? '確認詞條保存結果' : '保存詞條變動'} loading={form.sending} disabled={form.unavailable || form.sending} onClick={() => void (mustRead?form.rebase():form.save())}>{mustRead?<RefreshCw size={16}/>:<Save size={16}/>} {mustRead?'讀取最新版本':pending ? '確認保存結果' : form.storageError?'重試保存':'保存成分'}</Button>
    <div className="music-save-feedback">
      {mustRead&&<p>目前草稿和已保存的成分版本不同。你的勾選仍保留，請先讀取最新版本再保存。</p>}
      {pending&&!form.message&&<p>上次保存是否成功尚未確認。請確認保存結果後再繼續編輯，避免重複送出。</p>}
      {form.message&&<p role="status">{form.message}</p>}
      <DraftFeedback form={form.record} navigation={false} showProgress={false} placement="inline" restoreHint={uiText('上次的勾選還沒有保存到成分，可以恢復繼續或捨棄。')}/>
      {form.storageError&&<p>{pending?'排除儲存問題後，請按「確認保存結果」。':mustRead?'請檢查瀏覽器儲存空間或網站儲存權限，再重試讀取。':'請檢查瀏覽器儲存空間或網站儲存權限，再按「重試保存」。'}</p>}
      {form.reviewed&&!form.needsRebase&&form.dirty&&<>
        <p>保存將以你目前勾選的詞條及喜歡程度為準。</p>
        <Disclosure   title={<>查看目前已保存的選擇（{form.saved?.selections.length??0}）</>}>
          {form.saved?.selections.length?<ul>{form.saved.selections.map(choice=>{
            const entry=form.entries.find(item=>item.id===choice.entryId);
            return <li key={choice.entryId}>{entry?.name??uiText('已移除的詞條')}{entry?.kind==='sub'?' · '+levels[choice.level-1]:''}</li>;
          })}</ul>:<p>目前沒有已保存的詞條。</p>}
        </Disclosure>
      </>}
    </div>
    </>}
  </section>;
}
