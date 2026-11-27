import { errorText, uiText } from './language';
import { useEffect, useRef, useState } from 'react';
import { useBlocker } from 'react-router-dom';
import { z } from 'zod';
import type { Member } from './member-access';
import { ApiError } from './api';
import { DraftConflict, DraftExpired, discardDraft, draftVersions, openDraft, saveDraft, type DraftHandle, type DraftVersion } from './draft-store';
import { sameDraftValue } from './draft-equality';
/** Persist the exact account-scoped payload before sending; uncertain delivery requires an explicit retry. */
export function useReviewedDraft<T, S, F>(options: {
  key: string; viewer: Member; initial: F;
  blank: (fresh: F) => T;
  valueSchema: z.ZodType<T>; saveSchema: z.ZodType<S>;
  send: (input: S, requestId: string) => Promise<unknown>; latest: (result?: unknown) => Promise<F>;
  matches: (value: T, input: S) => boolean; fromPending: (input: S) => T;
  after?: (fresh: F, result?: unknown) => void; afterRefresh?: (fresh: F) => void;
  beforeSubmit?: () => Promise<void>;
  preserveBeforeSubmit?: boolean;
  sameValue?: (value: T, baseline: T) => boolean;
}) {
  const { key, viewer } = options,
    active = useRef(true), handle = useRef<DraftHandle | null>(null), queue = useRef(Promise.resolve()),
    halted = useRef(false), revoked = useRef(false), submitting = useRef(false),
    schema = z.object({
      value: options.valueSchema, baseline: options.valueSchema.optional(), dirty: z.boolean(),
      pending: z.object({ key: z.string().uuid(), input: options.saveSchema }).strict().optional(),
    }).strict().refine(v => !v.pending || options.matches(v.value, v.pending.input));
  type Draft = z.infer<typeof schema>;
  function parse(raw: string): Draft {
    let saved = JSON.parse(raw);
    if (saved && saved.value === undefined) {
      const compact = z.object({ dirty: z.boolean(), pending: z.object({ key: z.string().uuid(), input: options.saveSchema }).strict() }).strict().parse(saved);
      saved = { ...compact, value: options.fromPending(compact.pending.input) };
    }
    return schema.parse(saved);
  }
  const [draft, setDraft] = useState<Draft>(() => ({ value: options.blank(options.initial), dirty: false })),
    [data, setData] = useState(options.initial), [loading, setLoading] = useState(true),
    [needsRestore, setNeedsRestore] = useState(false), [readError, setReadError] = useState(''),
    [storageError, setStorageError] = useState(''), [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false), [saving, setSaving] = useState(0), [epoch, setEpoch] = useState(0),
    [conflict, setConflict] = useState(false), [expired, setExpired] = useState(false), [versions, setVersions] = useState<DraftVersion[]>([]);
  const baseline = useRef(draft.value), currentData = useRef(data);
  currentData.current = data;
  const sameValue = options.sameValue ?? sameDraftValue;
  const dirty = draft.dirty || !!draft.pending,
    blocker = useBlocker(dirty || busy || !!readError || !!storageError),
    locked = loading || needsRestore || busy || !!readError || !!draft.pending;
  async function loadVersions() {
    const rows = await draftVersions(key, viewer.scope);
    if (active.current) setVersions(rows);
  }
  function applyRaw(raw: string | null) {
    setConflict(false);
    try {
      const saved: Draft = raw === null ? { value: baseline.current, dirty: false } : parse(raw);
      baseline.current = saved.baseline ?? (!saved.dirty && !saved.pending ? saved.value : options.blank(currentData.current));
      let next = { ...saved, baseline: baseline.current, dirty: !sameValue(saved.value, baseline.current) };
      if(raw!==null&&!next.dirty&&!next.pending){baseline.current=options.blank(currentData.current);next={value:baseline.current,baseline:baseline.current,dirty:false};}
      setDraft(next); setNeedsRestore(next.dirty && !next.pending); setReadError(''); setConflict(false);
      setEpoch(n => n + 1);
    } catch { setReadError(uiText("無法讀取原稿，請先保全原稿再繼續。")); }
  }
  useEffect(() => {
    active.current = true; let cancelled = false;
    void (async () => {
      try {
        const saved = await openDraft(key, viewer.scope);
        if (cancelled) return;
        handle.current = saved.handle; halted.current = false; applyRaw(saved.raw);
        await loadVersions();
      } catch { if (!cancelled) setReadError(uiText("無法讀取原稿，請先保全原稿再繼續。")); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; active.current = false; };
  }, [key, viewer.scope]);
  function persist(next: Draft, preserve = false, failureText = uiText("無法保存原稿及操作編號，尚未送出。")) {
    const raw = JSON.stringify(next.pending ? { dirty: next.dirty, pending: next.pending } : next);
    setSaving(n => n + 1);
    const work = queue.current.then(async () => {
      // Writes already queued before a conflict must also be preserved. Revoked data must never return.
      if (revoked.current || !handle.current) return false;
      try {
        handle.current = await saveDraft(handle.current, raw, preserve);
        if (active.current) setStorageError('');
        return true;
      } catch (error) {
        if (error instanceof DraftConflict || error instanceof DraftExpired) {
          halted.current = true;
          if (error instanceof DraftExpired) revoked.current = true;
          if (active.current) {
            setReadError(errorText(error)); setConflict(error instanceof DraftConflict); setExpired(error instanceof DraftExpired);
            await loadVersions().catch(() => {});
          }
        } else if (active.current) setStorageError(failureText);
        return false;
      }
    });
    queue.current = work.then(() => {});
    void work.finally(() => { if (active.current) setSaving(n => n - 1); });
    return work;
  }
  useEffect(() => {
    if (!dirty && !busy && !readError && !storageError) return;
    const leave = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', leave);
    return () => window.removeEventListener('beforeunload', leave);
  }, [dirty, busy, readError, storageError]);
  function edit(value: T, userEdit = true) {
    if (locked || halted.current || submitting.current) return;
    if (!userEdit && !draft.dirty) baseline.current = value;
    const next = { ...draft, value, baseline: baseline.current, dirty: !sameValue(value, baseline.current) };
    setDraft(next); if (next.dirty || draft.dirty) void persist(next); setEpoch(n => n + 1); setMessage('');
  }
  async function refresh(rebase: (old: T, fresh: F) => T) {
    if (locked || halted.current) return;
    setBusy(true);
    try {
      const fresh = await options.latest();
      if (!active.current) return;
      const freshBaseline = options.blank(fresh), value = rebase(draft.value, fresh);
      const next = { ...draft, value, baseline: freshBaseline, dirty: !sameValue(value, freshBaseline) };
      if (!await persist(next)) return;
      baseline.current = freshBaseline;
      setData(fresh); setDraft(next); setEpoch(n => n + 1);
      setMessage(uiText("已讀取最新版，原輸入保留；請重新預覽核對。")); options.afterRefresh?.(fresh);
    } catch (e) { if (active.current) setMessage(e instanceof Error ? errorText(e) : uiText("讀取失敗")); }
    finally { if (active.current) setBusy(false); }
  }
  async function submit(input?: S) {
    if (busy || loading || needsRestore || readError || halted.current || submitting.current) return false;
    const pending = draft.pending ?? (input ? { key: crypto.randomUUID(), input: options.saveSchema.parse(input) } : undefined);
    if (!pending) return false;
    const next = { ...draft, pending };
    submitting.current = true; setBusy(true); setMessage('');
    let accepted = false;
    try {
      if (!draft.pending && options.beforeSubmit) {
        try { await options.beforeSubmit(); }
        catch (error) { if (active.current) setMessage(error instanceof Error ? errorText(error) : uiText("尚未送出，請先核對原紀錄。")); return false; }
      }
      // Archive the editable record atomically before compacting the pending payload.
      // This retains dormant inputs without duplicating active image bytes in pending.
      if (!await persist(next, !draft.pending && !!options.preserveBeforeSubmit) || !active.current) return false;
      setDraft(next);
      const result = await options.send(pending.input, pending.key);
      accepted = true;
      const fresh = await options.latest(result);
      if (!active.current) return false;
      const cleared = { value: options.blank(fresh), dirty: false };
      if (!await persist(cleared, false, uiText("操作已送出，但無法保存確認狀態；請保留原操作並核對結果。"))) throw Error('storage');
      baseline.current = cleared.value; setDraft(cleared); setData(fresh); setEpoch(n => n + 1); setMessage(uiText("已保存。"));
      options.after?.(fresh, result); return true;
    } catch (e) {
      if (!active.current) return false;
      if (!accepted && e instanceof ApiError && e.status < 500 && e.status !== 429) {
        const fresh = { ...next, pending: undefined };
        if (await persist(fresh, false, uiText("無法保存拒絕結果；原操作仍保留，請重新核對。"))) setDraft(fresh);
        setEpoch(n => n + 1); setMessage(errorText(e));
      } else setMessage(uiText("尚未確認操作結果。原操作已保留，請確認原操作結果。"));
      return false;
    } finally { submitting.current = false; if (active.current) setBusy(false); }
  }
  async function recover() {
    if (busy || loading) return;
    setBusy(true);
    try {
      await queue.current;
      if (conflict) {
        const saved = await openDraft(key, viewer.scope);
        handle.current = saved.handle; halted.current = false; applyRaw(saved.raw);
      } else {
        // Re-open only if the original open failed. Never bypass a revoked handle's epoch.
        if (!handle.current) handle.current = (await openDraft(key, viewer.scope)).handle;
        const blank: Draft = { value: options.blank(data), dirty: false };
        if (!await persist(blank, true)) return;
        baseline.current = blank.value;
        applyRaw(JSON.stringify(blank));
      }
      await loadVersions();
    } catch { setStorageError(uiText("仍無法保全原稿，請檢查瀏覽器儲存設定。")); }
    finally { if (active.current) setBusy(false); }
  }
  async function restoreVersion(id: string) {
    if (busy || loading || readError) return;
    const version = versions.find(row => row.id === id); if (!version) return;
    let next: Draft;
    try { next = parse(version.raw); next = { ...next, baseline: next.baseline ?? baseline.current, dirty: !sameValue(next.value, next.baseline ?? baseline.current) }; } catch { setMessage(uiText("這份原稿格式無法讀取，請下載保全檔。")); return; }
    setBusy(true);
    try {
      if (!await persist(next, true)) return;
      baseline.current = next.baseline!;
      setDraft(next); setNeedsRestore(false); setEpoch(n => n + 1); setMessage(uiText("已載入保全版本；請核對原操作與最新資料。"));
      await loadVersions();
    } finally { if (active.current) setBusy(false); }
  }
  async function leave() {
    if (loading || busy) return;
    const proceed = blocker.proceed;
    await queue.current;
    // Unreadable originals remain untouched; a conflict's competing versions have already committed.
    if (readError || halted.current || await persist(draft)) proceed?.();
  }
  async function discard() {
    if (loading || busy || submitting.current || readError || draft.pending) return false;
    submitting.current = true; setBusy(true);
    try {
      await queue.current;
      if (halted.current || revoked.current || !handle.current) return false;
      handle.current = await discardDraft(handle.current);
      if (!active.current) return false;
      const value = options.blank(data); baseline.current = value;
      setDraft({ value, dirty: false }); setNeedsRestore(false); setStorageError(''); setMessage(''); setEpoch(n => n + 1);
      return true;
    } catch (error) {
      if (active.current) {
        if (error instanceof DraftConflict || error instanceof DraftExpired) {
          halted.current = true; setReadError(errorText(error)); setConflict(error instanceof DraftConflict); setExpired(error instanceof DraftExpired);
          if (error instanceof DraftExpired) revoked.current = true;
        } else setStorageError(uiText('尚未捨棄草稿，請重試；目前內容仍保留。'));
      }
      return false;
    } finally { submitting.current = false; if (active.current) setBusy(false); }
  }
  async function discardAndLeave() { const proceed = blocker.proceed; if (await discard()) proceed?.(); }
  return {
    draft, data, locked, busy, dirty, blocker, readError, storageError, message, setMessage,
    edit, refresh, submit, recover, epoch, active, setBusy, leave, discard, discardAndLeave,
    hasPending:!!draft.pending, canDiscard:!loading&&!busy&&!readError&&!draft.pending,
    loading, saving: saving > 0, needsRestore, restore: () => setNeedsRestore(false), conflict, expired, versions, restoreVersion,
  };
}
