import { errorText, uiText } from './language';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button, Surface, Text } from 'yahha-ui';
import { MusicShareContext } from '@qgroup/contracts';
import { musicSharePicks, musicSelectionText } from '@qgroup/domain';
import { useMusicMatchSort } from './music-match-sort';
import { api } from './api';
import { Failure, Notice, PageIntro } from './shared';
import { loginLink } from './auth';
import { useMusicWorkspace, type MusicSelection } from './music-selection';
import { drawMusicShare, musicShareBlob, type ShareCard } from './music-share-canvas';
const filename = uiText('我的音樂成分.png');
export function MusicSharePage() {
  const workspace = useMusicWorkspace(), location = useLocation();
  return <><PageIntro title="分享成分" /><Link className="back" to={'/me/music' + location.search}>回到我的成分</Link>
    {workspace.state === 'ready' ? <ShareEditor selection={workspace.selection} /> : workspace.state === 'guest'
      ? <Notice>請先<Link to={loginLink(location.pathname + location.search)}>登入</Link>。</Notice> : <Notice>正在確認成分…</Notice>}
  </>;
}
function ShareEditor({ selection }: { selection: MusicSelection }) {
  const [params] = useSearchParams(), { sort, change } = useMusicMatchSort();
  const viewer = selection.viewer;
  const context = useQuery({ queryKey: ['private', viewer.scope, 'music-share', viewer.musicEpoch, sort],
    queryFn: ({ signal }) => api('/me/music/share?sort=' + sort, MusicShareContext, { signal, headers: { 'X-Account-Scope': viewer.scope } }),
    refetchOnMount: 'always', refetchOnWindowFocus: 'always', staleTime: 0, refetchInterval: 10000 });
  const picks = musicSharePicks(selection.draft.selections, selection.entries), text = musicSelectionText(picks);
  const [contact, setContact] = useState(false), [topMatch, setTopMatch] = useState(true), [topContact, setTopContact] = useState(false), [dark, setDark] = useState(false);
  if (selection.unavailable) return <Notice>請先在本機原稿提示中完成恢復或保全，再產生分享內容。</Notice>;
  if (selection.readError || selection.draft.requestKey) return <Notice>{selection.readError ? '請回到我的成分保全原稿，再產生分享內容。' : '成分保存結果尚未確認，請回到我的成分確認結果。'}</Notice>;
  if (!picks.length) return <Notice>尚未選擇可分享的詞條，請<Link to={'/me/music?' + params}>選擇成分</Link>。</Notice>;
  const current = context.data && context.isFetchedAfterMount && !context.error ? context.data : undefined;
  const stale = current && (current.profileId !== selection.draft.profileId || current.musicEpoch !== selection.draft.musicEpoch);
  const input: ShareCard | null = current && !stale ? { context: current, picks, origin: window.location.origin,
    contact, topMatch, topContact, dark, draft: selection.dirty || !selection.saved } : null;
  return <>
    {selection.dirty && <Notice>使用目前草稿產生分享，不會自動保存。推薦同好仍依已保存成分計算。</Notice>}
    {picks.length !== selection.draft.selections.length && <Notice>{selection.draft.selections.length - picks.length} 個已移除詞條不會包含在分享中；原草稿仍保留。</Notice>}
    <Surface className="detail music-share-options"><label className="consent"><input type="checkbox" checked={contact} disabled={!current?.contactQQ} onChange={event => setContact(event.target.checked)} /><span>包含我的聯絡 QQ</span></label>
      <label className="consent"><input type="checkbox" checked={topMatch} onChange={event => setTopMatch(event.target.checked)} /><span>包含推薦同好</span></label>
      {topMatch && <><label className="account-field">推薦排序<select aria-label="分享推薦排序" value={sort} onChange={event => change(event.target.value === 'familiar' ? 'familiar' : 'rare')}><option value="rare">共同項／冷門優先</option><option value="familiar">我的熟悉度優先</option></select></label>
        <label className="consent"><input type="checkbox" checked={topContact} disabled={!current?.topMatch?.contactQQ} onChange={event => setTopContact(event.target.checked)} /><span>包含同好的聯絡 QQ</span></label></>}
      <label className="account-field">圖片配色<select aria-label="圖片配色" value={dark ? 'dark' : 'light'} onChange={event => setDark(event.target.value === 'dark')}><option value="light">淺色</option><option value="dark">深色</option></select></label>
      <Text>圖片包含成分稱呼、固定 ID、詞條與選用人數；勾選後也會包含推薦同好或聯絡 QQ。不包含私人留言與性別。</Text>
    </Surface>
    {context.isPending || !context.isFetchedAfterMount ? <Notice>正在讀取分享資料…</Notice> : context.error ? <Failure error={context.error} retry={() => void context.refetch()} />
      : stale ? <Notice>目前成分已刪除、重建或移交；請回到我的成分核對並保留原稿。</Notice> : null}
    {input && <ShareImage signature={JSON.stringify(input)} />}
    <SelectionText key={viewer.scope + ':' + text} text={text} />
  </>;
}
function SelectionText({ text }: { text: string }) {
  const [message, setMessage] = useState(''), active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function copy() {
    try { await navigator.clipboard.writeText(text); if (active.current) setMessage(uiText("已複製詞條清單。")); }
    catch { if (active.current) setMessage(uiText("無法自動複製，請選取下方詞條清單手動複製。")); }
  }
  return <Surface className="detail auth-panel"><label className="account-field">詞條清單<textarea rows={5} readOnly value={text} /></label>
    <Button variant="secondary" onClick={() => void copy()}>複製詞條清單</Button>{message && <Text role="status">{message}</Text>}</Surface>;
}
function ShareImage({ signature }: { signature: string }) {
  const active = useRef(true), latest = useRef(signature); latest.current = signature;
  const [attempt, setAttempt] = useState(0), [ready, setReady] = useState<{ signature: string; url: string; file: File }>(), [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    let live = true, url: string | undefined; const stop=new AbortController(); setReady(undefined); setError(''); setMessage(''); setBusy(false);
    if (!signature) return;
    // Each conversion owns its bitmap. Cancelling an earlier draw must not
    // resize the canvas used by a newer asynchronous PNG conversion.
    const canvas = document.createElement('canvas');
    try {
      drawMusicShare(canvas, JSON.parse(signature) as ShareCard);
      void musicShareBlob(canvas,stop.signal).then(blob => {
        if (!live) return; url = URL.createObjectURL(blob);
        setReady({ signature, url, file: new File([blob], filename, { type: 'image/png' }) });
      }).catch(failure => { if (live) setError(failure instanceof Error ? errorText(failure) : uiText("圖片產生失敗，請重試。")); });
    } catch (failure) { setError(failure instanceof Error ? errorText(failure) : uiText("圖片產生失敗，請重試。")); }
    return () => { live = false; stop.abort(); if (url) URL.revokeObjectURL(url); canvas.width = 0; canvas.height = 0; };
  }, [signature, attempt]);
  const image = ready?.signature === signature ? ready : undefined;
  function download(url: string) { const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); }
  async function share() {
    if (!image || busy) return; const expected = signature, valid = () => active.current && latest.current === expected;
    setBusy(true); setMessage('');
    try {
      // File conversion already completed: preserve the click's native-share activation.
      if (navigator.canShare?.({ files: [image.file] }) && navigator.share) {
        await navigator.share({ files: [image.file], title: uiText('我的音樂成分') }); if (valid()) setMessage(uiText("已完成圖片分享。"));
      } else if (valid()) { download(image.url); setMessage(uiText("此瀏覽器不支援圖片分享，已改為下載。")); }
    } catch (failure) {
      if (!valid()) return;
      if (failure instanceof Error && failure.name === 'AbortError') setMessage(uiText("已取消分享。"));
      else { download(image.url); setMessage(uiText("圖片分享失敗，已改為下載。")); }
    } finally { if (valid()) setBusy(false); }
  }
  return <section aria-label="分享圖片" className="music-share-preview">
    {signature && (error ? <div role="alert"><Text>{error}</Text><Button variant="secondary" onClick={() => setAttempt(value => value + 1)}>重新產生圖片</Button></div>
      : image ? <><img src={image.url} onError={() => setError(uiText("圖片無法顯示，請重新產生；仍可複製詞條清單。"))} alt="音樂成分分享圖片；完整詞條可見下方清單" /><div className="page-actions"><a href={image.url} download={filename}>下載圖片</a><Button variant="secondary" loading={busy} onClick={() => void share()}>分享圖片</Button></div></> : <Notice>正在產生圖片…</Notice>)}
    {message && <Text role="status">{message}</Text>}
  </section>;
}
