import { useState } from 'react';
import { Button, Text } from 'yahha-ui';
export function CopyMusicValue({ value, label }: { value: string; label: string }) {
  const [message, setMessage] = useState('');
  async function copy() {
    try { await navigator.clipboard.writeText(value); setMessage('已複製' + label + '。'); }
    catch { setMessage('無法自動複製，請選取' + label + '手動複製。'); }
  }
  return <div className="music-copy"><Button variant="secondary" onClick={() => void copy()}>複製{label}</Button>
    {message && <Text role="status">{message}</Text>}</div>;
}
