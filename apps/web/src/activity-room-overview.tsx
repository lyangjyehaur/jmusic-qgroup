import { uiText } from './language';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button, Heading, Surface, Text } from 'yahha-ui';
import { ActivityRoomOverview, RoomPlanHistory, type Viewer } from '@qgroup/contracts';
import type { z } from 'zod';
import { api } from './api';
import { Failure, Notice, PageIntro, useSession } from './shared';
type Overview = z.infer<typeof ActivityRoomOverview>;
const base = (id: string) => '/activities/' + encodeURIComponent(id),
  scoped = (viewer: Viewer) => ({ 'X-Account-Scope': viewer.scope });
const statuses: Record<string, string> = {
  waiting: uiText("候補"),
  tentative: uiText("待確認"),
  withdrawn: uiText("已退出"),
};
function People({ people }: { people: Overview['unassigned'] }) {
  return (
    <ul>
      {people.map((p) => (
        <li key={p.id}>
          {p.name}
          {p.is_me ? ' · 我' : p.managed_guest ? ' · 我代報' : ''}
          {statuses[p.status] ? ' · ' + statuses[p.status] : ''}
        </li>
      ))}
    </ul>
  );
}
export function RoomOverviewContent({ data: d }: { data: Overview }) {
  const mine = d.rooms.find((r) => r.id === d.my_room_id);
  return (
    <>
      {d.historical && (
        <Notice>
          預分歷史的姓名與本人標示依目前名單顯示；已退出者顯示「名單已變更」。結算帳單保留發布時姓名。
        </Notice>
      )}
      {d.has_self && d.rooms.length > 0 && (
        <Text>
          <strong>我的包間：{mine ? mine.name : '待分配'}</strong>
          {d.self_waiting && d.kind === 'plan' ? ' · 候補預分，不代表正式名額' : ''}
        </Text>
      )}
      {!d.rooms.length ? (
        <Notice>{d.kind === 'actual' ? '這版結算沒有按包間分配。' : '尚未安排包間。'}</Notice>
      ) : (
        <div className="event-grid">
          {d.rooms.map((room) => (
            <section
              className={'room-overview-card' + (room.id === d.my_room_id ? ' room-overview-mine' : '')}
              key={room.id}
              aria-label={room.name}
            >
              <Heading level={3}>
                {room.name} · {room.people.length} 人
              </Heading>
              <Text>店家付款／收款人：{room.payer_name}</Text>
              {room.people.length ? <People people={room.people} /> : <Text>尚無人員</Text>}
            </section>
          ))}
        </div>
      )}
      {d.rooms.length > 0 && d.unassigned.length > 0 && (
        <section aria-label="未分配人員">
          <Heading level={3}>待分配 · {d.unassigned.length} 人</Heading>
          <People people={d.unassigned} />
        </section>
      )}
      {d.rooms.length > 0 && (
        <Notice>
          {d.kind === 'actual'
            ? '以上是本版結算確認的實際包間。'
            : '預分安排不代表正式名額或已經付款，最終按核對後的實際包間結算。'}
        </Notice>
      )}
    </>
  );
}
export function ActivityRoomOverviewSection({ eventId, viewer }: { eventId: string; viewer: Viewer }) {
  const query = useQuery({
    queryKey: ['private', viewer.scope, 'room-overview', eventId],
    queryFn: () =>
      api(base(eventId) + '/rooms/overview', ActivityRoomOverview, {
        headers: scoped(viewer),
      }),
  });
  return (
    <Surface className="detail" id="rooms" role="region" aria-label="包間安排">
      <div className="roster-title">
        <Heading level={2}>{query.data?.kind === 'actual' ? '實際包間' : '預分包間'}</Heading>
        <Button variant="secondary" loading={query.isFetching} onClick={() => void query.refetch()}>
          更新包間
        </Button>
      </div>
      {query.isPending ? (
        <Notice>正在讀取包間…</Notice>
      ) : query.error ? (
        <Failure error={query.error} retry={() => void query.refetch()} />
      ) : (
        <>
          <RoomOverviewContent data={query.data} />
          <div className="page-actions">
            {query.data.can_manage && <Link to={base(eventId) + '/rooms'}>分配預分包間</Link>}
            <Link to={base(eventId) + '/rooms/history'}>預分安排歷史</Link>
            {query.data.kind === 'actual' && (
              <Link to={base(eventId) + '/settlement?version=' + query.data.version}>查看本版結算</Link>
            )}
          </div>
        </>
      )}
    </Surface>
  );
}
export function RoomPlanHistoryPage() {
  const { id = '' } = useParams(),
    session = useSession();
  return (
    <>
      <PageIntro title="預分安排歷史" />
      <div className="page-actions">
        <Link to={base(id) + '#rooms'}>回到活動包間</Link>
        <Link to={base(id) + '/settlement'}>結算與實際包間歷史</Link>
      </div>
      {session.error ? (
        <Failure error={session.error} retry={() => void session.refetch()} />
      ) : !session.data ? (
        <Notice>正在確認帳號…</Notice>
      ) : (
        <History key={session.data.scope + ':' + id} id={id} viewer={session.data} />
      )}
    </>
  );
}
function History({ id, viewer }: { id: string; viewer: Viewer }) {
  const [before, setBefore] = useState<number | undefined>(),
    [selected, setSelected] = useState<number | undefined>();
  const query = useQuery({
    queryKey: ['private', viewer.scope, 'room-plan-history', id, before],
    queryFn: () =>
      api(base(id) + '/rooms/history' + (before ? '?before=' + before : ''), RoomPlanHistory, {
        headers: scoped(viewer),
      }),
  });
  const snapshot = useQuery({
    queryKey: ['private', viewer.scope, 'room-plan-version', id, selected],
    enabled: selected !== undefined,
    queryFn: () =>
      api(base(id) + '/rooms/history/' + selected, ActivityRoomOverview, {
        headers: scoped(viewer),
      }),
  });
  return (
    <>
      {query.isPending ? (
        <Notice>正在讀取歷史…</Notice>
      ) : query.error ? (
        <Failure error={query.error} retry={() => void query.refetch()} />
      ) : (
        <Surface className="detail">
          <Heading level={2}>{query.data.title}</Heading>
          {query.data.revisions.length ? (
            <ul>
              {query.data.revisions.map((r) => (
                <li key={r.version}>
                  <Button
                    variant="ghost"
                    aria-pressed={r.version === selected}
                    onClick={() => setSelected(r.version)}
                  >
                    預分第 {r.version} 版 · {r.room_count} 間
                  </Button>
                  <Text>{r.created_at}</Text>
                </li>
              ))}
            </ul>
          ) : (
            <Notice>尚無預分安排版本。</Notice>
          )}
          <div className="pagination">
            {before && <Button onClick={() => setBefore(undefined)}>最新版本</Button>}
            {query.data.next_before && (
              <Button onClick={() => setBefore(query.data.next_before!)}>更早的版本</Button>
            )}
          </div>
        </Surface>
      )}
      {selected !== undefined &&
        (snapshot.isPending ? (
          <Notice>正在讀取原安排…</Notice>
        ) : snapshot.error ? (
          <Failure error={snapshot.error} retry={() => void snapshot.refetch()} />
        ) : (
          <Surface className="detail" role="region" aria-label="歷史包間安排">
            <Heading level={2}>預分第 {snapshot.data.version} 版</Heading>
            <RoomOverviewContent data={snapshot.data} />
          </Surface>
        ))}
    </>
  );
}
