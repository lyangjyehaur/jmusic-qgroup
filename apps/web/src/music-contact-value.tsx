import { uiText } from './language';
import { useState } from 'react';
import { Text } from 'yahha-ui';
import { Button } from './kimi-ui';
import { Copy } from 'lucide-react';
export function ContactValue({ number, source, compact=false }: { number: string; source: 'legacy' | 'self_reported' | ''; compact?:boolean }) {
  const [message, setMessage] = useState('');
  async function copy() {
    try { await navigator.clipboard.writeText(number); setMessage(uiText("已複製聯絡 QQ。")); }
    catch { setMessage(uiText("無法自動複製，請選取號碼手動複製。")); }
  }
  return number ? <div className="contact-value"><Text>{number} · {source === 'legacy' ? '舊成分查詢號碼' : '自填號碼'}，未經騰訊驗證</Text><Button variant={compact?'ghost':'secondary'} size={compact?'sm':'md'} aria-label="複製聯絡 QQ" title="複製聯絡 QQ" onClick={() => void copy()}>{compact?<Copy size={14}/>:<>複製聯絡 QQ</>}</Button>{message && <Text role="status">{message}</Text>}</div> : <Text>尚未填寫聯絡 QQ。</Text>;
}
