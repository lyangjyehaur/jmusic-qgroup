import { uiText } from './language';
import { useState } from 'react';
import { Text } from 'yahha-ui';
import { Button } from './kimi-ui';
import { Copy } from 'lucide-react';
export function ContactValue({ number, compact=false }: { number: string; source?: 'legacy' | 'self_reported' | ''; compact?:boolean }) {
  const [message, setMessage] = useState('');
  async function copy() {
    try { await navigator.clipboard.writeText(number); setMessage(uiText("已複製 QQ。")); }
    catch { setMessage(uiText("無法自動複製，請選取號碼手動複製。")); }
  }
  return number ? <div className="contact-value"><Text>{number}</Text><Button variant={compact?'ghost':'secondary'} size={compact?'sm':'md'} aria-label="複製 QQ" title="複製 QQ" onClick={() => void copy()}>{compact?<Copy size={14}/>:<>複製 QQ</>}</Button>{message && <Text role="status">{message}</Text>}</div> : <Text>尚未填寫 QQ。</Text>;
}
