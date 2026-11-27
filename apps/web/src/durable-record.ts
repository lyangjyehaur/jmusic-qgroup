import { errorText, uiText } from './language';
import { useEffect, useRef, useState, type SetStateAction } from 'react';
import { useBlocker, type BlockerFunction } from 'react-router-dom';
import { DraftConflict, DraftExpired, discardDraft, draftVersions, openDraft, retireDraft, saveDraft, type DraftHandle, type DraftVersion } from './draft-store';
/** Browser persistence only; each caller keeps its own business validation and exact pending format. */
type RecordOptions<T> = {
  key: string; scope: string; seed: () => T; parse: (raw: string) => T;
  serialize?: (value: T) => string; dirty: (value: T) => boolean;
  pending: (value: T) => boolean;
  // Clean saved placeholders can acquire a new URL preset without restoring old user input.
  needsRestore?: (raw: string) => boolean;
};
export function useDurableValue<T>(options: RecordOptions<T>) {
  const [value, rawSetValue] = useState(options.seed), current = useRef(value), active = useRef(true),
    handle = useRef<DraftHandle | null>(null), queue = useRef(Promise.resolve()), revoked = useRef(false), halted = useRef(false),
    optionsRef = useRef(options), unavailableRef = useRef(true), busyRef = useRef(false);
  optionsRef.current = options;
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(0), [busy, rawSetBusy] = useState(false),
    [readError, setReadError] = useState(''), [damagedRaw,setDamagedRaw]=useState<string|null>(null), [storageError, setStorageError] = useState(''), [message, setMessage] = useState(''),
    [needsRestore, setNeedsRestore] = useState(false), [conflict, setConflict] = useState(false), [expired, setExpired] = useState(false),
    [versions, setVersions] = useState<DraftVersion[]>([]), [epoch, setEpoch] = useState(0);
  const unavailable = loading || needsRestore || !!readError;
  unavailableRef.current = unavailable;
  const dirty = options.dirty(value) || options.pending(value), locked = unavailable || busy || options.pending(value);
  // Some baselines arrive asynchronously. A no-op record must not remain locked
  // behind a restore prompt after its actual values have been verified as clean.
  useEffect(() => { if (needsRestore && !dirty && !readError) setNeedsRestore(false); }, [needsRestore, dirty, readError]);
  const encode = (next: T) => optionsRef.current.serialize?.(next) ?? JSON.stringify(next);
  function replace(next: T) { current.current = next; rawSetValue(next); }
  function setBusy(next: boolean) { busyRef.current = next; rawSetBusy(next); }
  async function loadVersions() { const rows = await draftVersions(options.key, options.scope); if (active.current) setVersions(rows); }
  function apply(raw: string | null) {
    setConflict(false);
    try {
      const next = raw === null ? optionsRef.current.seed() : optionsRef.current.parse(raw);
      replace(next); setReadError(''); setDamagedRaw(null); setNeedsRestore(raw !== null && !optionsRef.current.pending(next) && (optionsRef.current.needsRestore?.(raw) ?? optionsRef.current.dirty(next)));
      if(raw === null && optionsRef.current.dirty(next)) void persist(next); setEpoch(n => n + 1);
    } catch { setDamagedRaw(raw); setReadError(uiText("無法讀取原稿，請先保全原稿再繼續。")); }
  }
  useEffect(() => {
    active.current = true; let cancelled = false;
    void (async () => {
      try {
        const saved = await openDraft(options.key, options.scope);
        if (cancelled) return;
        handle.current = saved.handle; apply(saved.raw); await loadVersions();
      } catch { if (!cancelled) setReadError(uiText("無法讀取原稿，請先保全原稿再繼續。")); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; active.current = false; };
  }, [options.key, options.scope]);
  async function failure(error: unknown, text: string) {
    if (error instanceof DraftConflict || error instanceof DraftExpired) {
      halted.current = true; if (error instanceof DraftExpired) revoked.current = true;
      if (active.current) { setReadError(errorText(error)); setConflict(error instanceof DraftConflict); setExpired(error instanceof DraftExpired); await loadVersions().catch(() => {}); }
    } else if (active.current) setStorageError(text);
  }
  function enqueue(work: (loaded: DraftHandle) => Promise<DraftHandle>, text: string) {
    setSaving(n => n + 1);
    const result = queue.current.then(async () => {
      if (revoked.current || !handle.current) return false;
      try { handle.current = await work(handle.current); if (active.current) setStorageError(''); return true; }
      catch (error) { await failure(error, text); return false; }
    });
    queue.current = result.then(() => {});
    void result.finally(() => { if (active.current) setSaving(n => n - 1); });
    return result;
  }
  function persist(next: T, preserve = false, text = uiText("無法保存原稿及操作編號，尚未送出。")) {
    const raw = encode(next);
    return enqueue(loaded => saveDraft(loaded, raw, preserve), text);
  }
  function change(action: SetStateAction<T>) {
    if (busyRef.current || unavailableRef.current || halted.current || optionsRef.current.pending(current.current)) return;
    const next = typeof action === 'function' ? (action as (old: T) => T)(current.current) : action;
    replace(next); void persist(next); setMessage('');
  }
  function begin() { if (busyRef.current || unavailableRef.current || halted.current) return false; setBusy(true); return true; }
  async function retire(target?: { key: string; value: T }) {
    const sourceRaw = encode(current.current), destination = target ? {key:target.key,raw:encode(target.value)} : undefined;
    return enqueue(loaded => retireDraft(loaded, sourceRaw, destination), uiText('操作已完成，但無法保存本機確認狀態；原操作仍保留。'));
  }
  async function recover() {
    if (busyRef.current || loading) return; setBusy(true);
    try {
      await queue.current;
      if (conflict) {
        const saved = await openDraft(options.key, options.scope); handle.current = saved.handle; halted.current = false; apply(saved.raw);
      } else {
        if (!handle.current) handle.current = (await openDraft(options.key, options.scope)).handle;
        const blank = optionsRef.current.seed(); if (!await persist(blank, true)) return;
        replace(blank); setReadError(''); setDamagedRaw(null); setNeedsRestore(false); setEpoch(n => n + 1);
      }
      await loadVersions();
    } catch { setStorageError(uiText("仍無法保全原稿，請檢查瀏覽器儲存設定。")); }
    finally { if (active.current) setBusy(false); }
  }
  async function restoreVersion(id: string) {
    if (busyRef.current || loading || readError) return;
    const version = versions.find(row => row.id === id); if (!version) return;
    let next: T; try { next = optionsRef.current.parse(version.raw); } catch { setMessage(uiText("這份原稿格式無法讀取，請下載保全檔。")); return; }
    setBusy(true);
    try { if (await persist(next, true)) { replace(next); setNeedsRestore(false); setEpoch(n => n + 1); setMessage(uiText("已載入保全版本；請核對原操作與最新資料。")); await loadVersions(); } }
    finally { if (active.current) setBusy(false); }
  }
  async function canLeave() {
    if (loading || busyRef.current) return false;
    await queue.current;
    return !!readError || halted.current || await persist(current.current);
  }
  async function discard() {
    if (loading || busyRef.current || readError || optionsRef.current.pending(current.current)) return false;
    setBusy(true);
    try {
      await queue.current;
      if (halted.current || revoked.current || !handle.current || optionsRef.current.pending(current.current)) return false;
      const cleared = await enqueue(discardDraft, uiText('尚未捨棄草稿，請重試；目前內容仍保留。'));
      if (!cleared || !active.current) return false;
      replace(optionsRef.current.seed()); setNeedsRestore(false); setMessage(''); setEpoch(n => n + 1);
      return true;
    } finally { if (active.current) setBusy(false); }
  }
  return { value, change, replace, persist, retire, begin, unavailable, locked, busy, setBusy, active, dirty,
    loading, saving:!!saving, readError, damagedRaw, storageError, message, setMessage, needsRestore, restore:() => {setNeedsRestore(false); setEpoch(n => n + 1);},
    conflict, expired, versions, recover, restoreVersion, refreshVersions:loadVersions, canLeave, discard,
    hasPending:options.pending(value), canDiscard:!loading&&!busy&&!readError&&!options.pending(value), epoch };
}

/** A page owns one router blocker, including any nested memory-only operation. */
export function useDurableRecord<T>(options: RecordOptions<T> & { blocking?: boolean | BlockerFunction; extraDirty?: boolean }) {
  const form = useDurableValue(options), dirty = form.dirty || !!options.extraDirty;
  const blocker = useBlocker(transition => (dirty || form.busy || !!form.readError || !!form.storageError) && (typeof options.blocking === 'function' ? options.blocking(transition) : options.blocking !== false));
  async function leave() { const proceed = blocker.proceed; if (await form.canLeave()) proceed?.(); }
  async function discardAndLeave() { const proceed = blocker.proceed; if (await form.discard()) proceed?.(); }
  useEffect(() => {
    if ((!dirty && !form.busy && !form.readError && !form.storageError) || options.blocking === false) return;
    const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', leave); return () => window.removeEventListener('beforeunload', leave);
  }, [dirty, form.busy, form.readError, form.storageError, options.blocking]);
  return { ...form, blocker, leave, discardAndLeave };
}
