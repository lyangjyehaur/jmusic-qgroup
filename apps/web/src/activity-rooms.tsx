import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Heading, Surface } from 'yahha-ui';
import { z } from 'zod';
import { RoomPlanInput, RoomPlanView, SaveRoomPlan, SettlementResult } from '@qgroup/contracts';
import { api } from './api';
import { MemberAccess, type Member } from './member-access';
import { Failure, Notice, PageIntro } from './shared';
import { useReviewedDraft } from './reviewed-draft';
import { DraftFeedback } from './activity-settlement';
import { Field, newSettlementId, RoomFields } from './settlement-controls';
const Editable = z
  .object({
    revision: z.number().int().nonnegative(),
    rooms: z.array(RoomPlanInput.extend({ name: z.string(), payer_id: z.string() })).max(50),
    reason: z.string(),
  })
  .strict();
const base = (id: string) => '/activities/' + encodeURIComponent(id);
export function ActivityRoomsPage() {
  const { id = '' } = useParams();
  return (
    <>
      <PageIntro title="預分包間" />
      <div className="page-actions">
        <Link to={base(id)+'#rooms'}>回到活動包間</Link><Link to={base(id)+'/rooms/history'}>預分安排歷史</Link>
        <Link to={base(id) + '/settlement'}>逐人結算</Link>
        <Link to={base(id) + '/finance'}>收付款帳本</Link>
      </div>
      <MemberAccess>{(viewer) => <Loader key={viewer.scope + ':' + id} viewer={viewer} id={id} />}</MemberAccess>
    </>
  );
}
function Loader({ viewer, id }: { viewer: Member; id: string }) {
  const query = useQuery({
    queryKey: ['private', viewer.scope, 'room-plan', id],
    queryFn: () => api(base(id) + '/rooms', RoomPlanView, { headers: { 'X-Account-Scope': viewer.scope } }),
    refetchOnWindowFocus: false,
  });
  return query.isPending ? (
    <Notice>正在讀取包間…</Notice>
  ) : query.error ? (
    <Failure error={query.error} retry={() => void query.refetch()} />
  ) : (
    <Editor viewer={viewer} initial={query.data} />
  );
}
function Editor({ viewer, initial }: { viewer: Member; initial: z.infer<typeof RoomPlanView> }) {
  const endpoint = base(initial.id) + '/rooms',
    client = useQueryClient(),
    [confirmed, setConfirmed] = useState(false),
    form = useReviewedDraft({
      key: 'qgroup:rebuild:activity-draft:rooms:v1:' + viewer.scope + ':' + initial.id,
      viewer,
      initial,
      blank: (fresh) => ({
        revision: fresh.revision,
        rooms: fresh.rooms.map(({ id, name, payer_id, person_ids }) => ({ id, name, payer_id, person_ids })),
        reason: '',
      }),
      valueSchema: Editable,
      saveSchema: SaveRoomPlan,
      resultSchema: SettlementResult,
      endpoint,
      latest: () => api(endpoint, RoomPlanView, { headers: { 'X-Account-Scope': viewer.scope } }),
      fromPending: ({ confirm, ...value }) => {
        void confirm;
        return value;
      },
      matches: (value, input) => {
        const { confirm, ...rest } = input;
        void confirm;
        return JSON.stringify(value) === JSON.stringify(rest);
      },
      after: (fresh) => {
        client.setQueryData(['private', viewer.scope, 'room-plan', initial.id], fresh);
        for (const name of ['room-plan', 'room-overview', 'room-plan-history', 'settlement-context', 'activity-history', 'finance'])
          void client.invalidateQueries({ queryKey: ['private', viewer.scope, name] });
      },
    }),
    value = form.draft.value,
    stale = value.revision !== form.data.revision;
  const edit = (patch: Partial<typeof value>) => {
    form.edit({ ...value, ...patch });
    setConfirmed(false);
  };
  return (
    <Surface className="detail activity-editor">
      <Heading level={2}>
        {form.data.title} · 預分第 {form.data.version} 版
      </Heading>
      <Notice>預分包間不會登記付款；實際包間與費用在逐人結算時再次核對。每位人員最多分配一個包間。</Notice>
      {form.data.blocked_reason && <Notice>{form.data.blocked_reason}</Notice>}
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (form.draft.pending) void form.submit();
          else if (confirmed && !stale && form.data.can_manage) {
            const parsed = SaveRoomPlan.safeParse({ ...value, confirm: true });
            if (parsed.success) void form.submit(parsed.data);
            else form.setMessage('請填寫包間名稱、付款人並核對人員。');
          }
        }}
      >
        <fieldset disabled={form.locked || !form.data.can_manage}>
          <legend>包間安排</legend>
          <RoomFields
            rooms={value.rooms}
            people={form.data.people}
            payers={form.data.payers}
            change={(rooms) => edit({ rooms })}
            create={() => ({ id: newSettlementId(), name: '', payer_id: '', person_ids: [] })}
          />
          <Field label="調整原因（最多 300 字）">
            <textarea rows={2} value={value.reason} onChange={(e) => edit({ reason: e.target.value })} />
          </Field>
          <label className="consent">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            <span>已核對包間人員與付款人，確認保存。</span>
          </label>
        </fieldset>
        {stale && <Notice>原稿使用較舊名冊，請先核對最新版。</Notice>}
        <Button
          type="submit"
          loading={form.busy}
          disabled={!!form.readError || (!form.draft.pending && (!confirmed || stale || !form.data.can_manage))}
        >
          {form.draft.pending ? '確認原包間保存結果' : '保存預分包間'}
        </Button>
      </form>
      <Button
        variant="secondary"
        disabled={form.locked}
        onClick={() => {
          setConfirmed(false);
          void form.refresh((old, fresh) => ({ ...old, revision: fresh.revision }));
        }}
      >
        核對最新名冊，保留輸入
      </Button>
      <DraftFeedback form={form} />
    </Surface>
  );
}
