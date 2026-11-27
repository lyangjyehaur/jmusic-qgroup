import { uiText } from './language';
import { Copy } from 'lucide-react';
import { useState } from 'react';
import { Text } from 'yahha-ui';
import { Button } from './kimi-ui';
export function CopyMusicValue({ value, label, compact=false, onMessage }: { value: string; label: string; compact?: boolean; onMessage?:(message:string)=>void }) {
  const copyLabel = '複製'+(label==='QQ'?' ':'')+label;
  const [message, setMessage] = useState('');
  async function copy() {
    const report=onMessage??setMessage;
    try { await navigator.clipboard.writeText(value); report(uiText("已複製") + label + '。'); }
    catch { report(uiText("無法自動複製，請選取") + label + uiText("手動複製。")); }
  }
  return <div className="music-copy"><Button variant={compact?"ghost":"secondary"} size={compact?"sm":"md"} aria-label={copyLabel} title={copyLabel} onClick={() => void copy()}>{compact?<Copy size={14}/>:<>{copyLabel}</>}</Button>
    {message && <Text role="status">{message}</Text>}</div>;
}
