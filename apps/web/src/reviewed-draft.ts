import { useEffect, useRef, useState } from 'react';
import { useBlocker } from 'react-router-dom';
import { z } from 'zod';
import type { Member } from './member-access';
import { api, ApiError } from './api';
/** Durable, account-scoped writes require an explicit retry after uncertain delivery. */
export function useReviewedDraft<T, S, F>(options: {
  key: string;
  viewer: Member;
  initial: F;
  blank: (fresh: F) => T;
  valueSchema: z.ZodType<T>;
  saveSchema: z.ZodType<S>;
  resultSchema: z.ZodType;
  endpoint: string;
  latest: (result?: unknown) => Promise<F>;
  matches: (value: T, input: S) => boolean;
  fromPending: (input: S) => T;
  after?: (fresh: F, result?: unknown) => void;
  afterRefresh?: (fresh: F) => void;
}) {
  const { key, viewer } = options,
    active = useRef(true),
    schema = z
      .object({
        value: options.valueSchema,
        dirty: z.boolean(),
        pending: z.object({ key: z.string().uuid(), input: options.saveSchema }).strict().optional(),
      })
      .strict()
      .refine((v) => !v.pending || options.matches(v.value, v.pending.input));
  const [loaded] = useState(() => {
    try {
      const raw = sessionStorage.getItem(key);
      let saved = raw ? JSON.parse(raw) : null;
      if (saved && saved.value === undefined) {
        const compact = z
          .object({
            dirty: z.boolean(),
            pending: z.object({ key: z.string().uuid(), input: options.saveSchema }).strict(),
          })
          .strict()
          .parse(saved);
        saved = { ...compact, value: options.fromPending(compact.pending.input) };
      }
      return {
        draft: saved ? schema.parse(saved) : { value: options.blank(options.initial), dirty: false },
        error: '',
      };
    } catch {
      return {
        draft: { value: options.blank(options.initial), dirty: false },
        error: '無法讀取原稿，請先保全原稿再繼續。',
      };
    }
  });
  const [draft, setDraft] = useState<z.infer<typeof schema>>(loaded.draft),
    [data, setData] = useState(options.initial),
    [readError, setReadError] = useState(loaded.error),
    [storageError, setStorageError] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [epoch, setEpoch] = useState(0);
  const dirty = draft.dirty || !!draft.pending,
    blocker = useBlocker(dirty),
    locked = busy || !!readError || !!draft.pending;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  function persist(next: typeof draft) {
    try {
      sessionStorage.setItem(key, JSON.stringify(next.pending ? { dirty: next.dirty, pending: next.pending } : next));
      setStorageError('');
      return true;
    } catch {
      setStorageError('無法保存原稿及操作編號，尚未送出。');
      return false;
    }
  }
  useEffect(() => {
    if (!readError) persist(draft);
  }, [draft, readError, key]);
  useEffect(() => {
    if (!dirty) return;
    const leave = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', leave);
    return () => window.removeEventListener('beforeunload', leave);
  }, [dirty]);
  function edit(value: T) {
    if (locked) return;
    setDraft({ ...draft, value, dirty: true });
    setEpoch((n) => n + 1);
    setMessage('');
  }
  async function refresh(rebase: (old: T, fresh: F) => T) {
    if (locked) return;
    setBusy(true);
    try {
      const fresh = await options.latest();
      if (!active.current) return;
      const next = { ...draft, value: rebase(draft.value, fresh) };
      if (!persist(next)) return;
      setData(fresh);
      setDraft(next);
      setEpoch((n) => n + 1);
      setMessage('已讀取最新版，原輸入保留；請重新預覽核對。');
      options.afterRefresh?.(fresh);
    } catch (e) {
      if (active.current) setMessage(e instanceof Error ? e.message : '讀取失敗');
    } finally {
      if (active.current) setBusy(false);
    }
  }
  async function submit(input?: S) {
    if (busy || readError) return false;
    const pending =
      draft.pending ?? (input ? { key: crypto.randomUUID(), input: options.saveSchema.parse(input) } : undefined);
    if (!pending) return false;
    const next = { ...draft, pending };
    if (!persist(next)) return false;
    setDraft(next);
    setBusy(true);
    setMessage('');
    let accepted = false;
    try {
      const result = await api(options.endpoint, options.resultSchema, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Account-Scope': viewer.scope,
          'X-CSRF-Token': viewer.csrf,
          'Idempotency-Key': pending.key,
        },
        body: JSON.stringify(pending.input),
      });
      accepted = true;
      const fresh = await options.latest(result);
      if (!active.current) return false;
      const cleared = { value: options.blank(fresh), dirty: false };
      if (!persist(cleared)) throw Error('storage');
      setDraft(cleared);
      setData(fresh);
      setEpoch((n) => n + 1);
      setMessage('已保存。');
      options.after?.(fresh, result);
      return true;
    } catch (e) {
      if (!active.current) return false;
      if (!accepted && e instanceof ApiError && e.status < 500 && e.status !== 429) {
        const fresh = { ...next, pending: undefined };
        if (persist(fresh)) setDraft(fresh);
        setEpoch((n) => n + 1);
        setMessage(e.message);
      } else setMessage('尚未確認操作結果。原操作已保留，請確認原操作結果。');
      return false;
    } finally {
      if (active.current) setBusy(false);
    }
  }
  function recover() {
    try {
      const raw = sessionStorage.getItem(key);
      if (raw !== null) sessionStorage.setItem(key + ':recovery:' + Date.now(), raw);
      setReadError('');
    } catch {
      setStorageError('仍無法保全原稿，請檢查瀏覽器儲存設定。');
    }
  }
  return {
    draft,
    data,
    locked,
    busy,
    dirty,
    blocker,
    readError,
    storageError,
    message,
    setMessage,
    edit,
    refresh,
    submit,
    recover,
    epoch,
    active,
    setBusy,
  };
}
