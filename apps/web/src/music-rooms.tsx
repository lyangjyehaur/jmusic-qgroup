import { errorText, uiText } from './language';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button, Heading, Surface, Text } from 'yahha-ui';
import { z } from 'zod';
import {
  MemberMusicProfile,
  RoomLabAnalysis,
  RoomLabCommand,
  RoomLabResult,
  RoomLabRoomInput,
  RoomLabSource,
} from '@qgroup/contracts';
import { api,ApiError } from './api';
import { useDurableRecord } from './durable-record';
import { DraftFeedback } from './draft-feedback';
import { musicRoomDraftKey,parseMusicRoomDraft,MusicRoomDraft as Draft } from './music-room-record';
import { MusicMemberAccess, type Member } from './member-access';
import { Failure, Notice, PageIntro } from './shared';
import { MusicRoomShare } from './music-room-share';
type Source = z.infer<typeof RoomLabSource>;
const empty = (source: Source, includeMe = true): Draft => ({
  source,
  selected: source.eventId
    ? source.members
        .filter((m) => m.profileId)
        .slice(0, 40)
        .map((m) => m.id)
    : includeMe && source.selfId
      ? [source.selfId]
      : [],
  rooms: [],
  result: null,
  mode: 'rooms',
  value: '2',
  sizes: '',
  sameGender: false,
});
export function MusicRoomsPage() {
  const [params] = useSearchParams(),
    eventId = params.get('eventId') ?? '',
    location = useLocation();
  return (
    <>
      <PageIntro title={eventId ? '活動分房試算' : '自由分房'} />
      <div className="page-actions">
        <Link to={eventId ? '/activities/' + encodeURIComponent(eventId) + '#rooms' : '/people'}>
          {eventId ? '回到活動包間' : '回到同好'}
        </Link>
        {eventId && <Link to={'/activities/' + encodeURIComponent(eventId) + '/rooms'}>正式預分包間</Link>}
        {eventId && <Link to="/tools/room-lab">自由分房</Link>}
      </div>
      <MusicMemberAccess purpose="使用分房試算">
        {(viewer) => (
          <Loader
            key={viewer.scope + ':' + viewer.musicEpoch + ':' + eventId + ':' + location.key}
            viewer={viewer}
            eventId={eventId}
          />
        )}
      </MusicMemberAccess>
    </>
  );
}
function Loader({ viewer, eventId }: { viewer: Member; eventId: string }) {
  const suffix = eventId ? '?' + new URLSearchParams({ eventId }) : '',
    query = useQuery({
      queryKey: ['private', viewer.scope, 'room-lab-source', eventId, viewer.musicEpoch],
      queryFn: async ({ signal }) => {
        const source=await api('/music/rooms/source' + suffix, RoomLabSource, {
          signal,
          headers: { 'X-Account-Scope': viewer.scope },
        });
        if(source.eventId!==(eventId||null))throw Error('分房來源與目前活動不符，請重新核對。');
        return source;
      },
      staleTime: 0,
      refetchOnMount: 'always',
      refetchOnWindowFocus: 'always',
      refetchInterval: 10000,
    });
  if(query.error instanceof ApiError&&[401,403,404,409].includes(query.error.status))return <Failure error={query.error} retry={()=>void query.refetch()}/>;
  if (!query.data || !query.isFetchedAfterMount)
    return query.error ? (
      <Failure error={query.error} retry={() => void query.refetch()} />
    ) : (
      <Notice>正在讀取分房來源…</Notice>
    );
  return (
    <Editor
      viewer={viewer}
      fresh={query.data}
      readError={query.error}
      refresh={() => query.refetch()}
      suffix={suffix}
    />
  );
}
function Editor({
  viewer,
  fresh,
  readError,
  refresh,
  suffix,
}: {
  viewer: Member;
  fresh: Source;
  readError: Error | null;
  refresh: () => Promise<{ data?: Source; error: Error | null }>;
  suffix: string;
}) {
  const storageKey = musicRoomDraftKey(viewer.scope,viewer.musicEpoch,fresh.eventId),
    navigate = useNavigate();
  const preferenceKey = 'qgroup:rebuild:room-include-self:' + viewer.scope;
  const newDraft = () => {
    let includeMe = true;
    try {
      includeMe = (localStorage.getItem(preferenceKey) ?? localStorage.getItem('jpm.roomIncludeMe') ?? '1') === '1';
    } catch {
      /* A nonessential preference never blocks creating a draft. */
    }
    return empty(fresh, includeMe);
  };
  const form=useDurableRecord<Draft>({key:storageKey,scope:viewer.scope,seed:newDraft,parse:raw=>parseMusicRoomDraft(raw,fresh.eventId),dirty:d=>d.selected.length>1||!!d.rooms.length||!!d.result||d.mode!=='rooms'||d.value!=='2'||!!d.sizes||d.sameGender,pending:()=>false});
  const {value:draft,replace:setDraft,busy,setBusy,active,persist,begin,blocker}=form;
  const [message,setMessage]=useState(''),[denied,setDenied]=useState(false),
    [search,setSearch]=useState(''),[page,setPage]=useState(1),[lookup,setLookup]=useState(''),[shuffle,setShuffle]=useState(()=>Math.random());
  const checking=useRef(false),generation=useRef(0),controller=useRef<AbortController|undefined>(undefined),source=draft.source;
  const stale=!!readError||source.sourceVersion!==fresh.sourceVersion,locked=form.unavailable||form.busy;
  useEffect(()=>()=>{generation.current++;controller.current?.abort();},[]);
  useEffect(()=>{generation.current++;controller.current?.abort();setBusy(false);setMessage('');setSearch('');setLookup('');setPage(1);},[form.epoch]);
  useEffect(()=>{if(stale&&!checking.current){generation.current++;controller.current?.abort();setBusy(false);}},[stale]);
  function edit(patch:Partial<Draft>){if(locked)return;generation.current++;controller.current?.abort();form.change({...draft,...patch});setMessage('');}
  function failed(error:unknown){if(error instanceof ApiError&&([401,403].includes(error.status)||error.code==='ACCOUNT_CHANGED'))setDenied(true);}
  const known = new Map(source.members.map((member) => [member.id, member])),
    selected = new Set(draft.selected);
  const result = draft.result,
    validResult =
      !!result &&
      !stale && !form.unavailable &&
      result.sourceVersion === source.sourceVersion &&
      JSON.stringify(result.selected) === JSON.stringify(draft.selected),
    scored =
      validResult &&
      !result.analysis &&
      JSON.stringify(
        result.rooms.map(({ id, capacity, members }) => ({
          id,
          capacity,
          members,
        })),
      ) === JSON.stringify(draft.rooms);
  const canRun = !locked && !stale && !form.storageError && draft.selected.length >= 2;
  async function calculate(command: 'analyze' | 'split' | 'recalc') {
    const config =
      draft.mode === 'sizes'
        ? {
            mode: 'sizes',
            sizes: draft.sizes
              .split(/[,，、\s]+/)
              .filter(Boolean)
              .map(Number),
          }
        : { mode: draft.mode, value: Number(draft.value) };
    const parsed = RoomLabCommand.safeParse({
      command,
      sourceVersion: source.sourceVersion,
      selected: draft.selected,
      ...(command === 'split'
        ? { config, sameGender: draft.sameGender }
        : command === 'recalc'
          ? { rooms: draft.rooms }
          : {}),
    });
    if (!parsed.success) {
      setMessage(uiText("請選擇 2–40 位成員；房數／容量為 1–40，自訂至少兩間。"));
      return;
    }
    if(locked||stale||!begin())return;
    const attempt = ++generation.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setMessage('');
    try {
      if(!await persist(draft)||!active.current||generation.current!==attempt)return;
      const value = await api('/music/rooms/calculate' + suffix, RoomLabResult, {
        signal: abort.signal,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Account-Scope': viewer.scope,
          'X-CSRF-Token': viewer.csrf,
        },
        body: JSON.stringify(parsed.data),
      });
      if(!active.current||generation.current!==attempt)return;
      if(value.sourceVersion!==parsed.data.sourceVersion||JSON.stringify(value.selected)!==JSON.stringify(parsed.data.selected))throw Error('試算回應與原名單不符，原安排仍保留。');
      if(command==='recalc'&&JSON.stringify(value.rooms.map(({id,capacity,members})=>({id,capacity,members})))!==JSON.stringify(draft.rooms))throw Error('試算回應與原包間不符，原安排仍保留。');
      const next={...draft,result:value,rooms:command==='analyze'?draft.rooms:value.rooms.map(({id,capacity,members})=>({id,capacity,members}))};
      if(await persist(next,false,uiText("試算已完成，但無法保存結果；原安排仍保留，請重新計分。"))&&active.current&&generation.current===attempt)setDraft(next);
    } catch (error) {
      if (active.current && generation.current === attempt) { failed(error);
        setMessage(error instanceof Error ? errorText(error) : uiText("試算失敗，原安排仍保留。")); }
    } finally {
      if (active.current && generation.current === attempt) setBusy(false);
    }
  }
  async function findMember() {
    if(locked||stale||!begin())return;
    const attempt = ++generation.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setMessage('');
    try {
      if(!await persist(draft)||!active.current||generation.current!==attempt)return;
      const profile = await api('/music/profiles/lookup', MemberMusicProfile, {
        signal: abort.signal,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Account-Scope': viewer.scope,
          'X-CSRF-Token': viewer.csrf,
        },
        body: JSON.stringify({ query: lookup }),
      });
      if (!active.current || generation.current !== attempt) return;
      const member = source.members.find((person) => person.profileId === profile.id);
      if (!member) {
        setMessage(uiText("這份成分不在目前分房來源，請先核對最新來源。"));
        return;
      }
      setSearch(member.id);
      setPage(1);
    } catch (error) {
      if (active.current && generation.current === attempt) { failed(error);
        setMessage(error instanceof Error ? errorText(error) : uiText("查詢失敗")); }
    } finally {
      if (active.current && generation.current === attempt) setBusy(false);
    }
  }
  async function recheck(){
    if(!begin())return;checking.current=true;const expected=++generation.current;controller.current?.abort();setMessage('');
    try{
      if(!await persist(draft)||!active.current||generation.current!==expected)return;
      const result=await refresh();if(!active.current||generation.current!==expected)return;
      if(result.error||!result.data){failed(result.error);setMessage(uiText("來源讀取失敗，原試算仍保留；目前不能重新計分或採用。"));return;}
      const next=result.data,valid=new Set(next.members.filter(m=>m.profileId).map(m=>m.id)),removed=draft.selected.filter(id=>!valid.has(id));
      const value={...draft,source:next,selected:draft.selected.filter(id=>valid.has(id)),result:null};
      if(await persist(value,true)&&active.current&&generation.current===expected){setDraft(value);await form.refreshVersions();setMessage(removed.length?removed.length+uiText(" 位成員已移除或沒有成分，請核對保留的包間安排後重新計分。"):uiText("已核對最新來源；包間輸入保留，請重新計分。"));}
    }catch(error){if(active.current){failed(error);setMessage(error instanceof Error?errorText(error):uiText("無法核對來源"));}}
    finally{checking.current=false;if(active.current&&generation.current===expected)setBusy(false);}
  }
  async function beforeShare(){const attempt=generation.current;return !locked&&scored&&await persist(draft)&&active.current&&generation.current===attempt;}
  async function adopt(){if(!scored||!source.eventId||!fresh.canAdopt||!begin())return;try{if(!await persist(draft)||!active.current)return;navigate('/activities/'+encodeURIComponent(source.eventId)+'/rooms',{state:{roomSuggestion:{scope:viewer.scope,eventId:source.eventId,sourceVersion:source.sourceVersion,revision:source.revision,rooms:draft.rooms.map(room=>room.members)}}});}finally{if(active.current)setBusy(false);}}
  async function leave(){generation.current++;controller.current?.abort();setBusy(false);await form.leave();}
  function toggle(id: string, on: boolean) {
    if (on && selected.size >= 40) {
      setMessage(uiText("每次最多選擇 40 位成員。"));
      return;
    }
    if (!source.eventId && id === source.selfId) {
      try {
        localStorage.setItem(preferenceKey, on ? '1' : '0');
      } catch {
        /* Current selection still applies. */
      }
    }
    edit({
      selected: on ? [...draft.selected, id] : draft.selected.filter((value) => value !== id),
    });
  }
  function move(id: string, to: string) {
    if (to && known.get(id)?.profileId && !selected.has(id)) {
      setMessage(uiText("請先將這位成員加入本次試算，再安排包間。"));
      return;
    }
    const target = draft.rooms.find((room) => room.id === to);
    if (target && target.members.length >= target.capacity) {
      setMessage(uiText("目標包間已滿，請先調整容量。"));
      return;
    }
    edit({
      rooms: draft.rooms.map((room) => ({
        ...room,
        members: room.members.filter((member) => member !== id).concat(room.id === to ? [id] : []),
      })),
    });
  }
  const ranked = source.members
    .filter(
      (member) =>
        member.profileId &&
        (!search || member.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()) || member.id.includes(search)),
    )
    .sort((a, b) => (b.recommendation ?? -1) - (a.recommendation ?? -1) || a.name.localeCompare(b.name));
  const randomOrder = (id: string) => {
    let value = Math.floor(shuffle * 0x7fffffff);
    for (const letter of id) value = Math.imul(value ^ letter.codePointAt(0)!, 16777619);
    return value >>> 0;
  };
  const recommended = ranked.filter((member) => member.recommendation !== null).slice(0, 16),
    recommendedIds = new Set(recommended.map((member) => member.id));
  const pool =
    source.eventId || search
      ? ranked
      : [
          ...recommended,
          ...ranked
            .filter((member) => !recommendedIds.has(member.id))
            .sort((a, b) => randomOrder(a.id) - randomOrder(b.id)),
        ];
  const name = (id: string) => known.get(id)?.name ?? '來源已移除（' + id + '）',
    assigned = new Set(draft.rooms.flatMap((room) => room.members)),
    unassigned = source.members.filter(
      (member) => (selected.has(member.id) || !!source.eventId) && !assigned.has(member.id),
    );
  const share = {
    title: source.title,
    rooms: draft.rooms.map((room, index) => ({
      name: '包間 ' + (index + 1),
      members: room.members.map(name),
      avg: result?.rooms.find((r) => r.id === room.id)?.analysis.avg ?? 0,
      min: result?.rooms.find((r) => r.id === room.id)?.analysis.min ?? 0,
      common: result?.rooms.find((r) => r.id === room.id)?.analysis.common.map((entry) => entry.text) ?? [],
    })),
    unassigned: source.members.filter(
      (member) => (source.eventId || selected.has(member.id)) && !assigned.has(member.id),
    ).length,
  };
  if(denied||form.expired)return <><DraftFeedback form={form} navigation={false}/><Notice>目前帳號或成分權限已變更。</Notice></>;
  return (
    <>
      {source.eventId && <Heading level={2}>{source.title}</Heading>}
      {readError && <Failure error={readError} retry={() => void recheck()} />}{' '}
      {stale && <Notice>名單、成分或來源狀態已變更。原試算已失效，請核對最新來源再重新計分。</Notice>}
      <DraftFeedback form={form} navigation={false}/>
      {message && <Text role="status">{message}</Text>}
      <Button variant="secondary" disabled={locked} onClick={() => void recheck()}>
        核對最新來源，保留包間輸入
      </Button>
      <Surface className="detail room-lab-options">
        <fieldset disabled={locked}>
          <legend>參與成員 · 已選 {draft.selected.length}／40 人</legend>
          {!source.eventId && source.selfId && (
            <label className="consent">
              <input
                type="checkbox"
                checked={selected.has(source.selfId)}
                onChange={(event) => toggle(source.selfId!, event.target.checked)}
              />
              <span>包含自己</span>
            </label>
          )}
          {!source.eventId && (
            <div className="page-actions">
              <label className="account-field">
                固定成分 ID 或聯絡 QQ
                <input maxLength={80} value={lookup} onChange={(event) => setLookup(event.target.value)} />
              </label>
              <Button variant="secondary" disabled={busy || stale || !lookup.trim()} onClick={() => void findMember()}>
                定位成員
              </Button>
            </div>
          )}
          <label className="account-field">
            搜尋成員名稱或成分 ID
            <input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
            />
          </label>
          <div className="room-lab-pool">
            {pool.slice(0, page * 80).map((member) => (
              <label key={member.id} className="consent">
                <input
                  type="checkbox"
                  checked={selected.has(member.id)}
                  onChange={(event) => toggle(member.id, event.target.checked)}
                />
                <span>
                  {member.name} · {member.pickCount} 個詞條
                  {member.recommendation !== null ? ' · 合拍 ' + member.recommendation + '%' : ''}
                  {source.eventId
                    ? ' · ' +
                      ({
                        confirmed: '正式',
                        waiting: '候補',
                        tentative: '待確認',
                      }[member.status] ?? member.status)
                    : ''}
                </span>
              </label>
            ))}
          </div>
          {!source.eventId && !search && pool.length > recommended.length && (
            <Button
              variant="secondary"
              onClick={() => {
                setShuffle(Math.random());
                setPage(1);
              }}
            >
              換一批候選
            </Button>
          )}
          {!pool.length && <Notice>沒有符合搜尋的成員。</Notice>}
          {pool.length > page * 80 && (
            <Button variant="secondary" onClick={() => setPage((n) => n + 1)}>
              載入更多成員
            </Button>
          )}
          {source.eventId && (
            <Notice>
              {source.members.filter((member) => !member.profileId).length} 位尚未關聯成分，保留在待人工安排。
              {source.members.filter((member) => member.profileId).length > 40
                ? '每次最多自動試算 40 人，其餘名單仍保留。'
                : ''}
            </Notice>
          )}
          <div className="page-actions">
            <Button disabled={!canRun} loading={busy} onClick={() => void calculate('analyze')}>
              分析同房合拍度
            </Button>
            <Button variant="secondary" onClick={() => edit({ selected: [], result: null, rooms: [] })}>
              清空試算
            </Button>
          </div>
        </fieldset>
        <fieldset disabled={locked}>
          <legend>分房方式</legend>
          <label className="account-field">
            分房依據
            <select value={draft.mode} onChange={(event) => edit({ mode: event.target.value as Draft['mode'] })}>
              <option value="rooms">按房數</option>
              <option value="capacity">按每房容量</option>
              <option value="sizes">自訂各房人數</option>
            </select>
          </label>
          {draft.mode === 'sizes' ? (
            <label className="account-field">
              各房人數（以逗號分隔）
              <input value={draft.sizes} onChange={(event) => edit({ sizes: event.target.value })} />
            </label>
          ) : (
            <label className="account-field">
              {draft.mode === 'rooms' ? '房數' : '每房容量'}
              <input
                type="number"
                min={1}
                max={40}
                value={draft.value}
                onChange={(event) => edit({ value: event.target.value })}
              />
            </label>
          )}
          <label className="consent">
            <input
              type="checkbox"
              checked={draft.sameGender}
              onChange={(event) => edit({ sameGender: event.target.checked })}
            />
            <span>已公開男／女性別相同者優先</span>
          </label>
          <Button disabled={!canRun} loading={busy} onClick={() => void calculate('split')}>
            產生分房建議
          </Button>
        </fieldset>
      </Surface>
      {result?.analysis && (
        <section aria-label="同房合拍分析">
          {validResult ? <Analysis value={result.analysis} /> : <Notice>先前分析已失效，請重新分析。</Notice>}
        </section>
      )}
      {!!draft.rooms.length && (
        <section aria-label="分房安排" className="room-lab-results">
          {!scored && <Notice>包間輸入有變更或來源已失效，分數、分享與正式採用暫停；請重新計分。</Notice>}
          {draft.rooms.map((room, index) => (
            <Surface key={room.id} className="detail room-lab-room">
              <Heading level={3}>
                包間 {index + 1} · {room.members.length} 人
              </Heading>
              <label className="account-field">
                包間 {index + 1} 容量
                <input
                  type="number"
                  min={1}
                  max={40}
                  value={room.capacity}
                  disabled={locked}
                  onChange={(event) =>
                    edit({
                      rooms: draft.rooms.map((value) =>
                        value.id === room.id ? { ...value, capacity: Number(event.target.value) } : value,
                      ),
                    })
                  }
                />
              </label>
              {room.members.length ? (
                <ul className="room-lab-members">
                  {room.members.map((id) => (
                    <li key={id}>
                      <span>{name(id)}</span>
                      <Move
                        value={room.id}
                        rooms={draft.rooms}
                        name={name(id)}
                        disabled={locked}
                        change={(to) => move(id, to)}
                      />
                    </li>
                  ))}
                </ul>
              ) : (
                <Text>尚未安排成員。</Text>
              )}
              {scored && result?.rooms[index] && <Analysis value={result.rooms[index]!.analysis} compact />}
              {room.members.some((id) => !known.get(id)?.profileId) && <Notice>沒有成分的成員不列入合拍分數。</Notice>}
              {!room.members.length && (
                <Button
                  variant="secondary"
                  disabled={locked}
                  onClick={() =>
                    edit({
                      rooms: draft.rooms.filter((value) => value.id !== room.id),
                    })
                  }
                >
                  移除空包間 {index + 1}
                </Button>
              )}
            </Surface>
          ))}
          <Surface className="detail">
            <Heading level={3}>待人工安排 · {unassigned.length} 人</Heading>
            <ul className="room-lab-members">
              {unassigned.map((member) => (
                <li key={member.id}>
                  <span>
                    {member.name}
                    {!member.profileId ? ' · 無成分' : !selected.has(member.id) ? ' · 未加入試算' : ''}
                  </span>
                  <Move
                    name={member.name}
                    rooms={draft.rooms}
                    value=""
                    disabled={locked}
                    change={(to) => move(member.id, to)}
                  />
                </li>
              ))}
            </ul>
          </Surface>
          <div className="page-actions">
            <Button
              variant="secondary"
              disabled={locked || draft.rooms.length >= 40}
              onClick={() =>
                edit({
                  rooms: [...draft.rooms, { id: crypto.randomUUID(), capacity: 4, members: [] }],
                })
              }
            >
              新增包間
            </Button>
            <Button disabled={!canRun} loading={busy} onClick={() => void calculate('recalc')}>
              重新計分
            </Button>
          </div>
          <MusicRoomShare value={share} enabled={scored && !locked} beforeShare={beforeShare} />
          {source.eventId && source.canAdopt && (
            <>
              <Notice>採用後仍須核對正式包間名稱、付款人與名冊，再確認保存；不會自動記帳。</Notice>
              <Button
                disabled={!scored || locked || !fresh.canAdopt}
                onClick={()=>void adopt()}
              >
                核對並採用為正式分房
              </Button>
            </>
          )}
        </section>
      )}
      {blocker.state === 'blocked' && (
        <Surface role="alert" className="leave-prompt">
          <Text>仍有分房草稿。</Text>
          <Button onClick={() => blocker.reset?.()}>繼續核對</Button>
          <Button variant="secondary" disabled={form.loading} onClick={() => void leave()}>
            保留分房草稿並離開
          </Button>
        </Surface>
      )}
    </>
  );
}
function Move({
  name,
  value,
  rooms,
  disabled,
  change,
}: {
  name: string;
  value: string;
  rooms: z.infer<typeof RoomLabRoomInput>[];
  disabled: boolean;
  change: (id: string) => void;
}) {
  return (
    <label>
      移至
      <select
        aria-label={'移動 ' + name}
        value={value}
        disabled={disabled}
        onChange={(event) => change(event.target.value)}
      >
        <option value="">待人工安排</option>
        {rooms.map((room, index) => (
          <option key={room.id} value={room.id}>
            包間 {index + 1}
          </option>
        ))}
      </select>
    </label>
  );
}
function Analysis({ value, compact = false }: { value: z.infer<typeof RoomLabAnalysis>; compact?: boolean }) {
  return (
    <div className="room-lab-analysis">
      <Text>
        平均 {value.avg} · 最低 {value.min} · 個人最高 {value.memberMax}／最低 {value.memberMin}
      </Text>
      {value.worst && (
        <Text>
          最弱配對：{value.worst.aName} × {value.worst.bName} · {value.worst.score}
        </Text>
      )}
      {value.loner && (
        <Text>
          較少共同項：{value.loner.name} · 平均 {value.loner.avg}
        </Text>
      )}
      {value.common.length ? (
        <ul aria-label="共同詞條">
          {value.common.map((entry) => (
            <li key={entry.id}>
              {entry.text} · {entry.n} 人
            </li>
          ))}
        </ul>
      ) : (
        <Text>尚無 {value.need} 人以上共同詞條。</Text>
      )}
      {!compact && (
        <details>
          <summary>兩兩配對 · {value.pairs.length} 組</summary>
          <ul>
            {value.pairs.map((pair) => (
              <li key={pair.a + ':' + pair.b}>
                {pair.aName} × {pair.bName} · {pair.score} · {pair.label} · 共同 {pair.shared} 項
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
