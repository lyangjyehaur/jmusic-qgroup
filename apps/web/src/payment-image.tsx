import { errorText, uiText } from './language';
import { useEffect, useState } from 'react';
import { Button, Text } from 'yahha-ui';
import { ApiFailure } from '@qgroup/contracts';
import { ApiError } from './api';

function dataURL(blob: Blob) {
  return new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('圖片無法讀取')); reader.readAsDataURL(blob); });
}
/** Convert locally; the server never fetches user-supplied image URLs. */
export async function preparePaymentImage(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('請選擇 PNG、JPEG 或 WebP 圖片');
  if (file.size > 15 * 1024 * 1024) throw new Error('原始圖片超過 15 MB，請先裁剪');
  const url = await dataURL(file), image = new Image();
  try {
    image.src = url; try { await image.decode(); } catch { throw new Error('圖片無法讀取，請重新選擇'); }
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('圖片無法讀取，請重新選擇');
    let scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight)); const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d'); if (!context) throw new Error('瀏覽器無法處理圖片，請換一個瀏覽器重試');
    for (let attempt = 0; attempt < 4; attempt++) {
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const result = canvas.toDataURL('image/png').split(',')[1]!;
      if (atob(result).length <= 2 * 1024 * 1024) return result;
      scale *= .75;
    }
    throw new Error('轉換後圖片超過 2 MB，請裁剪後重試');
  } catch (failure) { throw failure instanceof Error ? failure : new Error('圖片無法讀取，請重新選擇'); }
}
/** Scoped fetch prevents a delayed image response from being shown under a switched account. */
export function PaymentAssetImage({ url, scope, label, filename = 'payment-code.png' }: { url: string; scope?: string; label: string; filename?: string }) {
  const [attempt, setAttempt] = useState(0), [image, setImage] = useState<{ url: string; scope?: string; data: string }>(), [error, setError] = useState(''), [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); let active = true; setImage(undefined); setError(''); setExpanded(false);
    void (async () => {
      try {
        const response = await fetch(url, { credentials: 'same-origin', headers: scope ? { 'X-Account-Scope': scope } : {}, signal: controller.signal });
        if (!response.ok) { const parsed = ApiFailure.safeParse(await response.json()); throw new ApiError(response.status, parsed.success ? parsed.data.code : 'IMAGE_READ', parsed.success ? parsed.data.message : '圖片暫時無法讀取'); }
        if (!response.headers.get('Content-Type')?.startsWith('image/png')) throw new Error('圖片回應格式不正確，請重試');
        const data = await dataURL(await response.blob()); if (active) setImage({ url, scope, data });
      } catch (failure) { if (active) setError(failure instanceof Error ? errorText(failure) : uiText("圖片無法讀取")); }
    })();
    return () => { active = false; controller.abort(); };
  }, [url, scope, attempt]);
  const data = image?.url === url && image.scope === scope ? image.data : undefined;
  return <div className="payment-asset">{error ? <div role="alert"><Text>{error}</Text><Button variant="secondary" onClick={() => setAttempt(value => value + 1)}>重試圖片</Button></div> : data ? <>
    <img className={expanded ? 'payment-asset-original' : 'payment-asset-thumb'} src={data} alt={label} onError={() => setError(uiText("圖片無法顯示，請重試"))} />
    <div className="page-actions"><Button variant="secondary" onClick={() => setExpanded(value => !value)}>{expanded ? '收起原圖' : '查看原圖'}</Button><a href={data} download={filename}>下載原圖</a></div>
  </> : <Text role="status">正在讀取圖片…</Text>}</div>;
}
