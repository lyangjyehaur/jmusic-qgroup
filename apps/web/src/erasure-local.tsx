import { useEffect, useRef, useState } from 'react';
import { Button, Surface, Text } from 'yahha-ui';
import { parseErasure, type ErasureValue } from './erasure-record';
import { migrateErasure, observeErasures, readErasure, replaceRaw, writeErasure } from './erasure-store';
export function useErasureLocal<T extends ErasureValue>(key: string, legacyKey: string, convert: (raw: string) => T) {
  const active = useRef(false), rawRef = useRef<string | null>(null), busyRef = useRef(false), generation = useRef(0);
  const [value, setValue] = useState<T | null>(null), [ready, setReady] = useState(false), [error, setError] = useState(''), [damaged, setDamaged] = useState<{ raw: string; legacy: boolean } | null>(null), [busy, setBusy] = useState(false);
  async function refresh() {
    const run = ++generation.current;
    try {
      const raw = await migrateErasure(key, legacyKey, convert);
      if (!active.current || run !== generation.current) return;
      rawRef.current = raw;
      try { setValue(raw === null ? null : parseErasure(key, raw) as T); setDamaged(null); setError(''); }
      catch { setValue(null); setDamaged({ raw: raw!, legacy: false }); setError('刪除紀錄無法辨識。請下載原紀錄，再明確清除；不會自動提交刪除。'); }
    } catch {
      if (!active.current || run !== generation.current) return;
      let source: string | null = null;
      try { source = sessionStorage.getItem(legacyKey); } catch { /* Storage unavailable. */ }
      setError('無法讀取刪除操作紀錄，請檢查瀏覽器儲存設定後重新讀取。');
      if (source !== null) setDamaged({ raw: source, legacy: true });
    } finally { if (active.current && run === generation.current) setReady(true); }
  }
  useEffect(() => {
    active.current = true; void refresh();
    const stop = observeErasures(() => { if (!busyRef.current) void refresh(); });
    return () => { active.current = false; generation.current++; stop(); };
  }, [key, legacyKey]);
  function begin() { if (busyRef.current || !ready || damaged || error) return false; generation.current++; busyRef.current = true; setBusy(true); return true; }
  function end() { busyRef.current = false; if (active.current) setBusy(false); }
  async function save(next: T | null) {
    const raw = await writeErasure(key, rawRef.current, next); rawRef.current = raw;
    if (active.current) { setValue(next); setError(''); }
  }
  async function assertCurrent() { if (await readErasure(key) !== rawRef.current) throw Error('其他分頁已更新原操作，請重新讀取。'); }
  async function clearDamaged() {
    if (!damaged || busyRef.current) return;
    try {
      if (damaged.legacy) { if (sessionStorage.getItem(legacyKey) !== damaged.raw) throw Error(); sessionStorage.removeItem(legacyKey); }
      else await replaceRaw(key, damaged.raw, null);
      await refresh();
    } catch { setError('無法清除原紀錄；原文仍保留，請重新讀取。'); }
  }
  return { value, ready, error, damaged, busy, active, begin, end, save, assertCurrent, refresh, clearDamaged };
}
export function ErasureStorageFeedback({ record }: { record: Pick<ReturnType<typeof useErasureLocal>, 'error' | 'damaged' | 'refresh' | 'clearDamaged'> }) {
  const [downloaded, setDownloaded] = useState('');
  return record.error ? <Surface role="alert"><Text>{record.error}</Text>{record.damaged && <><Text>原紀錄可能含刪除回執憑證，請妥善保管下載檔。</Text><Button onClick={() => {
    const raw = record.damaged!.raw, url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'qgroup-erasure-recovery.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); setDownloaded(raw);
  }}>下載原刪除紀錄</Button><Button variant="secondary" disabled={downloaded !== record.damaged.raw} onClick={() => void record.clearDamaged()}>已保全，清除原紀錄</Button></>}<Button variant="secondary" onClick={() => void record.refresh()}>重新讀取刪除紀錄</Button></Surface> : null;
}
