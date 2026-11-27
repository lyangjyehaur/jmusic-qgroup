import { uiText } from './language';
import { musicShareLines, type SharePick } from '@qgroup/domain';
import type { z } from 'zod';
import type { MusicShareContext } from '@qgroup/contracts';
export type ShareCard = {
  context: z.infer<typeof MusicShareContext>; picks: SharePick[]; origin: string;
  contact: boolean; topMatch: boolean; topContact: boolean; dark: boolean; draft: boolean;
};
type TextRow = { text: string; x: number; y: number; size: number; bold: boolean; muted: boolean };
/** No external assets, HTML, credentials or arbitrary source fields are rendered. */
export function drawMusicShare(canvas: HTMLCanvasElement, input: ShareCard) {
  const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('瀏覽器無法產生圖片；仍可複製下方詞條清單。');
  const width = 720, padding = 48, rows: TextRow[] = [], tiles:{x:number;y:number;width:number;height:number;top:boolean}[]=[]; let y = 40;
  const font = (size: number, bold = false) => `${bold ? 700 : 400} ${size}px -apple-system, BlinkMacSystemFont, "PingFang TC", "Microsoft JhengHei", sans-serif`;
  const text = (value: string, size = 24, bold = false, muted = false, maxLines = 2) => {
    ctx.font = font(size, bold);
    const lines = musicShareLines(value, width - padding * 2, maxLines, value => ctx.measureText(value).width);
    for (const line of lines) { rows.push({ text: line, x: padding, y, size, bold, muted }); y += Math.ceil(size * 1.45); }
  };
  text(uiText('群聚・我的音樂成分'), 22, true); y += 24;
  text(input.context.name, 36, true);
  if (input.contact && input.context.contactQQ) text(uiText('聯絡 QQ：') + input.context.contactQQ, 19, false, true);
  text(`${input.picks.length}${uiText(" 項")}${input.draft ? uiText(' · 目前草稿') : uiText(' · 已保存成分')}`, 21, false, true); y += 20;
  for (const kind of ['main', 'sub'] as const) {
    const picks = input.picks.filter(pick => pick.kind === kind); if (!picks.length) continue;
    text((kind === 'main' ? uiText('領域') : uiText('細分')) + ' · ' + picks.length + uiText(' 項'), 19, true); y += 8;
    const tileWidth=(width-padding*2-12)/2;
    for (let i=0;i<picks.length;i+=2) {
      const pair=picks.slice(i,i+2),names=pair.map(pick=>{ctx.font=font(21,true);return musicShareLines(pick.name,tileWidth-24,3,value=>ctx.measureText(value).width);});
      const tileHeight=Math.max(...names.map(lines=>lines.length))*30+50;
      pair.forEach((pick,index)=>{
        const x=padding+index*(tileWidth+12);tiles.push({x,y,width:tileWidth,height:tileHeight,top:pick.level===4});
        names[index]!.forEach((line,row)=>rows.push({text:line,x:x+12,y:y+12+row*30,size:21,bold:true,muted:false}));
        const detail=({1:uiText('只聽過幾首'),2:uiText('聽過一些'),3:uiText('常聽'),4:uiText('本命')}[pick.level]??'')+' · '+pick.count+uiText(' 人選用');
        rows.push({text:detail,x:x+12,y:y+tileHeight-28,size:16,bold:false,muted:true});
      });
      y+=tileHeight+12;
    }
    y += 12;
  }
  const top = input.topMatch ? input.context.topMatch : null;
  if (top) {
    y += 8; text(uiText('推薦同好 · ') + (input.context.sort === 'familiar' ? uiText('我的熟悉度優先') : uiText('共同項／冷門優先')), 21, false, true);
    text(top.name, 28, true);
    if (input.topContact && top.contactQQ) text(uiText('聯絡 QQ：') + top.contactQQ, 19, false, true);
    text(`${uiText("匹配度 ")}${top.matchPercent}${uiText("% · ")}${top.sharedCount}${uiText(" 個共同詞條")}`, 22); y += 16;
  }
  text(new URL('/music', input.origin).href, 19, false, true);
  const height = Math.max(480,Math.ceil(y + 32));
  canvas.width = width * 2; canvas.height = height * 2;
  ctx.scale(2, 2); ctx.fillStyle = input.dark ? '#2d4434' : '#f5f4ef'; ctx.fillRect(0, 0, width, height);
  for(const tile of tiles){ctx.fillStyle=input.dark?(tile.top?'#6c7950':'#354f3e'):(tile.top?'#e2e9d6':'#ebeee6');ctx.fillRect(tile.x,tile.y,tile.width,tile.height);ctx.strokeStyle=input.dark?'#627565':'#d9ddd2';ctx.strokeRect(tile.x,tile.y,tile.width,tile.height);}
  ctx.textBaseline = 'top';
  for (const row of rows) {
    ctx.font = font(row.size, row.bold); ctx.fillStyle = input.dark ? row.muted ? '#ccd5ca' : '#f4f6f0' : row.muted ? '#6e7569' : '#29332b';
    ctx.fillText(row.text, row.x, row.y);
  }
  return { width, height, lines: rows.map(row => row.text) };
}
export function musicShareBlob(canvas: HTMLCanvasElement, signal?: AbortSignal) {
  return new Promise<Blob>((resolve, reject) => {
    let settled=false,timer:ReturnType<typeof setTimeout>|undefined;
    const failure=()=>new Error('圖片轉換失敗；仍可複製詞條清單或重試。');
    function finish(blob?:Blob,error?:Error){
      if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
      if(blob)resolve(blob);else reject(error??failure());
    }
    function abort(){finish(undefined,new DOMException('Image conversion cancelled','AbortError'));}
    if(signal?.aborted){abort();return;}signal?.addEventListener('abort',abort,{once:true});
    // Some browsers defer idle PNG encoding indefinitely. A bounded fallback
    // serializes this generation's bitmap; a late native callback cannot replace it.
    timer=setTimeout(()=>{
      try{
        const prefix='data:image/png;base64,',data=canvas.toDataURL('image/png');
        if(!canvas.width||!canvas.height||!data.startsWith(prefix))throw failure();
        const bytes=Uint8Array.from(atob(data.slice(prefix.length)),char=>char.charCodeAt(0));
        finish(new Blob([bytes],{type:'image/png'}));
      }catch{finish();}
    },1500);
    try { canvas.toBlob(blob=>finish(blob??undefined),'image/png'); }
    catch { finish(); }
  });
}
