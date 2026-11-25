import { uiText, displayLocale } from './language';
import { useEffect, useState, type CSSProperties } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Heading, Surface, Text } from 'yahha-ui';
import { Badge, Button, EmptyState, PageHeader, Select } from './kimi-ui';
import { ArrowLeft, ArrowUpRight, CalendarPlus, Clock3, Copy, MapPin, UsersRound, Vote } from 'lucide-react';
import { activityDisplayDate } from './activity-summary';
import { ActivityBrowseTabs } from './activity-browse-tabs';
import { ActionLink } from './action-link';
import { z } from 'zod';
import { ActivityCategory, CreateTimePoll, ManageTimePoll, PollChoice, TimePoll, TimePollResult, VoteTimePoll, type Viewer } from '@qgroup/contracts';
import { scopedHttp } from './http';
import { authHttp } from './auth';
import { Failure, Notice, useSession } from './shared';
import { MemberAccess, type Member } from './member-access';
import { useReviewedDraft } from './reviewed-draft';
import { LegacyLocalGuard } from './legacy-local';
import { requireLegacyAvailable } from './legacy-local-availability';
import { DraftFeedback } from './activity-settlement';
import { Field } from './settlement-controls';
import { PollCalendar } from './poll-calendar';
import { CreateIntentLookup } from './create-intents';
import { EditablePollDefinition as EditableDefinition,pollCreateInput as createInput } from './poll-create-record';
type Poll = z.infer<typeof TimePoll>;
const base = (id: string) => '/time-polls/' + encodeURIComponent(id);
const choices = { yes: uiText("可以"), maybe: uiText("勉強可以"), no: uiText("不行") } as const;
const states = { open: uiText("投票中"), closed: uiText("已截止"), cancelled: uiText("已取消"), finalized: uiText("已定案"), deleted: uiText("已移除") };
const label = (o: Poll['options'][number], p: Poll) =>
  o.starts_at
    ? new Intl.DateTimeFormat(displayLocale(), { timeZone: p.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(o.starts_at),
      )
    : o.date;
export function TimePollsPage() {
  const session = useSession(),
    [search, setSearch] = useSearchParams(),
    period = search.get('period') === 'history' ? 'history' : 'active',
    page = Math.max(1, Math.min(10000, Number(search.get('page')) || 1));
  const query = useQuery({
    queryKey: ['private', session.data?.scope, 'time-polls', period, page],
    enabled: !!session.data,
    queryFn: () =>
      scopedHttp(session.data!.scope).requestContract('GET /api/v2/time-polls', { query: { period, page } }),
  });
  return (
    <div className="kimi page activities-page polls-page">
      <PageHeader title="時間投票" actions={<ActionLink variant="primary" to="/time-polls/new" startIcon={<CalendarPlus size={17}/>}>發起時間投票</ActionLink>}/>
      <div className="list-toolbar">
        <ActivityBrowseTabs value="polls"/>
        <div className="filter-row poll-period-filter"><Select aria-label="投票範圍" value={period} onChange={event => setSearch({ period: event.target.value })}>
          <option value="active">開放與待定案</option><option value="history">往期投票</option>
        </Select></div>
      </div>
      {session.error ? (
        <Failure error={session.error} retry={() => void session.refetch()} />
      ) : query.isPending ? (
        <Notice>正在讀取投票…</Notice>
      ) : query.error ? (
        <Failure error={query.error} retry={() => void query.refetch()} />
      ) : <>
        <section className="time-poll-list" aria-label="時間投票列表">
          {query.data.polls.map(p => <article className="time-poll-row" key={p.id}>
            <div className="poll-row-icon" aria-hidden="true"><Vote size={21}/></div>
            <div className="poll-row-main"><h2><Link to={base(p.id)}>{p.title}</Link></h2>
              <div className="poll-row-meta"><span><MapPin size={14}/>{p.location}</span><span><Clock3 size={14}/>截止 {activityDisplayDate(p.deadline, p.timezone)}</span></div>
            </div>
            <div className="poll-row-counts"><span><strong>{p.respondent_count}</strong> 人填答</span><small>{p.options.length} 項候選</small></div>
            <div className="poll-row-status"><Badge dot tone={p.status==='open'?'green':p.status==='cancelled'?'red':p.status==='finalized'?'blue':'neutral'}>{states[p.status]}</Badge></div>
            <Link className="row-arrow poll-row-arrow" to={base(p.id)} aria-label={'查看時間投票：'+p.title}><ArrowUpRight size={18}/></Link>
          </article>)}
          {!query.data.polls.length && <EmptyState title="這個篩選下沒有時間投票" description="可切換投票範圍，或發起新的時間投票。"/>}
        </section>
        {(page>1||query.data.hasMore)&&<div className="pagination">
          {page>1&&<Button variant="secondary" onClick={()=>setSearch({period,page:String(page-1)})}>上一頁</Button>}
          {query.data.hasMore&&<Button variant="secondary" onClick={()=>setSearch({period,page:String(page+1)})}>下一頁</Button>}
        </div>}
      </>}
    </div>
  );
}

const emptyDefinition = ():z.infer<typeof EditableDefinition> => ({
  client_intent: crypto.randomUUID(),
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
export function NewTimePollPage() {
  return <div className="kimi page poll-create-page form-page"><PageHeader title="發起時間投票" back={<Link to="/time-polls" className="back-link"><ArrowLeft size={18}/><span>時間投票</span></Link>}/>
    <MemberAccess>{viewer => <CreatePoll key={viewer.scope} viewer={viewer}/>}</MemberAccess>
  </div>;
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
    send: (input, requestId) => authHttp(viewer).requestContract('POST /api/v2/time-polls', { body: input, requestId, requestScope: viewer.scope }),
    beforeSubmit: () => requireLegacyAvailable(viewer.scope,'/time-polls/new'),
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
  useEffect(() => {
    if (!form.locked && !form.draft.value.client_intent)
      form.edit({ ...form.draft.value, client_intent: crypto.randomUUID() });
  }, [form.locked, form.draft.value.client_intent]);
  const v = form.draft.value,
    edit = (patch: Partial<typeof v>) => form.edit({ ...v, ...patch });
  const [lookedUp,setLookedUp]=useState<{scope:string;intent:string;id:string;epoch:number}|null>(null);
  const resolvedId=v.legacySource?.resolvedId??(lookedUp&&lookedUp.scope===viewer.scope&&lookedUp.epoch===form.epoch&&lookedUp.intent===v.client_intent?lookedUp.id:undefined);
  const alreadyCreated=!!resolvedId;
  return (
    <Surface className="detail activity-editor poll-create-form">
      <Notice>投票公開可見，請勿填寫私人資訊。投票不占名額，定案後須另行報名。</Notice>
      {v.legacySource&&<Notice>{alreadyCreated?'原投票已建立，此後續草稿保留，不能另建投票。':'已帶入舊稿，候選順序保留。'}{v.legacySource.notes.map((note,i)=><Text key={i}>{note.field}：{note.original||'未填'}。{note.message}；請在對應欄位補齊。</Text>)}{alreadyCreated&&<Link to={'/time-polls/'+encodeURIComponent(resolvedId!)}>查看原投票</Link>}</Notice>}
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if(alreadyCreated)return;
          if (form.draft.pending) void form.submit();
          else
            try {
              void form.submit(createInput(v));
            } catch {
              form.setMessage(uiText("請填寫活動安排、截止時間及至少兩個候選。"));
            }
        }}
      >
        <fieldset disabled={form.locked||alreadyCreated}>
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
              onChange={(e) => edit({ capacity: e.target.value })}
            />
          </Field>
          <Field label="最低成團人數">
            <input
              type="number"
              min="0"
              max="500"
              value={v.minimum_participants}
              onChange={(e) => edit({ minimum_participants: e.target.value })}
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
                if (v.options.some(Boolean) && !window.confirm(uiText('切換模式會清除已填候選，確定切換？'))) return;
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
                onChange={(e) => edit({ duration_hours: e.target.value })}
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
          <Button className="poll-add-option" variant="secondary" onClick={() => edit({ options: [...v.options, ''] })}>
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
        <Button type="submit" disabled={!!form.readError||alreadyCreated} loading={form.busy}>
          {form.draft.pending ? '確認原投票建立結果' : '建立時間投票'}
        </Button>
      </form>
      <DraftFeedback form={form} />
      {v.client_intent&&!form.loading&&!form.readError&&<CreateIntentLookup key={viewer.scope+':'+v.client_intent+':'+form.epoch} viewer={viewer} kind="poll" intent={v.client_intent} disabled={form.busy} onExisting={id=>setLookedUp({scope:viewer.scope,epoch:form.epoch,intent:v.client_intent!,id})}/>}
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
    queryFn: () => scopedHttp(viewer!.scope).requestContract(manage ? 'GET /api/v2/time-polls/:id/manage' : 'GET /api/v2/time-polls/:id', { params: { id } }),
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
    <div className="kimi page poll-detail-page">
      <Link to="/time-polls" className="back-link"><ArrowLeft size={18}/><span>時間投票</span></Link>
      {session.error ? (
        <Failure error={session.error} retry={() => void session.refetch()} />
      ) : query.isPending ? (
        <Notice>正在讀取投票…</Notice>
      ) : query.error ? (
        <Failure error={query.error} retry={() => void query.refetch()} />
      ) : (
        <PollDetails key={viewer!.scope + ':' + id + ':' + manage} poll={query.data} viewer={viewer!} manage={manage} />
      )}
    </div>
  );
}
function PollDetails({ poll: p, viewer, manage }: { poll: Poll; viewer: Viewer; manage: boolean }) {
  const [share, setShare] = useState('');
  return <>
    <div className="poll-detail-header"><PageHeader title={p.title} actions={<>
      <Button variant="secondary" onClick={() => void navigator.clipboard.writeText(p.title + uiText('\n一起選擇活動時間：\n') + location.origin + base(p.id)).then(() => setShare(uiText('已複製投票連結。')), () => setShare(uiText('無法複製，請複製瀏覽器網址。')))}><Copy size={15}/>複製投票連結</Button>
      {manage ? <ActionLink to={base(p.id)}>返回填答與結果</ActionLink> : p.is_owner && <ActionLink variant="primary" to={base(p.id)+'/manage'}>管理時間投票</ActionLink>}
      {manage&&p.is_owner&&<ActionLink to={base(p.id)+'/bot-deliveries'}>群通知紀錄</ActionLink>}
    </>}/>{share&&<p className="poll-share-status" role="status">{share}</p>}</div>
    <div className="poll-detail-status"><Badge dot tone={p.status==='open'?'green':p.status==='cancelled'?'red':p.status==='finalized'?'blue':'neutral'}>{states[p.status]}</Badge><Badge>{p.category}</Badge><span>{p.time_mode==='date'?'按日期投票':'精確時段投票'}</span></div>
    <section className="poll-summary-panel" aria-label="投票安排">
      <dl className="poll-summary-facts"><div><dt><MapPin size={15}/>地點</dt><dd>{p.location}</dd></div><div><dt><Clock3 size={15}/>投票截止</dt><dd>{activityDisplayDate(p.deadline,p.timezone)}</dd></div><div><dt><UsersRound size={15}/>填答人數</dt><dd><strong>{p.respondent_count}</strong> 人填答<span> · {p.options.length} 項候選</span></dd></div></dl>
      {p.description&&<p className="poll-description preserve-lines">{p.description}</p>}
      {p.reason&&<p className="poll-decision-reason preserve-lines">原因：{p.reason}</p>}
      <details className="poll-arrangement-details"><summary>完整投票安排</summary><dl><dt>時區</dt><dd>{p.timezone}</dd><dt>人數</dt><dd>上限 {p.capacity||'不限'} · 最低 {p.minimum_participants}</dd><dt>發起者</dt><dd>{p.owner_name}</dd>{p.duration_hours!==null&&<><dt>每場預計</dt><dd>{p.duration_hours} 小時</dd></>}{p.fee_policy&&<><dt>費用</dt><dd className="preserve-lines">{p.fee_policy}</dd></>}</dl></details>
    </section>
    <div className="poll-guidance"><Notice>投票不占名額；定案後請核對活動安排再報名。</Notice>{p.event_id&&<ActionLink variant="primary" to={'/activities/'+encodeURIComponent(p.event_id)}>查看定案活動並報名</ActionLink>}{p.event_deleted&&<Notice>定案活動已移除，原投票結果保留。</Notice>}{!viewer.authenticated&&<Notice><Link to={'/login?returnTo='+encodeURIComponent(base(p.id))}>登入</Link>後可填答。</Notice>}</div>
    {manage ? p.is_owner&&viewer.authenticated ? <div className="poll-management-layout"><LegacyLocalGuard><PollManager key={'manage:'+viewer.scope} viewer={viewer} initial={p}/></LegacyLocalGuard><PollResults poll={p}/></div> : <Notice>只有發起者可以管理時間投票。</Notice> : viewer.authenticated ? <LegacyLocalGuard><VoteEditor key={'votes:'+viewer.scope} viewer={viewer} initial={p}/></LegacyLocalGuard> : <PollResults poll={p}/>}
  </>;
}
function PollTally({option:o}:{option:Poll['options'][number]}){
 const total=Math.max(1,o.yes+o.maybe+o.no);
 return <div className="vote-stats" aria-label="填答分佈">{[[o.yes,choices.yes],[o.maybe,choices.maybe],[o.no,choices.no]].map(([count,label],index)=><span key={index} style={{'--vote-width':Number(count)/total*100+'%'} as CSSProperties}>{label} {count}</span>)}</div>;
}
function PollResults({ poll: p }: { poll: Poll }) {
  return <section className="poll-results-panel" aria-label="投票統計"><div className="vote-heading"><Heading level={2}>候選統計</Heading><span>{p.respondent_count} 人填答</span></div><div className="vote-options">
    {p.options.map(o=><article key={o.id} className={'vote-option'+(p.selected_option_id===o.id?' final':'')+(o.expired?' expired':'')}><div className="vote-option-title"><Heading level={3}>{label(o,p)}</Heading><div className="poll-option-badges">{o.expired&&<Badge>已過期</Badge>}{p.leading_option_ids.includes(o.id)&&<Badge tone="green">最高票</Badge>}{p.selected_option_id===o.id&&<Badge tone="blue">已定案</Badge>}</div></div><PollTally option={o}/></article>)}
  </div></section>;
}
const EditableVotes = z
  .object({ revision: z.number().int().nonnegative(), ballot_token: VoteTimePoll.shape.ballot_token, choices: z.record(z.string(), PollChoice) })
  .strict();
function VoteEditor({ viewer, initial }: { viewer: Member; initial: Poll }) {
  const client = useQueryClient(),
    key = ['private', viewer.scope, 'time-poll', initial.id];
  const form = useReviewedDraft({
    key: 'qgroup:rebuild:activity-draft:poll-vote:v1:' + viewer.scope + ':' + initial.id,
    viewer,
    initial,
    blank: (p) => ({ revision: p.revision, ballot_token: p.ballot_token, choices: p.my_choices }),
    valueSchema: EditableVotes,
    saveSchema: VoteTimePoll,
    beforeSubmit: () => requireLegacyAvailable(viewer.scope,base(initial.id)),
    send: (input, requestId) => authHttp(viewer).requestContract('POST /api/v2/time-polls/:id/votes', { params: { id: initial.id }, body: input, requestId, requestScope: viewer.scope }),
    latest: async () => {
      const p = await scopedHttp(viewer.scope).requestContract('GET /api/v2/time-polls/:id', { params: { id: initial.id } });
      return p;
    },
    fromPending: (input) => ({
      revision: input.revision,
      ballot_token: input.ballot_token,
      choices: Object.fromEntries(input.choices.map((c) => [c.option_id, c.choice])),
    }),
    matches: (v, input) =>
      v.revision === input.revision &&
      v.ballot_token === input.ballot_token &&
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
  const stale = v.revision !== p.revision || !v.ballot_token || v.ballot_token !== p.ballot_token;
  return (
    <section className="poll-vote-card vote-workspace">
      <div className="vote-heading"><Heading level={2}>我的填答</Heading><span role="status">已填 {filled} / {active.length} 個有效候選</span></div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (form.draft.pending) void form.submit();
          else if (filled === active.length && !stale && p.can_vote)
            void form.submit({
              revision: v.revision,
              ballot_token: v.ballot_token,
              choices: p.options
                .filter((o) => v.choices[o.id])
                .map((o) => ({ option_id: o.id, choice: v.choices[o.id]! })),
            });
        }}
      >
        <fieldset className="poll-ballot-fields" disabled={form.locked || !p.can_vote}>
          <legend className="sr-only">逐項意願</legend>
          <div className="poll-bulk-actions"><span>未填項全選</span><div>
            {Object.entries(choices).map(([choice, text]) => (
              <Button
                key={choice}
                variant="secondary"
                size="sm" type="button" aria-label={'未填項全選'+text}
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
                {text}
              </Button>
            ))}
          </div></div>
          <div className="vote-options">{p.options.map((o) => (
            <fieldset key={o.id} disabled={o.expired} className={'poll-choice vote-option'+(p.selected_option_id===o.id?' final':'')+(o.expired?' expired':'')}>
              <legend className="sr-only">
                {label(o, p)}
                {o.expired ? ' · 已過期' : ''}
                {p.leading_option_ids.includes(o.id) ? ' · 最高票' : ''}
              </legend>
              <div className="vote-option-title"><Heading level={3}>{label(o,p)}</Heading><div className="poll-option-badges">{o.expired&&<Badge>已過期</Badge>}{p.leading_option_ids.includes(o.id)&&<Badge tone="green">最高票</Badge>}{p.selected_option_id===o.id&&<Badge tone="blue">已定案</Badge>}</div></div>
              <PollTally option={o}/><div className="poll-answers">
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
          ))}</div>
        </fieldset>
        {stale && <Notice>填答或投票安排已變更，請核對最新版；原選擇保留。</Notice>}
        <div className="poll-submit-actions"><Button
          type="submit"
          loading={form.busy}
          disabled={!!form.readError || (!form.draft.pending && (!p.can_vote || stale || filled !== active.length))}
        >
          {form.draft.pending ? '確認原填答結果' : p.has_voted ? '保存改票' : '提交填答'}
        </Button>
      <Button
        variant="text" type="button"
        disabled={form.locked}
        onClick={() => void form.refresh((old, fresh) => ({ ...old, revision: fresh.revision, ballot_token: fresh.ballot_token }))}
      >
        核對最新候選，保留選擇
      </Button></div>
      </form>
      <DraftFeedback form={form} />
    </section>
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
    beforeSubmit: () => requireLegacyAvailable(viewer.scope,base(initial.id)+'/manage'),
    send: (input, requestId) => authHttp(viewer).requestContract('POST /api/v2/time-polls/:id/manage', { params: { id: initial.id }, body: input, requestId, requestScope: viewer.scope }),
    latest: async (result) => {
      if (result && TimePollResult.parse(result).removed) return initial;
      const p = await scopedHttp(viewer.scope).requestContract('GET /api/v2/time-polls/:id/manage', { params: { id: initial.id } });
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
    <section className="poll-manager-panel activity-editor">
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
              form.setMessage(uiText("請核對操作、候選、原因及時間欄位。"));
            }
        }}
      >
        <fieldset className="poll-manager-fields" disabled={form.locked}>
          <legend className="sr-only">操作</legend>
          <Field label="管理操作">
            <select
              value={v.action}
              onChange={(e) => edit({ action: ManagerEditable.shape.action.parse(e.target.value) })}
            >
              {[
                ['close', uiText('提前截止')],
                ['extend', uiText('調整截止並開放')],
                ['cancel', uiText('取消投票')],
                ['finalize', uiText('定案並建立活動')],
                ['bot_sync', uiText('設定群同步')],
                ...(v.action==='bot_retry'?[['bot_retry',uiText('核對舊重送草稿')]]:[]),
                ['remove', uiText('移除投票')],
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
      <details className="poll-admin-disclosure">
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
      <details className="poll-admin-disclosure">
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
      <details className="poll-admin-disclosure">
        <summary>管理歷史</summary>
        {p.history?.map((h, i) => (
          <Text key={i}>
            {h.created_at} ·{' '}
            {{
              created: uiText('建立'),
              close: uiText('提前截止'),
              extend: uiText('調整截止'),
              cancel: uiText('取消'),
              remove: uiText('移除'),
              finalize: uiText('定案'),
              bot_sync: uiText('設定群同步'),
              bot_retry: uiText('重送通知'),
            }[h.action] ?? h.action}
            {h.details.reason ? ' · ' + h.details.reason : ''}
            {h.details.deadline ? ' · ' + h.details.deadline : ''}
          </Text>
        ))}
      </details>
    </section>
  );
}
