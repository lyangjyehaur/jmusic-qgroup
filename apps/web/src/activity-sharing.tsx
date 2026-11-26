import { uiText } from './language';
import { useEffect, useId, useRef, useState } from 'react';
import { Text } from 'yahha-ui';
import { Button, Field } from './kimi-ui';

export function ActivityLocation({ value }: { value: string }) {
  return <>{value}{value.trim() && <> <a className="text-link" href={'https://uri.amap.com/search?keyword=' + encodeURIComponent(value)} target="_blank" rel="noopener noreferrer">高德導航</a></>}</>;
}

export function CopyActivityText({ text, label, button, rows = 10 }: { text: string; label: string; button: string; rows?: number }) {
  const id = useId(), field = useRef<HTMLTextAreaElement>(null), operation = useRef(0);
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { operation.current++; setMessage(''); setBusy(false); return () => { operation.current++; }; }, [text]);
  async function copy() {
    if (busy) return;
    const current = ++operation.current;
    setBusy(true); setMessage('');
    try {
      if (!navigator.clipboard?.writeText) throw Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      if (current === operation.current) setMessage(uiText("已複製") + label + '。');
    } catch {
      if (current !== operation.current) return;
      field.current?.focus(); field.current?.select(); setMessage(uiText("請選取") + label + uiText("手動複製。"));
    } finally { if (current === operation.current) setBusy(false); }
  }
  return <div className="activity-copy-field"><Field className="device-link-field" label={label}><textarea ref={field} id={id} readOnly value={text} rows={rows} onFocus={event => event.target.select()} /></Field><Button loading={busy} disabled={busy} onClick={() => void copy()}>{button}</Button>{message && <Text role="status">{message}</Text>}</div>;
}
