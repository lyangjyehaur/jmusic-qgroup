import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Heading, Surface, Text } from 'yahha-ui';
import { z } from 'zod';
import {
  ActivityCategory,
  CreateTimePoll,
  ManageTimePoll,
  PollChoice,
  TimePoll,
  TimePollList,
  TimePollResult,
  VoteTimePoll,
  type Viewer,
} from '@qgroup/contracts';
import { api } from './api';
import { Failure, Notice, PageIntro, useSession } from './shared';
import { MemberAccess, type Member } from './member-access';
import { useReviewedDraft } from './reviewed-draft';
import { DraftFeedback } from './activity-settlement';
import { Field } from './settlement-controls';
import { PollCalendar } from './poll-calendar';
type Poll = z.infer<typeof TimePoll>;
const base = (id: string) => '/time-polls/' + encodeURIComponent(id),
  scoped = (v: Viewer) => ({ 'X-Account-Scope': v.scope });
const choices = { yes: '可以', maybe: '勉強可以', no: '不行' } as const;
const states = { open: '投票中', closed: '已截止', cancelled: '已取消', finalized: '已定案', deleted: '已移除' };
const label = (o: Poll['options'][number], p: Poll) =>
  o.starts_at
    ? new Intl.DateTimeFormat('zh-TW', { timeZone: p.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(o.starts_at),
      )
    : o.date;
const localTime = (value: string, zone: string) =>
  new Intl.DateTimeFormat('zh-TW', { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
export function TimePollsPage() {
  const session = useSession(),
    [search, setSearch] = useSearchParams(),
    period = search.get('period') === 'history' ? 'history' : 'active',
    page = Math.max(1, Math.min(10000, Number(search.get('page')) || 1));
  const query = useQuery({
    queryKey: ['private', session.data?.scope, 'time-polls', period, page],
    enabled: !!session.data,
    queryFn: () =>
      api('/time-polls?' + new URLSearchParams({ period, page: String(page) }), TimePollList, {
        headers: scoped(session.data!),
      }),
  });
  return (
    <>
      <PageIntro title="時間投票" />
      <div className="page-actions">
        <Link to="/activities">活動</Link>
        <Link to="/time-polls/new">發起時間投票</Link>
      </div>
      <div className="tabs">
        {(['active', 'history'] as const).map((p) => (
          <Button
            key={p}
            variant={period === p ? 'primary' : 'ghost'}
            aria-pressed={period === p}
            onClick={() => setSearch({ period: p })}
          >
            {p === 'active' ? '開放與待定案' : '往期投票'}
          </Button>
        ))}
      </div>
      {session.error ? (
        <Failure error={session.error} retry={() => void session.refetch()} />
      ) : query.isPending ? (
        <Notice>正在讀取投票…</Notice>
      ) : query.error ? (
        <Failure error={query.error} retry={() => void query.refetch()} />
      ) : (
        <>
          <div className="event-grid">
            {query.data.polls.map((p) => (
              <Surface key={p.id}>
                <Heading level={2}>
                  <Link to={base(p.id)}>{p.title}</Link>
                </Heading>
                <Text>
                  {states[p.status]} · {p.respondent_count} 人填答 · {p.options.length} 項候選
                </Text>
                <Text>
                  {p.location} · {p.timezone}
                </Text>
                <Text>截止 {localTime(p.deadline, p.timezone)}</Text>
              </Surface>
            ))}
          </div>
          {!query.data.polls.length && <Notice>這個篩選下沒有時間投票。</Notice>}
          <div className="pagination">
            {page > 1 && <Button onClick={() => setSearch({ period, page: String(page - 1) })}>上一頁</Button>}
            {query.data.hasMore && (
              <Button onClick={() => setSearch({ period, page: String(page + 1) })}>下一頁</Button>
            )}
          </div>
        </>
      )}
    </>
  );
}
const EditableDefinition = z.object({
  title: z.string(),
  category: ActivityCategory,
  location: z.string(),
  description: z.string(),
  timezone: z.string(),
  capacity: z.number(),
  minimum_participants: z.number(),
  fee_policy: z.string(),
  deadline: z.string(),
  bot_enabled: z.boolean(),
  time_mode: z.enum(['date', 'exact']),
  duration_hours: z.number(),
  options: z.array(z.string()),
});
const emptyDefinition = () => ({
  title: '',
  category: '约K' as const,
  location: '',
  description: '',
  timezone: 'Asia/Taipei',
  capacity: 0,
  minimum_participants: 0,
  fee_policy: '',
  deadline: '',
  bot_enabled: true,
  time_mode: 'date' as 'date' | 'exact',
  duration_hours: 3,
  options: ['', ''],
});
function createInput(v: z.infer<typeof EditableDefinition>) {
  const { duration_hours, ...rest } = v;
  return CreateTimePoll.parse({
    ...rest,
    visibility: 'public',
    ...(v.time_mode === 'exact' ? { duration_hours } : {}),
    options: v.options.map((value) => (v.time_mode === 'date' ? { date: value } : { starts_at: value })),
  });
}
export function NewTimePollPage() {
  return (
    <>
      <PageIntro title="發起時間投票" />
      <Link to="/time-polls">回到時間投票</Link>
      <MemberAccess>{(viewer) => <CreatePoll key={viewer.scope} viewer={viewer} />}</MemberAccess>
    </>
  );
}
function CreatePoll({ viewer }: { viewer: Member }) {
  const navigate = useNavigate(),
    client = useQueryClient();
  const form = useReviewedDraft({
    key: 'qgroup:rebuild:activity-draft:poll-create:v1:' + viewer.scope + ':new',
    viewer,
    initial: { id: null as string | null },
    blank: emptyDefinition,
    valueSchema: EditableDefinition,
    saveSchema: CreateTimePoll,
    resultSchema: TimePollResult,
    endpoint: '/time-polls',
    latest: async (result) => ({ id: result ? TimePollResult.parse(result).id : null }),
    fromPending: (input) => ({
      ...input,
      duration_hours: input.time_mode === 'exact' ? input.duration_hours : 3,
      options: input.options.map((o) => ('date' in o ? o.date : o.starts_at)),
    }),
    matches: (v, input) => {
      try {
        return JSON.stringify(createInput(v)) === JSON.stringify(input);
      } catch {
        return false;
      }
    },
    after: () => {
      void client.invalidateQueries({ queryKey: ['private', viewer.scope, 'time-polls'] });
    },
  });
  useEffect(() => {
    if (form.data.id && !form.dirty) navigate(base(form.data.id));
  }, [form.data.id, form.dirty]);
  const v = form.draft.value,
    edit = (patch: Partial<typeof v>) => form.edit({ ...v, ...patch });
  return (
    <Surface className="detail activity-editor">
      <Notice>投票公開可見，請勿填寫私人資訊。投票不占名額，定案後須另行報名。</Notice>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (form.draft.pending) void form.submit();
          else
            try {
              void form.submit(createInput(v));
            } catch {
              form.setMessage('請填寫活動安排、截止時間及至少兩個候選。');
            }
        }}
      >
        <fieldset disabled={form.locked}>
          <legend>預計安排</legend>
          <Field label="投票名稱">
            <input maxLength={60} value={v.title} onChange={(e) => edit({ title: e.target.value })} />
          </Field>
          <Field label="活動類型">
            <select value={v.category} onChange={(e) => edit({ category: ActivityCategory.parse(e.target.value) })}>
              {ActivityCategory.options.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label="預計地點">
            <input value={v.location} onChange={(e) => edit({ location: e.target.value })} />
          </Field>
          <Field label="時區（IANA）">
            <input value={v.timezone} onChange={(e) => edit({ timezone: e.target.value })} />
          </Field>
          <Field label="人數上限（0 為不限）">
            <input
              type="number"
              min="0"
              max="500"
              value={v.capacity}
              onChange={(e) => edit({ capacity: Number(e.target.value) })}
            />
          </Field>
          <Field label="最低成團人數">
            <input
              type="number"
              min="0"
              max="500"
              value={v.minimum_participants}
              onChange={(e) => edit({ minimum_participants: Number(e.target.value) })}
            />
          </Field>
          <Field label="費用規則">
            <textarea value={v.fee_policy} onChange={(e) => edit({ fee_policy: e.target.value })} />
          </Field>
          <Field label="活動說明">
            <textarea value={v.description} onChange={(e) => edit({ description: e.target.value })} />
          </Field>
          <Field label="候選模式">
            <select
              value={v.time_mode}
              onChange={(e) => {
                if (v.options.some(Boolean) && !window.confirm('切換模式會清除已填候選，確定切換？')) return;
                edit({ time_mode: e.target.value as 'date' | 'exact', options: ['', ''] });
              }}
            >
              <option value="date">日期（定案時補開始時間）</option>
              <option value="exact">精確時段</option>
            </select>
          </Field>
          {v.time_mode === 'exact' && (
            <Field label="預計持續小時">
              <input
                type="number"
                min="1"
                max="24"
                value={v.duration_hours}
                onChange={(e) => edit({ duration_hours: Number(e.target.value) })}
              />
            </Field>
          )}
          {v.time_mode === 'date' && (
            <PollCalendar zone={v.timezone} values={v.options} change={(options) => edit({ options })} />
          )}
          {v.options.map((value, i) => (
            <div key={i} className="poll-option-input">
              <Field label={'候選' + (v.time_mode === 'date' ? '日期' : '時間') + ' ' + (i + 1)}>
                <input
                  type={v.time_mode === 'date' ? 'date' : 'text'}
                  placeholder={v.time_mode === 'exact' ? '2026-11-20T18:00:00+08:00' : undefined}
                  value={value}
                  onChange={(e) => edit({ options: v.options.map((s, j) => (j === i ? e.target.value : s)) })}
                />
              </Field>
              <Button
                variant="ghost"
                disabled={v.options.length <= 2}
                onClick={() => edit({ options: v.options.filter((_, j) => j !== i) })}
              >
                移除候選 {i + 1}
              </Button>
            </div>
          ))}
          <Button variant="secondary" onClick={() => edit({ options: [...v.options, ''] })}>
            新增候選
          </Button>
          <Field label="投票截止（含時區）">
            <input
              placeholder="2026-11-19T18:00:00+08:00"
              value={v.deadline}
              onChange={(e) => edit({ deadline: e.target.value })}
            />
          </Field>
          <label className="consent">
            <input type="checkbox" checked={v.bot_enabled} onChange={(e) => edit({ bot_enabled: e.target.checked })} />
            <span>同步到 QQ 群（仍依管理員群政策）</span>
          </label>
        </fieldset>
        <Button type="submit" disabled={!!form.readError} loading={form.busy}>
          {form.draft.pending ? '確認原投票建立結果' : '建立時間投票'}
        </Button>
      </form>
      <DraftFeedback form={form} />
    </Surface>
  );
}
export function TimePollPage({ manage = false }: { manage?: boolean }) {
  const { id = '' } = useParams(),
    session = useSession(),
    viewer = session.data;
  const query = useQuery({
    queryKey: ['private', viewer?.scope, 'time-poll', id, ...(manage ? ['manage'] : [])],
    enabled: !!viewer,
    queryFn: () => api(base(id) + (manage ? '/manage' : ''), TimePoll, { headers: scoped(viewer!) }),
    refetchOnWindowFocus: false,
  });
  // Re-read as a candidate or deadline expires, without modifying an editable ballot.
  useEffect(() => {
    if (!query.data || query.data.status !== 'open') return;
    const ticks = [
      Date.parse(query.data.deadline),
      ...query.data.options.filter((o) => !o.expired && o.starts_at).map((o) => Date.parse(o.starts_at!)),
    ].filter((t) => t > Date.now());
    const ms = Math.min(60000, ...ticks.map((t) => t - Date.now() + 50));
    const timer = setTimeout(() => void query.refetch(), ms);
    const interval = setInterval(() => void query.refetch(), 60000);
    return () => {
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, [query.data]);
  return (
    <>
      <Link to="/time-polls">← 時間投票</Link>
      {manage&&<Link to={'/time-polls/'+encodeURIComponent(id)+'/bot-deliveries'}>群通知紀錄</Link>}
      {session.error ? (
        <Failure error={session.error} retry={() => void session.refetch()} />
      ) : query.isPending ? (
        <Notice>正在讀取投票…</Notice>
      ) : query.error ? (
        <Failure error={query.error} retry={() => void query.refetch()} />
      ) : (
        <PollDetails key={viewer!.scope + ':' + id + ':' + manage} poll={query.data} viewer={viewer!} manage={manage} />
      )}
    </>
  );
}
function PollDetails({ poll: p, viewer, manage }: { poll: Poll; viewer: Viewer; manage: boolean }) {
  const [share, setShare] = useState('');
  return (
    <>
      <PageIntro title={p.title}>{states[p.status]}</PageIntro>
      <div className="page-actions">
        {manage ? (
          <Link to={base(p.id)}>返回填答與結果</Link>
        ) : (
          p.is_owner && <Link to={base(p.id) + '/manage'}>管理時間投票</Link>
        )}
      </div>
      <Surface className="detail">
        <dl>
          <dt>地點</dt>
          <dd>{p.location}</dd>
          <dt>時區</dt>
          <dd>{p.timezone}</dd>
          <dt>截止</dt>
          <dd>{localTime(p.deadline, p.timezone)}</dd>
          <dt>人數</dt>
          <dd>
            上限 {p.capacity || '不限'} · 最低 {p.minimum_participants}
          </dd>
          <dt>發起者</dt>
          <dd>{p.owner_name}</dd>
        </dl>
        {p.description && <Text className="description">{p.description}</Text>}
        {p.fee_policy && <Text>費用：{p.fee_policy}</Text>}
        <Text>{p.respondent_count} 人填答</Text>
        {p.duration_hours !== null && <Text>每場預計 {p.duration_hours} 小時</Text>}
        <Notice>投票不占名額；定案後請核對活動安排再報名。</Notice>
        {p.reason && <Text>原因：{p.reason}</Text>}
        {p.event_id && <Link to={'/activities/' + encodeURIComponent(p.event_id)}>查看定案活動並報名</Link>}
        {p.event_deleted && <Notice>定案活動已移除，原投票結果保留。</Notice>}
        <Button
          variant="secondary"
          onClick={() =>
            void navigator.clipboard.writeText(p.title + '\n一起選擇活動時間：\n' + location.origin + base(p.id)).then(
              () => setShare('已複製投票連結。'),
              () => setShare('無法複製，請複製瀏覽器網址。'),
            )
          }
        >
          複製投票連結
        </Button>
        {share && <Notice>{share}</Notice>}
        {!viewer.authenticated && (
          <Notice>
            <Link to={'/login?returnTo=' + encodeURIComponent(base(p.id))}>登入</Link>後可填答。
          </Notice>
        )}
      </Surface>
      {manage ? (
        p.is_owner && viewer.authenticated ? (
          <PollManager key={'manage:' + viewer.scope} viewer={viewer} initial={p} />
        ) : (
          <Notice>只有發起者可以管理時間投票。</Notice>
        )
      ) : viewer.authenticated ? (
        <VoteEditor key={'votes:' + viewer.scope} viewer={viewer} initial={p} />
      ) : (
        <PollResults poll={p} />
      )}
    </>
  );
}
function PollResults({ poll: p }: { poll: Poll }) {
  return (
    <section aria-label="投票統計">
      {p.options.map((o) => (
        <Surface key={o.id}>
          <Heading level={2}>{label(o, p)}</Heading>
          <Text>
            {o.expired ? '已過期 · ' : ''}
            {p.leading_option_ids.includes(o.id) ? '最高票 · ' : ''}
            {p.selected_option_id === o.id ? '已定案 · ' : ''}可以 {o.yes} · 勉強可以 {o.maybe} · 不行 {o.no}
          </Text>
        </Surface>
      ))}
    </section>
  );
}
const EditableVotes = z
  .object({ revision: z.number().int().nonnegative(), choices: z.record(z.string(), PollChoice) })
  .strict();
function VoteEditor({ viewer, initial }: { viewer: Member; initial: Poll }) {
  const client = useQueryClient(),
    key = ['private', viewer.scope, 'time-poll', initial.id];
  const form = useReviewedDraft({
    key: 'qgroup:rebuild:activity-draft:poll-vote:v1:' + viewer.scope + ':' + initial.id,
    viewer,
    initial,
    blank: (p) => ({ revision: p.revision, choices: p.my_choices }),
    valueSchema: EditableVotes,
    saveSchema: VoteTimePoll,
    resultSchema: TimePollResult,
    endpoint: base(initial.id) + '/votes',
    latest: async () => {
      const p = await api(base(initial.id), TimePoll, { headers: scoped(viewer) });
      return p;
    },
    fromPending: (input) => ({
      revision: input.revision,
      choices: Object.fromEntries(input.choices.map((c) => [c.option_id, c.choice])),
    }),
    matches: (v, input) =>
      v.revision === input.revision &&
      JSON.stringify(v.choices) ===
        JSON.stringify(Object.fromEntries(input.choices.map((c) => [c.option_id, c.choice]))),
    after: (p) => {
      client.setQueryData(key, p);
      void client.invalidateQueries({ queryKey: [...key, 'manage'], exact: true });
    },
    afterRefresh: (p) => client.setQueryData(key, p),
  });
  // Incoming expiry/statistics affect controls immediately, but never replace unsaved choices.
  const p = initial,
    v = form.draft.value,
    active = p.options.filter((o) => !o.expired),
    filled = active.filter((o) => !!v.choices[o.id]).length;
  const stale = v.revision !== p.revision;
  return (
    <Surface className="detail">
      <Heading level={2}>我的填答</Heading>
      <Text>
        已填 {filled} / {active.length} 個有效候選
      </Text>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (form.draft.pending) void form.submit();
          else if (filled === active.length && !stale && p.can_vote)
            void form.submit({
              revision: v.revision,
              choices: p.options
                .filter((o) => v.choices[o.id])
                .map((o) => ({ option_id: o.id, choice: v.choices[o.id]! })),
            });
        }}
      >
        <fieldset disabled={form.locked || !p.can_vote}>
          <legend>逐項意願</legend>
          <div className="page-actions">
            {Object.entries(choices).map(([choice, text]) => (
              <Button
                key={choice}
                variant="secondary"
                onClick={() =>
                  form.edit({
                    ...v,
                    choices: {
                      ...v.choices,
                      ...Object.fromEntries(
                        active.filter((o) => !v.choices[o.id]).map((o) => [o.id, choice as z.infer<typeof PollChoice>]),
                      ),
                    },
                  })
                }
              >
                未填項全選{text}
              </Button>
            ))}
          </div>
          {p.options.map((o) => (
            <fieldset key={o.id} disabled={o.expired} className="poll-choice">
              <legend>
                {label(o, p)}
                {o.expired ? ' · 已過期' : ''}
                {p.leading_option_ids.includes(o.id) ? ' · 最高票' : ''}
              </legend>
              <Text>
                可以 {o.yes} · 勉強可以 {o.maybe} · 不行 {o.no}
                {p.selected_option_id === o.id ? ' · 已定案' : ''}
              </Text>
              <div className="poll-answers">
                {Object.entries(choices).map(([choice, text]) => (
                  <label key={choice}>
                    <input
                      type="radio"
                      name={'choice:' + o.id}
                      value={choice}
                      checked={v.choices[o.id] === choice}
                      onChange={() => form.edit({ ...v, choices: { ...v.choices, [o.id]: PollChoice.parse(choice) } })}
                    />
                    <span>{text}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        </fieldset>
        {stale && <Notice>投票安排已變更，請先核對最新版。</Notice>}
        <Button
          type="submit"
          loading={form.busy}
          disabled={!!form.readError || (!form.draft.pending && (!p.can_vote || stale || filled !== active.length))}
        >
          {form.draft.pending ? '確認原填答結果' : p.has_voted ? '保存改票' : '提交填答'}
        </Button>
      </form>
      <Button
        variant="secondary"
        disabled={form.locked}
        onClick={() => void form.refresh((old, fresh) => ({ ...old, revision: fresh.revision }))}
      >
        核對最新候選，保留選擇
      </Button>
      <DraftFeedback form={form} />
    </Surface>
  );
}
const ManagerEditable = z.object({
  revision: z.number().int().nonnegative(),
  base_vote_revision: z.number().int().nonnegative(),
  action: z.enum(['close', 'extend', 'cancel', 'remove', 'bot_sync', 'bot_retry', 'finalize']),
  reason: z.string(),
  deadline: z.string(),
  option_id: z.string(),
  registration_deadline: z.string(),
  starts_at: z.string(),
  duration_hours: z.number(),
  bot_enabled: z.boolean(),
  outbox_id: z.number().int().nonnegative(),
});
function managerBlank(p: Poll): z.infer<typeof ManagerEditable> {
  return {
    revision: p.revision,
    base_vote_revision: p.vote_revision,
    action: p.can_manage ? 'close' : 'remove',
    reason: '',
    deadline: p.deadline,
    option_id: '',
    registration_deadline: '',
    starts_at: '',
    duration_hours: p.duration_hours ?? 3,
    bot_enabled: !!p.bot_enabled,
    outbox_id: 0,
  };
}
function managerInput(v: z.infer<typeof ManagerEditable>, p: Poll) {
  const common = { revision: v.revision, reason: v.reason, confirm: true as const };
  return ManageTimePoll.parse({
    ...common,
    action: v.action,
    ...(v.action === 'extend'
      ? { deadline: v.deadline }
      : v.action === 'bot_sync'
        ? { bot_enabled: v.bot_enabled }
        : v.action === 'bot_retry'
          ? { outbox_id: v.outbox_id }
          : v.action === 'finalize'
            ? {
                base_vote_revision: v.base_vote_revision,
                option_id: v.option_id,
                registration_deadline: v.registration_deadline,
                accept_terms: true,
                ...(p.time_mode === 'date' ? { starts_at: v.starts_at, duration_hours: v.duration_hours } : {}),
              }
            : {}),
  });
}
function PollManager({ viewer, initial }: { viewer: Member; initial: Poll }) {
  const navigate = useNavigate(),
    client = useQueryClient(),
    [confirmed, setConfirmed] = useState(false),
    [removed, setRemoved] = useState(false);
  const form = useReviewedDraft({
    key: 'qgroup:rebuild:activity-draft:poll-manage:v1:' + viewer.scope + ':' + initial.id,
    viewer,
    initial,
    blank: managerBlank,
    valueSchema: ManagerEditable,
    saveSchema: ManageTimePoll,
    resultSchema: TimePollResult,
    endpoint: base(initial.id) + '/manage',
    latest: async (result) => {
      if (result && TimePollResult.parse(result).removed) return initial;
      const p = await api(base(initial.id) + '/manage', TimePoll, { headers: scoped(viewer) });
      return p;
    },
    fromPending: (input) => ({ ...managerBlank(initial), ...input }),
    matches: (v, input) => {
      try {
        return JSON.stringify(managerInput(v, initial)) === JSON.stringify(input);
      } catch {
        return false;
      }
    },
    afterRefresh: (p) => client.setQueryData(['private', viewer.scope, 'time-poll', initial.id, 'manage'], p),
    after: (p, result) => {
      const r = TimePollResult.parse(result);
      if (r.removed) setRemoved(true);
      else client.setQueryData(['private', viewer.scope, 'time-poll', initial.id, 'manage'], p);
      void client.invalidateQueries({ queryKey: ['private', viewer.scope, 'time-polls'] });
      void client.invalidateQueries({ queryKey: ['private', viewer.scope, 'time-poll', initial.id], exact: true });
    },
  });
  useEffect(() => {
    if (removed && !form.dirty) navigate('/time-polls');
  }, [removed, form.dirty]);
  const p = initial,
    v = form.draft.value,
    stale = v.revision !== p.revision || (v.action === 'finalize' && v.base_vote_revision !== p.vote_revision),
    edit = (patch: Partial<typeof v>) => {
      form.edit({ ...v, ...patch });
      setConfirmed(false);
    };
  return (
    <Surface className="detail activity-editor">
      <Heading level={2}>管理時間投票</Heading>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (form.draft.pending) void form.submit();
          else if (confirmed && !stale && v.action!=='bot_retry')
            try {
              void form.submit(managerInput(v, p));
            } catch {
              form.setMessage('請核對操作、候選、原因及時間欄位。');
            }
        }}
      >
        <fieldset disabled={form.locked}>
          <legend>操作</legend>
          <Field label="管理操作">
            <select
              value={v.action}
              onChange={(e) => edit({ action: ManagerEditable.shape.action.parse(e.target.value) })}
            >
              {[
                ['close', '提前截止'],
                ['extend', '調整截止並開放'],
                ['cancel', '取消投票'],
                ['finalize', '定案並建立活動'],
                ['bot_sync', '設定群同步'],
                ...(v.action==='bot_retry'?[['bot_retry','核對舊重送草稿']]:[]),
                ['remove', '移除投票'],
              ]
                .filter(([action]) => p.can_manage || action === 'remove')
                .map(([action, text]) => (
                  <option key={action} value={action}>
                    {text}
                  </option>
                ))}
            </select>
          </Field>
          {v.action === 'extend' && (
            <Field label="新的投票截止（含時區）">
              <input value={v.deadline} onChange={(e) => edit({ deadline: e.target.value })} />
            </Field>
          )}
          {v.action === 'finalize' && (
            <>
              <Field label="定案候選">
                <select value={v.option_id} onChange={(e) => edit({ option_id: e.target.value })}>
                  <option value="">請選擇</option>
                  {p.options.map((o) => (
                    <option key={o.id} value={o.id} disabled={o.expired}>
                      {label(o, p)} · 可以 {o.yes}
                      {o.expired ? ' · 已過期' : ''}
                    </option>
                  ))}
                </select>
              </Field>
              {p.time_mode === 'date' && (
                <>
                  <Field label="活動開始（含時區，須在候選日期內）">
                    <input value={v.starts_at} onChange={(e) => edit({ starts_at: e.target.value })} />
                  </Field>
                  <Field label="活動持續小時">
                    <input
                      type="number"
                      min="1"
                      max="24"
                      value={v.duration_hours}
                      onChange={(e) => edit({ duration_hours: Number(e.target.value) })}
                    />
                  </Field>
                </>
              )}
              <Field label="正式報名截止（含時區）">
                <input
                  value={v.registration_deadline}
                  onChange={(e) => edit({ registration_deadline: e.target.value })}
                />
              </Field>
              <Notice>
                票數版本 {v.base_vote_revision}
                。未選最高票、零票或未達最低人數須填原因；投票者不會自動報名，發起者會加入正式活動。
              </Notice>
            </>
          )}
          {v.action === 'bot_sync' && (
            <label className="consent">
              <input
                type="checkbox"
                checked={v.bot_enabled}
                onChange={(e) => edit({ bot_enabled: e.target.checked })}
              />
              <span>開放群同步</span>
            </label>
          )}
          {v.action === 'bot_retry' && (
            <Notice>請從<Link to={'/time-polls/'+encodeURIComponent(p.id)+'/bot-deliveries'}>群通知紀錄</Link>核對重送；已有待確認操作請先查回原結果。</Notice>
          )}
          <Field label="操作原因">
            <textarea value={v.reason} maxLength={200} onChange={(e) => edit({ reason: e.target.value })} />
          </Field>
          <label className="consent">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            <span>
              {v.action === 'finalize'
                ? '已核對場地、票數與安排，確認建立活動並另行接受報名。'
                : v.action === 'remove'
                  ? '確認移除投票；原票與歷史保留，已有活動不受移除影響。'
                  : '已核對操作，確認提交。'}
            </span>
          </label>
        </fieldset>
        {stale && <Notice>安排或票數已有更新，請重新核對。</Notice>}
        <Button
          type="submit"
          disabled={
            !!form.readError ||
            (!form.draft.pending &&
              (!confirmed || stale || v.action==='bot_retry' || (!p.can_manage && !(v.action === 'remove' && p.can_remove))))
          }
          loading={form.busy}
        >
          {form.draft.pending ? '確認原管理操作結果' : '提交管理操作'}
        </Button>
      </form>
      <Button
        variant="secondary"
        disabled={form.locked}
        onClick={() => {
          setConfirmed(false);
          void form.refresh((old, fresh) => ({
            ...old,
            revision: fresh.revision,
            base_vote_revision: fresh.vote_revision,
          }));
        }}
      >
        核對最新票數與安排，保留輸入
      </Button>
      <DraftFeedback form={form} />
      <details>
        <summary>填答者 · {p.respondent_count} 人</summary>
        {p.respondents?.map((r, i) => (
          <div key={i}>
            <Text>
              {r.name} · {r.updated_at}
            </Text>
            <ul>
              {p.options
                .filter((o) => r.choices[o.id])
                .map((o) => (
                  <li key={o.id}>
                    {label(o, p)}：{choices[r.choices[o.id]!]}
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </details>
      <details>
        <summary>群通知狀態</summary>
        <Text>
          {!p.bot_feature_enabled
            ? '管理員未啟用 bot'
            : !p.bot_notice_enabled
              ? '管理員未開啟投票通知'
              : p.bot_enabled
                ? '已開放群同步'
                : '未開放群同步'}
        </Text>
        {p.bot_delivery?.map((r) => (
          <Text key={r.id}>
            {r.id} · {r.state} · {r.last_error || '無錯誤'} · 嘗試 {r.attempts} 次
          </Text>
        ))}
      </details>
      <details>
        <summary>管理歷史</summary>
        {p.history?.map((h, i) => (
          <Text key={i}>
            {h.created_at} ·{' '}
            {{
              created: '建立',
              close: '提前截止',
              extend: '調整截止',
              cancel: '取消',
              remove: '移除',
              finalize: '定案',
              bot_sync: '設定群同步',
              bot_retry: '重送通知',
            }[h.action] ?? h.action}
            {h.details.reason ? ' · ' + h.details.reason : ''}
            {h.details.deadline ? ' · ' + h.details.deadline : ''}
          </Text>
        ))}
      </details>
    </Surface>
  );
}
