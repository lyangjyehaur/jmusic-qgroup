import { useState } from 'react';
import { Button, Text } from 'yahha-ui';
export function ContactValue({ number, source }: { number: string; source: 'legacy' | 'self_reported' | '' }) {
  const [message, setMessage] = useState('');
  async function copy() {
    try { await navigator.clipboard.writeText(number); setMessage('已複製聯絡 QQ。'); }
    catch { setMessage('無法自動複製，請選取號碼手動複製。'); }
  }
  return number ? <div className="contact-value"><Text>{number} · {source === 'legacy' ? '舊成分查詢號碼' : '自填號碼'}，未經騰訊驗證</Text><Button variant="secondary" onClick={() => void copy()}>複製聯絡 QQ</Button>{message && <Text role="status">{message}</Text>}</div> : <Text>尚未填寫聯絡 QQ。</Text>;
}
