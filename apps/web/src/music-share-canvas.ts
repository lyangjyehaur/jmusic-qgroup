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
  const width = 720, padding = 48, rows: TextRow[] = []; let y = 56;
  const font = (size: number, bold = false) => `${bold ? 700 : 400} ${size}px -apple-system, BlinkMacSystemFont, "PingFang TC", "Microsoft JhengHei", sans-serif`;
  const text = (value: string, size = 24, bold = false, muted = false, maxLines = 2) => {
    ctx.font = font(size, bold);
    const lines = musicShareLines(value, width - padding * 2, maxLines, value => ctx.measureText(value).width);
    for (const line of lines) { rows.push({ text: line, x: padding, y, size, bold, muted }); y += Math.ceil(size * 1.45); }
  };
  text('音樂成分', 26, true); y += 12;
  text(input.context.name, 36, true);
  if (input.context.profileId) text('成分 ID：' + input.context.profileId, 18, false, true);
  if (input.contact && input.context.contactQQ) text('聯絡 QQ：' + input.context.contactQQ + '（未經騰訊驗證）', 19, false, true);
  text(`${input.picks.length} 項${input.draft ? ' · 目前草稿' : ' · 已保存成分'}`, 21, false, true); y += 20;
  for (const kind of ['main', 'sub'] as const) {
    const picks = input.picks.filter(pick => pick.kind === kind); if (!picks.length) continue;
    text((kind === 'main' ? '領域' : '細分') + ' · ' + picks.length + ' 項', 25, true); y += 8;
    for (const pick of picks) {
      text(pick.name, kind === 'main' ? 30 : 26, true, false, 3);
      text((kind === 'sub' ? ({ 1: '只聽過幾首', 2: '聽過一些', 3: '常聽', 4: '本命' }[pick.level] ?? '') + ' · ' : '') + pick.count + ' 人選用', 20, false, true);
      y += 14;
    }
    y += 12;
  }
  const top = input.topMatch ? input.context.topMatch : null;
  if (top) {
    y += 8; text('推薦同好 · ' + (input.context.sort === 'familiar' ? '我的熟悉度優先' : '共同項／冷門優先'), 21, false, true);
    text(top.name, 28, true); text('成分 ID：' + top.id, 18, false, true);
    if (input.topContact && top.contactQQ) text('聯絡 QQ：' + top.contactQQ + '（未經騰訊驗證）', 19, false, true);
    text(`匹配度 ${top.matchPercent}% · ${top.sharedCount} 個共同詞條`, 22); y += 16;
  }
  text(new URL('/music', input.origin).href, 19, false, true);
  const height = Math.ceil(y + 32);
  canvas.width = width * 2; canvas.height = height * 2;
  ctx.scale(2, 2); ctx.fillStyle = input.dark ? '#171e28' : '#ffffff'; ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = 'top';
  for (const row of rows) {
    ctx.font = font(row.size, row.bold); ctx.fillStyle = input.dark ? row.muted ? '#b8c7dc' : '#f2f6fc' : row.muted ? '#47566b' : '#182a44';
    ctx.fillText(row.text, row.x, row.y);
  }
  return { width, height, lines: rows.map(row => row.text) };
}
export function musicShareBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    try { canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('圖片轉換失敗；仍可複製詞條清單或重試。')), 'image/png'); }
    catch { reject(new Error('圖片轉換失敗；仍可複製詞條清單或重試。')); }
  });
}
