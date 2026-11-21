import { uiText } from './language';
import { useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Heading, Surface } from 'yahha-ui';
import { z } from 'zod';
import { RoomPlanView, SaveRoomPlan, RoomSuggestionTransfer } from '@qgroup/contracts';
import { scopedHttp } from './http';
import { authHttp } from './auth';
import { MemberAccess, type Member } from './member-access';
import { Failure, Notice, PageIntro } from './shared';
import { useReviewedDraft } from './reviewed-draft';
import { RoomEditorValue as Editable,roomPlanInput } from './room-editor-record';
import { requireLegacyAvailable } from './legacy-local-availability';
import { DraftFeedback } from './activity-settlement';
import { Field, newSettlementId, RoomFields } from './settlement-controls';
const base = (id: string) => '/activities/' + encodeURIComponent(id);
export function ActivityRoomsPage() {
  const { id = '' } = useParams();
  return (
    <>
      <PageIntro title="預分包間" />
      <div className="page-actions">
        <Link to={base(id) + '#rooms'}>回到活動包間</Link>
        <Link to={'/tools/room-lab?' + new URLSearchParams({ eventId: id })}>按成分試算分房</Link>
        <Link to={base(id) + '/rooms/history'}>預分安排歷史</Link>
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
    queryFn: () =>
      scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/rooms', { params: { id } }),
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
  const location = useLocation(),
    candidate = RoomSuggestionTransfer.safeParse(location.state?.roomSuggestion),
    suggestion =
      candidate.success && candidate.data.scope === viewer.scope && candidate.data.eventId === initial.id
        ? candidate.data
        : null,
    [imported, setImported] = useState(false),
    [replaceConfirmed, setReplaceConfirmed] = useState(false),
    source = useQuery({
      queryKey: ['private', viewer.scope, 'room-lab-adoption', initial.id, suggestion?.sourceVersion],
      enabled: !!suggestion && !imported,
      queryFn: ({ signal }) =>
        scopedHttp(viewer.scope).requestContract('GET /api/v2/music/rooms/source', { signal, query: { eventId: initial.id } }),
      staleTime: 0,
      refetchOnMount: 'always',
      refetchOnWindowFocus: 'always',
    }),
    endpoint = base(initial.id) + '/rooms',
    client = useQueryClient(),
    [confirmed, setConfirmed] = useState(false),
    form = useReviewedDraft({
      key: 'qgroup:rebuild:activity-draft:rooms:v1:' + viewer.scope + ':' + initial.id,
      viewer,
      initial,
      blank: (fresh): z.infer<typeof Editable> => ({
        revision: fresh.revision,
        rooms: fresh.rooms.map(({ id, name, payer_id, person_ids }) => ({
          id,
          name,
          payer_id,
          person_ids,
        })),
        reason: '',
      }),
      valueSchema: Editable,
      saveSchema: SaveRoomPlan,
      send: (input, requestId) => authHttp(viewer).requestContract('POST /api/v2/activities/:id/rooms', { params: { id: initial.id }, body: input, requestId, requestScope: viewer.scope }),
      beforeSubmit:()=>requireLegacyAvailable(viewer.scope,endpoint),
      latest: () =>
        scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/rooms', { params: { id: initial.id } }),
      fromPending: ({ confirm, ...value }): z.infer<typeof Editable> => {
        void confirm;
        return value;
      },
      matches: (value, input) => {
        const { confirm, ...rest } = input;
        void confirm;
        return JSON.stringify(roomPlanInput(value)) === JSON.stringify(rest);
      },
      after: (fresh) => {
        client.setQueryData(['private', viewer.scope, 'room-plan', initial.id], fresh);
        for (const name of [
          'room-plan',
          'room-overview',
          'room-plan-history',
          'settlement-context',
          'activity-history',
          'finance',
        ])
          void client.invalidateQueries({
            queryKey: ['private', viewer.scope, name],
          });
      },
    }),
    value = form.draft.value,
    stale = value.revision !== form.data.revision||!!value.legacySource?.reviewRequired;
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
      {value.legacySource&&<Notice>已帶入舊包間原稿；原保存版本：{value.legacySource.baseRevision??'未記錄'}。{value.legacySource.reviewRequired?'請先核對最新名冊，原輸入保留。':''}{value.legacySource.notes.map((note,i)=><div key={i}>{note.field}：{note.original}。{note.message}</div>)}</Notice>}
      {form.data.blocked_reason && <Notice>{form.data.blocked_reason}</Notice>}
      {suggestion && !imported && (
        <section aria-label="採用分房建議">
          <Heading level={3}>核對分房建議</Heading>
          <Notice>載入會替換目前包間人員；保留原包間名稱、付款人及有款項的包間編號。仍須核對後保存。</Notice>
          <ul>
            {suggestion.rooms.map((members, index) => (
              <li key={index}>
                包間 {index + 1}：
                {members
                  .map((id) => form.data.people.find((person) => person.id === id)?.name ?? uiText('來源已移除'))
                  .join('、') || '空包間'}
              </li>
            ))}
          </ul>
          <Notice>
            待人工安排：
            {form.data.people
              .filter((person) => !suggestion.rooms.flat().includes(person.id))
              .map((person) => person.name)
              .join('、') || '無'}
          </Notice>
          {(source.error ||
            (source.data && (source.data.sourceVersion !== suggestion.sourceVersion || !source.data.canAdopt)) ||
            suggestion.revision !== form.data.revision) && (
            <Notice>建議來源或名冊已變更，請回到分房試算重新核對。</Notice>
          )}
          {source.error && <Failure error={source.error} retry={() => void source.refetch()} />}
          {form.dirty && (
            <label className="consent">
              <input
                type="checkbox"
                checked={replaceConfirmed}
                onChange={(e) => setReplaceConfirmed(e.target.checked)}
              />
              <span>確認以建議替換目前草稿的人員安排</span>
            </label>
          )}
          <Button
            disabled={
              form.locked ||
              !form.data.can_manage ||
              !source.isFetchedAfterMount ||
              source.isFetching ||
              !!source.error ||
              source.data?.sourceVersion !== suggestion.sourceVersion ||
              !source.data?.canAdopt ||
              suggestion.revision !== form.data.revision ||
              (form.dirty && !replaceConfirmed)
            }
            onClick={() => {
              const rooms = Array.from(
                {
                  length: Math.max(value.rooms.length, suggestion.rooms.length),
                },
                (_, index) => ({
                  ...(value.rooms[index] ?? {
                    id: newSettlementId(),
                    name: '包間 ' + (index + 1),
                    payer_id: '',
                    person_ids: [],
                  }),
                  person_ids: suggestion.rooms[index] ?? [],
                }),
              );
              edit({ rooms, music_source_version: suggestion.sourceVersion });
              setImported(true);
            }}
          >
            載入建議到草稿
          </Button>
        </section>
      )}
      {value.music_source_version && (
        <Notice>保存時會再次核對成分與活動來源；如需保留目前人員並自行負責核對，可轉為手動安排。</Notice>
      )}
      {value.music_source_version && (
        <Button variant="secondary" disabled={form.locked} onClick={() => edit({ music_source_version: undefined })}>
          轉為手動安排
        </Button>
      )}
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (form.draft.pending) void form.submit();
          else if (confirmed && !stale && form.data.can_manage) {
            const parsed = SaveRoomPlan.safeParse({ ...roomPlanInput(value), confirm: true });
            if (parsed.success) void form.submit(parsed.data);
            else form.setMessage(uiText("請填寫包間名稱、付款人並核對人員。"));
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
            create={() => ({
              id: newSettlementId(),
              name: '',
              payer_id: '',
              person_ids: [],
            })}
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
          void form.refresh((old, fresh) => ({
            ...old,
            revision: fresh.revision,
            ...(old.legacySource?{legacySource:{...old.legacySource,reviewRequired:false}}:{}),
          }));
        }}
      >
        核對最新名冊，保留輸入
      </Button>
      <DraftFeedback form={form} />
    </Surface>
  );
}
