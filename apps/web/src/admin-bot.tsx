import { useEffect, useRef, useState } from 'react';
import { Link, useBlocker } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Heading, Surface, Text } from 'yahha-ui';
import { z } from 'zod';
import {
  BOT_KINDS,
  BotPolicy,
  BotPolicyCommand,
  BotPolicyResult,
  BotPolicyView,
  type BotKind,
  type Viewer,
} from '@qgroup/contracts';
import { BOT_DEFAULT_TEMPLATE, BOT_TEMPLATE_LIMITS, validateBotPolicy } from '@qgroup/domain';
import { AdminGate, adminHeaders, type Access } from './admin';
import { api, ApiError } from './api';
import { Failure, Notice, PageIntro } from './shared';
import { Field } from './settlement-controls';
const policyLabels: Record<keyof BotPolicy, string> = {
  enabled: '主動通知',
  replies_enabled: '群內回覆',
  dry_run: '發送模式',
  broadcast_kinds: '通知類型',
  schedule_enabled: '排程提醒',
  deadline_hours: '截止提醒',
  estimated_over_delay_minutes: '結束提醒',
  quiet_enabled: '勿擾開關',
  quiet_start: '勿擾開始',
  quiet_end: '勿擾結束',
  timezone: '勿擾時區',
  min_interval_seconds: '發送間隔',
  templates: '消息模板',
  groups: '群政策',
};
const stateLabels: Record<string, string> = {
  joined: '已加入',
  removed: '已退出',
  seen: '曾收到事件',
  unknown: '尚未回報',
  group_not_allowed: '群未獲授權',
  replies_disabled: '已停用群回覆',
  dry_run: '模擬模式',
  bot_author: '忽略機器人訊息',
  duplicate: '重複事件',
  save: '保存',
  revert: '恢復前版',
  baseline: '基線',
};
function policyValue(key: keyof BotPolicy, value: BotPolicy[keyof BotPolicy]) {
  if (key === 'dry_run') return value === null ? '沿用部署設定' : value ? '模擬' : '實際發送';
  if (typeof value === 'boolean') return value ? '啟用' : '停用';
  if (key === 'broadcast_kinds')
    return (value as BotKind[]).map((kind) => BOT_KINDS[kind]).join('、') || '無';
  if (key === 'groups' && value === null) return '沿用部署目標群';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
const Value = z
  .object({
    ...BotPolicy.shape,
    deadline_hours: z.string(),
    estimated_over_delay_minutes: z.string(),
    min_interval_seconds: z.string(),
    quiet_start: z.string(),
    quiet_end: z.string(),
    timezone: z.string(),
    templates: z.record(z.string(), z.string()),
    groups: z
      .array(
        z
          .object({
            id: z.string(),
            name: z.string(),
            replies: z.boolean(),
            broadcast: z.boolean(),
          })
          .strict(),
      )
      .nullable(),
  })
  .strict();
type Value = z.infer<typeof Value>;
const valueOf = (config: BotPolicy): Value => ({
  ...config,
  deadline_hours: String(config.deadline_hours),
  estimated_over_delay_minutes: String(config.estimated_over_delay_minutes),
  min_interval_seconds: String(config.min_interval_seconds),
});
function policyOf(value: Value) {
  for (const key of ['deadline_hours', 'estimated_over_delay_minutes', 'min_interval_seconds'] as const)
    if (!/^\d+$/.test(value[key])) throw Error('提醒與發送間隔必須填寫整數。');
  return validateBotPolicy({
    ...value,
    deadline_hours: Number(value.deadline_hours),
    estimated_over_delay_minutes: Number(value.estimated_over_delay_minutes),
    min_interval_seconds: Number(value.min_interval_seconds),
  });
}
const Draft = z
  .object({
    revision: z.number().int().nonnegative(),
    value: Value,
    dirty: z.boolean(),
    command: z.enum(['save', 'revert']),
    pending: z.object({ key: z.string().uuid(), input: BotPolicyCommand }).optional(),
  })
  .strict()
  .refine((draft) => {
    if (!draft.pending) return true;
    try {
      return JSON.stringify(commandOf(draft)) === JSON.stringify(draft.pending.input);
    } catch {
      return false;
    }
  });
type Draft = z.infer<typeof Draft>;
function commandOf(draft: { revision: number; value: Value; command: 'save' | 'revert' }) {
  return BotPolicyCommand.parse(
    draft.command === 'save'
      ? {
          command: 'save',
          revision: draft.revision,
          config: policyOf(draft.value),
          confirm: true,
        }
      : { command: 'revert', revision: draft.revision, confirm: true },
  );
}
export function AdminBotPage() {
  return (
    <>
      <PageIntro title="bot 設定" />
      <Link className="back" to="/admin">
        管理後台
      </Link>
      <AdminGate>
        {(viewer, access) => (
          <Manager key={viewer.scope + ':' + access.scope} viewer={viewer} access={access} />
        )}
      </AdminGate>
    </>
  );
}
function Manager({ viewer, access }: { viewer: Viewer; access: Access }) {
  const client = useQueryClient(),
    storageKey = 'qgroup:rebuild:admin-bot:v1:' + viewer.scope + ':' + access.scope;
  const [loaded] = useState(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      return { draft: raw ? Draft.parse(JSON.parse(raw)) : null, error: '' };
    } catch {
      return {
        draft: null,
        error: '無法讀取 bot 設定原稿，請先保全原稿再繼續。',
      };
    }
  });
  const [draft, setDraft] = useState<Draft | null>(loaded.draft),
    [readError, setReadError] = useState(loaded.error),
    [storageError, setStorageError] = useState(''),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [kind, setKind] = useState<BotKind>('activity_published'),
    [rich, setRich] = useState(false),
    [preview, setPreview] = useState<{
      signature: string;
      text: string;
      markdown: string | null;
    } | null>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const catalog = useQuery({
    queryKey: ['private', viewer.scope, 'admin-bot', access.scope],
    queryFn: ({ signal }) =>
      api('/admin/bot', BotPolicyView, {
        signal,
        headers: { 'X-Account-Scope': viewer.scope },
      }),
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
  });
  const dirty = !!draft && (draft.dirty || !!draft.pending),
    locked = busy || !!readError || !!draft?.pending,
    stale = !!draft && !!catalog.data && catalog.data.revision !== draft.revision;
  const blocker = useBlocker(
    ({ nextLocation, currentLocation }) =>
      (dirty || busy) && nextLocation.pathname !== currentLocation.pathname,
  );
  function persist(next: Draft | null) {
    try {
      if (next) sessionStorage.setItem(storageKey, JSON.stringify(next));
      else sessionStorage.removeItem(storageKey);
      setStorageError('');
      return true;
    } catch {
      setStorageError('無法保存 bot 原稿與操作編號，尚未送出；請檢查瀏覽器儲存空間後重試。');
      return false;
    }
  }
  useEffect(() => {
    if (!readError && draft && (draft.dirty || draft.pending)) persist(draft);
  }, [draft, readError, storageKey]);
  useEffect(() => {
    if (catalog.data && !dirty && !busy && !readError)
      setDraft({
        revision: catalog.data.revision,
        value: valueOf(catalog.data.config),
        dirty: false,
        command: 'save',
      });
  }, [catalog.data, dirty, busy, readError]);
  useEffect(() => {
    if (!dirty && !busy) return;
    const leave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', leave);
    return () => window.removeEventListener('beforeunload', leave);
  }, [dirty, busy]);
  useEffect(() => {
    if (catalog.error instanceof ApiError && [401, 403].includes(catalog.error.status))
      void client.invalidateQueries({
        queryKey: ['private', viewer.scope, 'admin-session'],
      });
  }, [catalog.error, client, viewer.scope]);
  function edit(patch: Partial<Value>) {
    if (locked || !draft) return;
    setDraft({
      ...draft,
      value: { ...draft.value, ...patch },
      dirty: true,
      command: 'save',
    });
    setConfirmed(false);
    setMessage('');
    setPreview(null);
  }
  async function rebase() {
    if (locked || !draft) return;
    setBusy(true);
    try {
      const result = await catalog.refetch();
      if (result.error) throw result.error;
      if (active.current && result.data) {
        setDraft({ ...draft, revision: result.data.revision });
        setConfirmed(false);
        setMessage('已讀取最新版，原輸入保留；請核對差異後重新確認。');
      }
    } catch (error) {
      if (active.current) setMessage(error instanceof Error ? error.message : '無法讀取設定');
    } finally {
      if (active.current) setBusy(false);
    }
  }
  async function send() {
    if (!draft || busy || readError || (!draft.pending && (!confirmed || stale || !!catalog.error))) return;
    let operation = draft.pending;
    try {
      operation ??= { key: crypto.randomUUID(), input: commandOf(draft) };
    } catch (error) {
      setMessage(
        error instanceof z.ZodError
          ? '請檢查時間、時區、群標識、唯一通知群及模板欄位。'
          : error instanceof Error
            ? error.message
            : '設定格式不符',
      );
      return;
    }
    const pending = { ...draft, pending: operation };
    if (!persist(pending)) return;
    setDraft(pending);
    setBusy(true);
    setMessage('');
    try {
      await api('/admin/bot', BotPolicyResult, {
        method: 'POST',
        headers: {
          ...adminHeaders(viewer, access),
          'Idempotency-Key': operation.key,
        },
        body: JSON.stringify(operation.input),
      });
      if (!active.current) return;
      if (!persist(null)) {
        setStorageError('設定已保存，但無法清除本機操作紀錄；請恢復儲存空間後確認原操作結果。');
        setMessage('設定已保存，但本機操作紀錄尚未清除；請確認原操作結果。');
        return;
      }
      setDraft(null);
      setConfirmed(false);
      setPreview(null);
      setMessage('bot 設定已保存。');
      await catalog.refetch();
    } catch (error) {
      if (!active.current) return;
      if (error instanceof ApiError && error.status < 500 && error.status !== 429) {
        const next = { ...draft, pending: undefined };
        persist(next);
        setDraft(next);
        setConfirmed(false);
        setMessage(error.message);
        void catalog.refetch();
        if ([401, 403].includes(error.status))
          void client.invalidateQueries({
            queryKey: ['private', viewer.scope, 'admin-session'],
          });
      } else setMessage('尚未確認 bot 設定結果，原稿與操作編號已保留，請確認原操作結果。');
    } finally {
      if (active.current) setBusy(false);
    }
  }
  const signature = JSON.stringify([draft?.value, kind]),
    currentSignature = useRef(signature);
  currentSignature.current = signature;
  async function showPreview() {
    if (!draft || locked) return;
    setBusy(true);
    setMessage('');
    const stamp = signature;
    try {
      const result = await api(
        '/admin/bot/preview',
        z.object({ text: z.string(), markdown: z.string().nullable() }),
        {
          method: 'POST',
          headers: adminHeaders(viewer, access),
          body: JSON.stringify({ config: policyOf(draft.value), kind }),
        },
      );
      if (active.current && currentSignature.current === stamp) setPreview({ ...result, signature: stamp });
    } catch (error) {
      if (active.current)
        setMessage(
          error instanceof z.ZodError
            ? '請先檢查設定欄位。'
            : error instanceof Error
              ? error.message
              : '無法預覽',
        );
    } finally {
      if (active.current) setBusy(false);
    }
  }
  const value = draft?.value,
    templateKey = kind + (rich ? '@md' : ''),
    groups = value?.groups;
  return (
    <>
      {blocker.state === 'blocked' && (
        <Surface role="alert">
          <Text>仍有 bot 設定原稿或待確認操作。</Text>
          <Button onClick={() => blocker.reset()}>繼續核對</Button>
          <Button variant="secondary" disabled={busy} onClick={() => blocker.proceed()}>
            保留原稿並離開
          </Button>
        </Surface>
      )}
      {message && <Notice>{message}</Notice>}
      {storageError && (
        <div role="alert">
          <Text>{storageError}</Text>
          <Button disabled={busy || !!readError} onClick={() => persist(draft)}>
            重試保存原稿
          </Button>
        </div>
      )}
      {readError && (
        <Surface role="alert">
          <Text>{readError}</Text>
          <Button
            onClick={() => {
              try {
                const raw = sessionStorage.getItem(storageKey);
                if (raw !== null) sessionStorage.setItem(storageKey + ':recovery:' + Date.now(), raw);
                sessionStorage.removeItem(storageKey);
                setReadError('');
              } catch {
                setStorageError('仍無法保全原稿，請檢查瀏覽器儲存設定。');
              }
            }}
          >
            保全原稿後繼續
          </Button>
        </Surface>
      )}
      {catalog.isPending || !catalog.isFetchedAfterMount ? (
        <Notice>正在讀取 bot 設定…</Notice>
      ) : catalog.error ? (
        <Failure error={catalog.error} retry={() => void catalog.refetch()} />
      ) : (
        <Surface className="detail auth-panel">
          <Text>
            設定版本：{catalog.data.revision} · worker 已讀版本：
            {catalog.data.runtime.applied_revision ?? '尚未回報'}
          </Text>
          <Text>
            最後讀取設定：{catalog.data.runtime.checked_at ?? '尚未回報'}
            。此紀錄不代表連線或投遞成功。
          </Text>
        </Surface>
      )}
      {draft && value && (
        <Surface className="detail auth-panel" role="region" aria-label="bot 設定核對">
          <fieldset disabled={locked || draft.command === 'revert'}>
            <label className="consent">
              <input
                type="checkbox"
                checked={value.enabled}
                onChange={(e) => edit({ enabled: e.target.checked })}
              />
              <span>啟用主動通知</span>
            </label>
            <label className="consent">
              <input
                type="checkbox"
                checked={value.replies_enabled}
                onChange={(e) => edit({ replies_enabled: e.target.checked })}
              />
              <span>啟用群內指令回覆</span>
            </label>
            <Field label="發送模式">
              <select
                value={value.dry_run === null ? 'inherit' : value.dry_run ? 'simulate' : 'live'}
                onChange={(e) =>
                  edit({
                    dry_run: e.target.value === 'inherit' ? null : e.target.value === 'simulate',
                  })
                }
              >
                <option value="inherit">沿用部署設定</option>
                <option value="simulate">模擬</option>
                <option value="live">實際發送</option>
              </select>
            </Field>
            <Text>模擬紀錄不算已送出；切換為實際發送不重播舊模擬紀錄。</Text>
            <Heading level={2}>通知類型</Heading>
            {Object.entries(BOT_KINDS).map(([key, label]) => (
              <label className="consent" key={key}>
                <input
                  type="checkbox"
                  checked={value.broadcast_kinds.includes(key as BotKind)}
                  onChange={(e) =>
                    edit({
                      broadcast_kinds: e.target.checked
                        ? [...value.broadcast_kinds, key as BotKind]
                        : value.broadcast_kinds.filter((k) => k !== key),
                    })
                  }
                />
                <span>{label}</span>
              </label>
            ))}
            <Heading level={2}>提醒與發送時間</Heading>
            <label className="consent">
              <input
                type="checkbox"
                checked={value.schedule_enabled}
                onChange={(e) => edit({ schedule_enabled: e.target.checked })}
              />
              <span>啟用排程提醒</span>
            </label>
            <Field label="報名截止前幾小時提醒">
              <input
                type="number"
                min="1"
                max="720"
                value={value.deadline_hours}
                onChange={(e) => edit({ deadline_hours: e.target.value })}
              />
            </Field>
            <Field label="預計結束後延遲提醒（分鐘）">
              <input
                type="number"
                min="0"
                max="1440"
                value={value.estimated_over_delay_minutes}
                onChange={(e) => edit({ estimated_over_delay_minutes: e.target.value })}
              />
            </Field>
            <Field label="主動發送最小間隔（秒）">
              <input
                type="number"
                min="0"
                max="3600"
                value={value.min_interval_seconds}
                onChange={(e) => edit({ min_interval_seconds: e.target.value })}
              />
            </Field>
            <label className="consent">
              <input
                type="checkbox"
                checked={value.quiet_enabled}
                onChange={(e) => edit({ quiet_enabled: e.target.checked })}
              />
              <span>啟用勿擾時段</span>
            </label>
            <Field label="勿擾開始">
              <input
                type="time"
                value={value.quiet_start}
                onChange={(e) => edit({ quiet_start: e.target.value })}
              />
            </Field>
            <Field label="勿擾結束">
              <input
                type="time"
                value={value.quiet_end}
                onChange={(e) => edit({ quiet_end: e.target.value })}
              />
            </Field>
            <Field label="勿擾時區">
              <input value={value.timezone} onChange={(e) => edit({ timezone: e.target.value })} />
            </Field>
            <Heading level={2}>群政策</Heading>
            <label className="consent">
              <input
                type="checkbox"
                checked={groups === null}
                onChange={(e) =>
                  edit({
                    groups: e.target.checked
                      ? null
                      : (catalog.data?.group_status.groups
                          .filter((g) => g.configured)
                          .map(({ id, name, replies, broadcast }) => ({
                            id,
                            name,
                            replies,
                            broadcast,
                          })) ?? []),
                  })
                }
              />
              <span>沿用部署目標群</span>
            </label>
            <Text>
              群標識使用 group_openid，不是 QQ
              群號。關閉沿用後，空清單會停用所有群回覆與主動通知。主動通知只能選一群；換群會作廢舊待送通知。
            </Text>
            {groups?.map((group, index) => (
              <div className="auth-panel" key={index} role="group" aria-label={'群政策 ' + (index + 1)}>
                <Field label={'群標識 ' + (index + 1)}>
                  <input
                    value={group.id}
                    onChange={(e) =>
                      edit({
                        groups: groups.map((g, i) => (i === index ? { ...g, id: e.target.value } : g)),
                      })
                    }
                  />
                </Field>
                <Field label={'群名稱 ' + (index + 1)}>
                  <input
                    value={group.name}
                    onChange={(e) =>
                      edit({
                        groups: groups.map((g, i) => (i === index ? { ...g, name: e.target.value } : g)),
                      })
                    }
                  />
                </Field>
                <label className="consent">
                  <input
                    type="checkbox"
                    checked={group.replies}
                    onChange={(e) =>
                      edit({
                        groups: groups.map((g, i) => (i === index ? { ...g, replies: e.target.checked } : g)),
                      })
                    }
                  />
                  <span>允許此群回覆</span>
                </label>
                <label className="consent">
                  <input
                    type="radio"
                    name="broadcast-target"
                    checked={group.broadcast}
                    onChange={() =>
                      edit({
                        groups: groups.map((g, i) => ({
                          ...g,
                          broadcast: i === index,
                        })),
                      })
                    }
                  />
                  <span>主動通知此群</span>
                </label>
                <Button
                  variant="secondary"
                  onClick={() => edit({ groups: groups.filter((_, i) => i !== index) })}
                >
                  移除群政策 {index + 1}
                </Button>
              </div>
            ))}
            {groups !== null && (
              <div className="page-actions">
                <Button
                  variant="secondary"
                  disabled={!groups || groups.length >= 100}
                  onClick={() =>
                    edit({
                      groups: [...(groups ?? []), { id: '', name: '', replies: true, broadcast: false }],
                    })
                  }
                >
                  新增群政策
                </Button>
                <Button
                  variant="secondary"
                  disabled={!groups?.some((g) => g.broadcast)}
                  onClick={() =>
                    edit({
                      groups: groups?.map((g) => ({ ...g, broadcast: false })) ?? [],
                    })
                  }
                >
                  停用主動通知目標
                </Button>
              </div>
            )}
            <Heading level={2}>消息模板</Heading>
            <Field label="模板類型">
              <select
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value as BotKind);
                  setPreview(null);
                }}
              >
                {Object.entries(BOT_KINDS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <label className="consent">
              <input type="checkbox" checked={rich} onChange={(e) => setRich(e.target.checked)} />
              <span>Markdown 模板</span>
            </label>
            <Field label="自訂模板">
              <textarea
                rows={6}
                value={value.templates[templateKey] ?? ''}
                onChange={(e) => {
                  const templates = { ...value.templates };
                  if (e.target.value) templates[templateKey] = e.target.value;
                  else delete templates[templateKey];
                  edit({ templates });
                }}
              />
            </Field>
            <Text>留空使用系統模板；自訂須保留 {'{url}'}，最多 2000 字。Markdown 仍需部署啟用。</Text>
            <details>
              <summary>可用變數</summary>
              <Text>
                {Object.keys(BOT_TEMPLATE_LIMITS)
                  .map((key) => '{' + key + '}')
                  .join(' ')}
                。普通文字預設：{BOT_DEFAULT_TEMPLATE}
              </Text>
            </details>
            <Button variant="secondary" onClick={() => void showPreview()}>
              預覽模板
            </Button>
            <Text>預覽使用合成資料，不發送訊息。</Text>
          </fieldset>
          {preview?.signature === signature && (
            <div role="region" aria-label="模板預覽">
              <Heading level={3}>普通文字</Heading>
              <pre className="preserve-lines">{preview.text}</pre>
              <Heading level={3}>Markdown 原文</Heading>
              <pre className="preserve-lines">{preview.markdown ?? '使用普通文字'}</pre>
            </div>
          )}
          {stale && !draft.pending && <Text role="alert">設定已有更新，請核對最新版後重新確認。</Text>}
          {dirty && !draft.pending && catalog.data && (
            <details>
              <summary>核對目前保存的設定</summary>
              <dl>
                {(Object.keys(policyLabels) as (keyof BotPolicy)[]).map((key) => (
                  <div key={key}>
                    <dt>{policyLabels[key]}</dt>
                    <dd className="preserve-lines">{policyValue(key, catalog.data.config[key])}</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}

          {draft.command === 'revert' && (
            <Text role="alert">將恢復上一版設定並追加新版本；不回放已投遞或模擬紀錄。</Text>
          )}
          <label className="consent">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={locked || stale || !!catalog.error}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <span>我已核對發送模式、群政策與設定變更</span>
          </label>
          <div className="page-actions">
            <Button
              loading={busy}
              disabled={
                !!readError ||
                !!storageError ||
                (!draft.pending && (!dirty || !confirmed || stale || !!catalog.error))
              }
              onClick={() => void send()}
            >
              {draft.pending
                ? '確認原操作結果'
                : draft.command === 'revert'
                  ? '確認恢復上一版'
                  : '確認 bot 設定'}
            </Button>
            <Button variant="secondary" disabled={locked || !dirty} onClick={() => void rebase()}>
              核對最新版，保留輸入
            </Button>
            <Button
              variant="secondary"
              disabled={locked || !dirty}
              onClick={() => {
                if (!persist(null)) return;
                setDraft(null);
                setConfirmed(false);
                setPreview(null);
                void catalog.refetch();
              }}
            >
              放棄原稿
            </Button>
            <Button
              variant="secondary"
              disabled={locked || dirty || !catalog.data || catalog.data.revision < 1 || !!catalog.error}
              onClick={() => {
                setDraft({ ...draft, command: 'revert', dirty: true });
                setConfirmed(false);
              }}
            >
              恢復上一版
            </Button>
          </div>
        </Surface>
      )}
      {catalog.data && !catalog.error && (
        <>
          <Surface className="detail auth-panel">
            <Heading level={2}>群狀態</Heading>
            {catalog.data.group_status.groups.map((group) => (
              <div key={group.id}>
                <Text>
                  {group.name || group.id} · {stateLabels[group.membership] ?? group.membership} ·{' '}
                  {group.configured ? '已設定' : '未授權'}
                </Text>
                <Text>
                  群標識：{group.id} · 最後事件：
                  {group.last_event || '尚未回報'} · {group.last_seen ?? '尚未回報'}
                </Text>
                {!group.configured && groups !== null && !groups?.some((g) => g.id === group.id) && (
                  <Button
                    variant="secondary"
                    disabled={locked || !groups || groups.length >= 100}
                    onClick={() =>
                      edit({
                        groups: [
                          ...(groups ?? []),
                          {
                            id: group.id,
                            name: group.name,
                            replies: false,
                            broadcast: false,
                          },
                        ],
                      })
                    }
                  >
                    加入政策 {group.id}
                  </Button>
                )}
              </div>
            ))}
            {!catalog.data.group_status.groups.length && <Text>尚未發現群；可手動新增已核對的群標識。</Text>}
            {catalog.data.group_status.ignores.map((row, index) => (
              <Text key={index}>
                {row.created_at} · {row.group_id} · {stateLabels[row.reason] ?? row.reason}
              </Text>
            ))}
          </Surface>
          <Surface className="detail auth-panel">
            <Heading level={2}>設定歷史</Heading>
            {catalog.data.history.map((row) => (
              <Text key={row.revision}>
                第 {row.revision} 版 · {row.created_at} · {stateLabels[row.action] ?? row.action} ·{' '}
                {row.changes.map((key) => policyLabels[key as keyof BotPolicy] ?? key).join('、') || '基線'}
              </Text>
            ))}
          </Surface>
        </>
      )}
    </>
  );
}
