import { createContext, useContext, useEffect, useState } from 'react';
import { Outlet, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Heading, Surface } from 'yahha-ui';
import { z } from 'zod';
import { MusicCatalog, Profile, SaveProfile, Selection, Session, type MusicProfile } from '@qgroup/contracts';
import { api, ApiError } from './api';
import { Failure, Notice, useSession } from './shared';
import { musicPeopleReturn, musicTrendReturn } from './music-return';
import { announceAccountChange } from './account-session';
import { useDurableRecord } from './durable-record';
import { DraftFeedback } from './draft-feedback';
import type { Member } from './member-access';
type CatalogEntry = z.infer<typeof MusicCatalog>['entries'][number];
const isWorkspace = (pathname: string) => pathname === '/music' || pathname === '/music/trends' || pathname === '/me/music' || pathname === '/me/music/share' || /^\/music\/entries\/[^/]+$/.test(pathname);
const Draft = z.object({ profileId: z.string().nullable().default(null), musicEpoch: z.number().int().min(0).default(0), revision: z.number().int().min(0), selections: z.array(Selection).max(20), requestKey: z.string().uuid().optional() }).strict();
type DraftValue = z.infer<typeof Draft>;
function useMusicSelection({ viewer, initial, entries }: { viewer: Member; initial: MusicProfile; entries: CatalogEntry[] }) {
  const storageKey = 'qgroup:rebuild:music:v1:' + viewer.scope;
  const [saved,setSaved]=useState(initial),[message,setMessage]=useState('');
  const fallback=(profile:MusicProfile):DraftValue=>({profileId:profile?.id??null,musicEpoch:viewer.musicEpoch,revision:profile?.revision??0,selections:profile?.selections??[]});
  const record=useDurableRecord<DraftValue>({key:storageKey,scope:viewer.scope,seed:()=>fallback(saved),parse:raw=>{
    const value=Draft.parse(JSON.parse(raw)),baseline=fallback(initial);
    if(value.musicEpoch!==viewer.musicEpoch)throw Error('music epoch');
    const sameSavedChoices=!value.requestKey&&value.profileId===baseline.profileId&&JSON.stringify(value.selections)===JSON.stringify(baseline.selections);
    const untouchedBlank=!value.requestKey&&value.profileId===null&&value.revision===0&&!value.selections.length;
    if(sameSavedChoices||untouchedBlank)return baseline;
    // First-time drafts keep their null target until explicit rebase; replaced profiles stay blocked.
    if(value.profileId!==null&&value.profileId!==baseline.profileId)throw Error('profile target');return value;
  },dirty:value=>value.profileId!==(saved?.id??null)||value.musicEpoch!==viewer.musicEpoch||value.revision!==(saved?.revision??0)||JSON.stringify(value.selections)!==JSON.stringify(saved?.selections??[]),pending:value=>!!value.requestKey,
  blocking:({nextLocation})=>!isWorkspace(nextLocation.pathname)});
  const {value:draft,replace:setDraft,busy:sending,setBusy:setSending,active:mounted,dirty,locked,unavailable,begin,persist}=record;
  const [params]=useSearchParams(),from=params.get('from');
  const validReturn=from&&/^\/activities\/[^/?#]+(?:#participants)?$/.test(from)?from:musicPeopleReturn(from)??musicTrendReturn(from);
  const [returnTo,setReturnTo]=useState(validReturn);
  useEffect(()=>{if(validReturn)setReturnTo(validReturn);},[validReturn]);
  const queryClient=useQueryClient();
  // A term can explicitly create a blank profile while this controller stays mounted.
  useEffect(()=>{
    if(dirty||locked||record.saving||!initial||(saved&&(initial.id!==saved.id||initial.revision<=saved.revision)))return;
    record.change(fallback(initial));setSaved(initial);
  },[initial,saved,dirty,locked,record.saving]);
  const selected=new Map(draft.selections.map(s=>[s.entryId,s.level])),mainCount=entries.filter(e=>e.kind==='main'&&selected.has(e.id)).length,subCount=entries.filter(e=>e.kind==='sub'&&selected.has(e.id)).length;
  function edit(next:DraftValue){record.change(next);setMessage('');}
  function toggle(entry:CatalogEntry){
    if(locked)return;
    if(selected.has(entry.id))edit({...draft,selections:draft.selections.filter(s=>s.entryId!==entry.id)});
    else if((entry.kind==='main'&&mainCount>=5)||(entry.kind==='sub'&&subCount>=15)||selected.size>=20)setMessage('領域最多 5 項、細分最多 15 項，合計最多 20 項。');
    else edit({...draft,selections:[...draft.selections,{entryId:entry.id,level:3}]});
  }
  async function save(){
    if(unavailable||sending)return;
    const parsed=SaveProfile.safeParse({profileId:draft.profileId,musicEpoch:draft.musicEpoch,revision:draft.revision,selections:draft.selections});
    if(!parsed.success){setMessage('請至少選擇一個詞條，再保存。');return;}
    const pending={...draft,requestKey:draft.requestKey??crypto.randomUUID()};
    if(!begin())return;if(!await persist(pending)||!mounted.current){if(mounted.current)setSending(false);return;}setDraft(pending);setMessage('');let accepted=false;
    try{
      const result=await api('/me/music',Profile.unwrap(),{method:'PUT',headers:{'Content-Type':'application/json','X-CSRF-Token':viewer.csrf,'X-Account-Scope':viewer.scope,'Idempotency-Key':pending.requestKey},body:JSON.stringify(parsed.data)});accepted=true;
      await queryClient.cancelQueries({queryKey:['private',viewer.scope,'music',draft.musicEpoch]});
      const latest=await api('/me/music',Profile.unwrap(),{headers:{'X-Account-Scope':viewer.scope}});
      if(!mounted.current)return;const next=fallback(latest);if(!await persist(next,false,'操作已送出，但無法保存確認狀態；請保留原操作並核對結果。'))throw Error('storage');
      setSaved(latest);setDraft(next);queryClient.setQueryData(['private',viewer.scope,'music',draft.musicEpoch],latest);
      for(const key of ['music-catalog','music-trend'])void queryClient.invalidateQueries({queryKey:[key]});
      for(const key of ['music-trend-members','music-entries','music-entry-members','member-music','music-matches','music-circles','music-comparison','music-share'])void queryClient.invalidateQueries({queryKey:['private',viewer.scope,key]});
      announceAccountChange();setMessage(latest.revision===result.revision?'已保存。':'原操作已保存，成分已再次變更；請核對目前選擇。');
    }catch(error){
      if(!mounted.current)return;
      if(!accepted&&error instanceof ApiError&&error.status<500&&error.status!==429){const next={...pending,requestKey:undefined};if(await persist(next))setDraft(next);setMessage(error.message);}
      else setMessage('尚未確認保存結果。操作編號已保留，請按「確認保存結果」安全重試。');
    }finally{if(mounted.current)setSending(false);}
  }
  async function rebase(){
    if(locked||!begin())return;
    try{
      const latest=await api('/me/music',Profile,{headers:{'X-Account-Scope':viewer.scope}}),session=await api('/session',Session);
      if(!mounted.current)return;if(!session.authenticated||session.scope!==viewer.scope)throw Error('目前帳號已變更，請重新整理');
      if(session.musicEpoch!==draft.musicEpoch||draft.profileId!==null&&(latest?.id??null)!==draft.profileId)throw Error('目前成分已改變，請保全原稿後重新開啟目前成分。');
      const next={...draft,profileId:latest?.id??null,revision:latest?.revision??0};if(!await persist(next))return;
      queryClient.setQueryData(['private',viewer.scope,'music',session.musicEpoch],latest);setSaved(latest);setDraft(next);setMessage('已取得最新版本；你的選擇仍保留，請核對後再保存。');
    }catch(error){if(mounted.current)setMessage(error instanceof Error?error.message:'讀取失敗');}finally{if(mounted.current)setSending(false);}
  }
  function level(entryId:string,value:number){if(!locked)edit({...draft,selections:draft.selections.map(s=>s.entryId===entryId?{...s,level:value}:s)});}
  function remove(entryId:string){if(!locked)edit({...draft,selections:draft.selections.filter(s=>s.entryId!==entryId)});}
  return {viewer,initial,entries,draft,saved,dirty,selected,mainCount,subCount,returnTo,record,
    storageError:record.storageError,readError:record.readError,message,sending,blocker:record.blocker,save,rebase,toggle,level,remove,locked,unavailable};
}
export type MusicSelection = ReturnType<typeof useMusicSelection>;
type Workspace = { state: 'ready'; selection: MusicSelection } | { state: 'pending' | 'guest' } | { state: 'error'; error: Error; retry: () => void };
const Context = createContext<Workspace>({ state: 'pending' });
export const useMusicWorkspace = () => useContext(Context);
export function MusicWorkspace() {
  const session = useSession(), viewer = session.data?.authenticated ? session.data : null;
  const profile = useQuery({ queryKey: ['private', viewer?.scope, 'music', viewer?.musicEpoch],
    queryFn: () => api('/me/music', Profile, { headers: { 'X-Account-Scope': viewer!.scope } }), enabled: !!viewer, refetchOnMount: 'always' });
  const catalog = useQuery({ queryKey: ['music-catalog'], queryFn: () => api('/music/catalog', MusicCatalog) });
  // A failed public background refresh must not unmount the draft/save controller.
  // Child pages show its read error and retry; private/session failures still gate access.
  const error = session.error ?? profile.error ?? (catalog.data ? null : catalog.error);
  if (viewer && profile.isFetchedAfterMount && profile.data !== undefined && catalog.data && !error) return <ReadyWorkspace
    key={viewer.scope + ':' + viewer.musicEpoch} viewer={viewer} initial={profile.data} entries={catalog.data.entries} />;
  // The ready controller adds selection hooks and a blocker. Mount the interactive
  // outlet only after initialization so it cannot be replaced during the first input.
  if (error) return <Failure error={error} retry={() => {
    void session.refetch(); if (viewer) void profile.refetch(); void catalog.refetch();
  }} />;
  if (session.isPending || viewer) return <Notice>正在確認成分…</Notice>;
  return <Context.Provider value={{ state: 'guest' }}><Outlet /></Context.Provider>;
}
function ReadyWorkspace(props: { viewer: Member; initial: MusicProfile; entries: CatalogEntry[] }) {
  const selection = useMusicSelection(props);
  return <Context.Provider value={{ state: 'ready', selection }}>
    {selection.blocker.state === 'blocked' && <Surface className="leave-prompt" role="alert">
      <Heading level={2}>還有未保存的選擇</Heading>
      <Button onClick={() => selection.blocker.reset?.()}>繼續編輯</Button>
      <Button variant="secondary" disabled={selection.sending||selection.record.loading} onClick={() => void selection.record.leave()}>保留草稿並離開</Button>
    </Surface>}
    <DraftFeedback form={selection.record} navigation={false}/>
    <Outlet />
  </Context.Provider>;
}
