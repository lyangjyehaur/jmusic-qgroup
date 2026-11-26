import { errorText, uiText } from './language';
import { useEffect, useRef, useState } from 'react';
import { Text } from 'yahha-ui';
import { Button, Checkbox, Field } from './kimi-ui';
import { musicShareLines } from '@qgroup/domain';
import { Notice } from './shared';
import { musicShareBlob } from './music-share-canvas';
export type RoomShare = {
  title: string;
  rooms: {
    name: string;
    members: string[];
    avg: number;
    min: number;
    common: string[];
  }[];
  unassigned: number;
};
/** Whitelisted names and room statistics only. No contact, IDs, gender or notes. */
export function drawRoomShare(canvas: HTMLCanvasElement, input: RoomShare) {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('瀏覽器無法產生圖片，仍可複製分房清單。');
  const rows: { text: string; y: number; size: number; bold: boolean }[] = [],
    width = 720,
    pad = 36;
  let y = 36;
  const add = (text: string, size = 24, bold = false, lines = 3) => {
    ctx.font = `${bold ? 700 : 400} ${size}px sans-serif`;
    for (const value of musicShareLines(text, width - pad * 2, lines, (t) => ctx.measureText(t).width)) {
      rows.push({ text: value, y, size, bold });
      y += size * 1.5;
    }
  };
  add(input.title, 32, true);
  add(uiText('分房試算 · ') + input.rooms.length + uiText(' 間'), 24);
  y += 16;
  for (const room of input.rooms) {
    add(room.name + ' · ' + room.members.length + uiText(' 人'), 28, true);
    for (const name of room.members) add(name, 24, false, 3);
    add(uiText('平均 ') + room.avg + uiText(' · 最低 ') + room.min, 21);
    if (room.common.length) add(uiText('共同：') + room.common.join('、'), 21, false, 2);
    y += 22;
  }
  if (input.unassigned) add(uiText('尚未安排：') + input.unassigned + uiText(' 人'), 22);
  const height = Math.ceil(y + 28);
  if (height > 8000) throw new Error('圖片內容太長，請減少包間或改用分房清單。');
  canvas.width = width * 2;
  canvas.height = height * 2;
  ctx.scale(2, 2);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#182a44';
  ctx.textBaseline = 'top';
  for (const row of rows) {
    ctx.font = `${row.bold ? 700 : 400} ${row.size}px sans-serif`;
    ctx.fillText(row.text, pad, row.y);
  }
  return rows.map((row) => row.text);
}
export function MusicRoomShare({ value, enabled,beforeShare }: { value: RoomShare; enabled: boolean;beforeShare?:()=>Promise<boolean> }) {
  const [confirmed, setConfirmed] = useState(false),[approved,setApproved]=useState(false),
    [message, setMessage] = useState(''),
    [attempt, setAttempt] = useState(0),
    [image, setImage] = useState<{
      url: string;
      file: File;
      signature: string;
    }>(),
    [error, setError] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null),
    active = useRef(true),
    signature = JSON.stringify(value),
    latest = useRef('');
  latest.current = enabled && confirmed && approved ? signature : '';
  const text =
    value.title +
    uiText('\n分房試算\n\n') +
    value.rooms
      .map(
        (room) =>
          room.name +
          '\n' +
          room.members.join('、') +
          uiText('\n平均 ') +
          room.avg +
          uiText(' · 最低 ') +
          room.min +
          (room.common.length ? uiText('\n共同：') + room.common.join('、') : ''),
      )
      .join('\n\n') +
    (value.unassigned ? uiText('\n\n尚未安排：') + value.unassigned + uiText(' 人') : '');
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    setConfirmed(false);setApproved(false);
    setMessage('');
  }, [signature, enabled]);
  useEffect(() => {
    let live = true,
      url: string | undefined;
    setImage(undefined);
    setError('');
    if (!confirmed || !approved || !enabled || !canvas.current) return;
    try {
      drawRoomShare(canvas.current, value);
      void musicShareBlob(canvas.current)
        .then(async (blob) => {
          if (!live || beforeShare && !await beforeShare() || !live) return;
          url = URL.createObjectURL(blob);
          setImage({
            url,
            file: new File([blob], uiText('分房試算.png'), { type: 'image/png' }),
            signature,
          });
        })
        .catch(() => {
          if (live) setError(uiText("圖片產生失敗，可重試或複製分房清單。"));
        });
    } catch (failure) {
      setError(failure instanceof Error ? errorText(failure) : uiText("圖片產生失敗。"));
    }
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
      if (canvas.current) {
        canvas.current.width = 0;
        canvas.current.height = 0;
      }
    };
  }, [signature, confirmed,approved, enabled, attempt]);
  const ready = enabled && confirmed && approved && image?.signature === signature ? image : undefined;
  const download = async () => {
    if(beforeShare&&!await beforeShare())return false;
    if (!ready || latest.current !== signature) return false;
    const link = document.createElement('a');
    link.href = ready.url;
    link.download = uiText('分房試算.png');
    link.click();return true;
  };
  async function share() {
    if (!ready||beforeShare&&!await beforeShare()||latest.current!==signature) return;
    const expected = signature;
    try {
      if (navigator.share && navigator.canShare?.({ files: [ready.file] })) {
        await navigator.share({ files: [ready.file], title: value.title });
      } else if(!await download())return;
      if (active.current && latest.current === expected) setMessage(uiText("圖片分享已完成；不支援原生分享時已改為下載。"));
    } catch (failure) {
      if (!active.current || latest.current !== expected) return;
      if (failure instanceof Error && failure.name === 'AbortError') setMessage(uiText("已取消分享。"));
      else {
        if(await download())setMessage(uiText("分享失敗，已改為下載。"));
      }
    }
  }
  return (
    <section aria-label="分享分房" className="music-room-share">
      <Checkbox className="consent" checked={confirmed} disabled={!enabled} onChange={(event) => {const on=event.target.checked;setConfirmed(on);setApproved(false);if(!on)return;void(async()=>{const allowed=!beforeShare||await beforeShare();if(active.current){setApproved(allowed);if(!allowed)setConfirmed(false);}})();}} label={<>

        <span>圖片包含活動／包間名稱、人名及分數，已核對分享範圍。</span>
      </>} />
      {confirmed && approved && enabled && (
        <>
          <canvas ref={canvas} hidden aria-hidden="true" />
          {error ? (
            <div role="alert">
              <Text>{error}</Text>
              <Button onClick={() => void(async()=>{if((!beforeShare||await beforeShare())&&active.current&&latest.current===signature)setAttempt(n=>n+1);})()}>重新產生圖片</Button>
            </div>
          ) : ready ? (
            <>
              <img src={ready.url} alt="分房試算；完整人員與分數見分房清單" />
              <div className="page-actions">
                <Button onClick={()=>void download()}>下載分房圖片</Button>
                <Button variant="secondary" onClick={() => void share()}>
                  分享分房圖片
                </Button>
              </div>
            </>
          ) : (
            <Notice>正在產生分房圖片…</Notice>
          )}
          <Field className="account-field" label={<>
            分房清單

          </>}><textarea readOnly rows={5} value={text} /></Field>
          <Button
            variant="secondary"
            onClick={() => {
              void Promise.resolve()
                .then(async () => {
                  if(beforeShare&&!await beforeShare()||latest.current!==signature)return false;
                  if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
                  await navigator.clipboard.writeText(text);return true;
                })
                .then(copied => {
                  if (copied && active.current && latest.current === signature) setMessage(uiText("已複製分房清單。"));
                })
                .catch(() => {
                  if (active.current && latest.current === signature)
                    setMessage(uiText("無法自動複製，請選取分房清單手動複製。"));
                });
            }}
          >
            複製分房清單
          </Button>
        </>
      )}
      {message && <Text role="status">{message}</Text>}
    </section>
  );
}
