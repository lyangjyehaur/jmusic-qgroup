import { errorText, uiText } from './language';
import { useEffect, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Heading, Surface, Text } from 'yahha-ui';
import { Button, Field, Disclosure, Checkbox } from './kimi-ui';
import { z } from 'zod';
import { AdminMusicProfile, ResetMusicPin, type Viewer } from '@qgroup/contracts';
import { adminHttp, adminReadHttp, type Access } from './admin';
import { ApiError } from './api';
import { Failure, Notice } from './shared';
import { useDurableValue } from './durable-record';
import { DraftFeedback } from './draft-feedback';
import { readAdminMusicProfile } from './admin-music-profile';

const Pending = z.object({ requestId: z.string().uuid() }).strict();
type Profile = z.infer<typeof AdminMusicProfile>;
export function AdminMusicPin({ id, profile, viewer, access, disabled, onDirty, onBusy, onPending, onCurrent }: {
  id: string; profile: Profile | null; viewer: Viewer; access: Access; disabled: boolean;
  onDirty: (dirty: boolean) => void; onBusy: (busy: boolean) => void; onPending: (pending: boolean) => void; onCurrent: (profile: Profile | null) => void;
}) {
  const client = useQueryClient();
  const storageKey = 'qgroup:rebuild:admin-music-pin:v1:' + viewer.scope + ':' + access.scope + ':' + id;
  const [legacyInvalid,setLegacyInvalid]=useState<string|null>(()=>{try{const raw=sessionStorage.getItem(storageKey);if(raw!==null&&!Pending.nullable().safeParse(JSON.parse(raw)).success)return raw;return null;}catch{try{return sessionStorage.getItem(storageKey);}catch{return null;}}});
  const [downloaded,setDownloaded]=useState(false),[expanded,setExpanded]=useState(false);
  const record=useDurableValue<z.infer<typeof Pending>|null>({key:storageKey,scope:viewer.scope,seed:()=>null,parse:raw=>Pending.nullable().parse(JSON.parse(raw)),dirty:value=>!!value,pending:value=>!!value});
  const {value:pending,replace:setPending,busy,setBusy,active,locked:baseLocked,unavailable,begin,persist}=record;
  const [pin, setPin] = useState(''), [reason, setReason] = useState(''), [confirm, setConfirm] = useState(false);
  const locked=baseLocked||legacyInvalid!==null,damaged=legacyInvalid??record.damagedRaw;
  useEffect(()=>setDownloaded(false),[damaged]);
  const [notFound, setNotFound] = useState(false), [message, setMessage] = useState('');
  useEffect(()=>{if(pending||record.readError||damaged!==null)setExpanded(true);},[pending,record.readError,damaged]);
  useEffect(()=>{setPin('');setReason('');setConfirm(false);setNotFound(false);},[record.epoch]);
  useEffect(()=>{if(record.expired){setPin('');setReason('');setConfirm(false);}},[record.expired]);
  useEffect(()=>{if(!profile){setPin('');setReason('');setConfirm(false);}},[profile===null]);
  useEffect(() => { onDirty(!!pending || !!pin || !!reason || !!record.readError || legacyInvalid!==null || busy || record.loading || record.saving);onBusy(busy||record.loading||record.saving); }, [pending, pin, reason, record.readError, legacyInvalid, busy, record.loading,record.saving,onDirty,onBusy]);
  useEffect(() => { onPending(!!pending); }, [pending,onPending]);
  const failed=(error:unknown)=>{if(error instanceof ApiError&&[401,403].includes(error.status))void client.invalidateQueries({queryKey:['private',viewer.scope,'admin-session']});};
  const history = useInfiniteQuery({ queryKey: ['private', viewer.scope, 'admin-music-pin-history', access.scope, id], initialPageParam: Number.MAX_SAFE_INTEGER, enabled: expanded && !!profile,
    queryFn: ({ pageParam,signal }) => adminReadHttp(viewer).requestContract('GET /api/v2/admin/music/:id/pin-history', { params: { id }, signal, query: { before: pageParam } }), getNextPageParam: page => page.nextCursor ?? undefined });
  useEffect(()=>{failed(history.error);},[history.error,client,viewer.scope]);
  async function refreshProfile() {
    const latest = await readAdminMusicProfile(id, viewer);
    if(!active.current)return;onCurrent(latest); client.setQueryData(['private', viewer.scope, 'admin-music-profile', access.scope, id], latest);
    void client.invalidateQueries({ queryKey: ['private', viewer.scope, 'admin-music'] });
    void client.invalidateQueries({ queryKey: ['private', viewer.scope, 'admin-music-pin-history'] });
    return latest;
  }
  async function completed() {
    const latest=await refreshProfile();if(!active.current||!await persist(null,false,uiText("操作已送出，但無法保存確認狀態；請保留原操作並核對結果。")))return;setPending(null);setNotFound(false);setReason('');setConfirm(false);
    setMessage(latest ? uiText("口令重設已完成，該成分的舊找回授權已失效。") : uiText("原口令重設已完成；成分目前不存在或已刪除。"));
  }
  async function save() {
    if(!profile||disabled||locked)return;
    const parsed=ResetMusicPin.safeParse({pin,revision:profile.revision,reason,confirm});if(!parsed.success||!begin())return;
    const operation={requestId:crypto.randomUUID()};
    if(!await persist(operation,false,uiText("無法保存口令操作編號，尚未送出口令。"))||!active.current){if(active.current)setBusy(false);return;}
    setPending(operation);setMessage('');setPin('');setConfirm(false);let accepted=false;
    try{
      await adminHttp(viewer,access).requestContract('POST /api/v2/admin/music/:id/pin',{params:{id},body:parsed.data,requestId:operation.requestId,requestScope:viewer.scope});accepted=true;
      if(active.current)await completed();
    }catch(error){if(!active.current)return;
      if(!accepted&&error instanceof ApiError&&error.status<500&&error.status!==429){if(await persist(null))setPending(null);setMessage(errorText(error));}
      else setMessage(uiText("尚未確認口令重設結果。口令未保存，請先查詢操作結果。"));failed(error);
    }finally{if(active.current)setBusy(false);}
  }
  async function check() {
    if(legacyInvalid!==null||!pending||!begin())return;setMessage('');setNotFound(false);
    try{
      const result=await adminHttp(viewer,access).requestContract('POST /api/v2/admin/music/:id/pin-result',{params:{id},body:pending});if(!active.current)return;
      if(result.status==='completed')await completed();else{setNotFound(true);setMessage(profile ? uiText("尚未查到完成紀錄。可稍後再查，或核對目前版本後重新輸入口令。") : uiText("尚未查到完成紀錄。可稍後再查，或保全操作編號後結束核對。"));}
    }catch(error){if(active.current){setMessage(error instanceof Error?errorText(error):uiText("仍無法確認口令重設結果，請稍後再查。"));failed(error);}}finally{if(active.current)setBusy(false);}
  }
  async function restart() {
    if(!profile||legacyInvalid!==null||!notFound||!begin())return;
    try{const latest=await refreshProfile();if(!active.current)return;if(!latest){setMessage(uiText("成分不存在或已刪除，請保全操作編號後結束核對。"));return;}if(!await persist(null))return;setPending(null);setNotFound(false);setConfirm(false);setMessage(uiText("請重新輸入口令並確認；若原操作稍後完成，版本檢查會阻止覆蓋。"));}
    catch(error){if(active.current){setMessage(error instanceof Error?errorText(error):uiText("無法核對目前版本，請稍後再查。"));failed(error);}}finally{if(active.current)setBusy(false);}
  }
  async function refresh(){if(!profile||disabled||locked||!begin())return;try{const latest=await refreshProfile();if(active.current){setConfirm(false);setMessage(latest ? uiText("已核對目前版本，請重新確認。") : uiText("成分不存在或已刪除，無法重設口令。"));}}catch(error){if(active.current){setMessage(error instanceof Error?errorText(error):uiText("無法核對版本"));failed(error);}}finally{if(active.current)setBusy(false);}}
  async function finishMissing(){
    if(profile||!pending||!notFound||legacyInvalid!==null||!begin())return;
    try{if(!await persist(null,true))return;setPending(null);setNotFound(false);setMessage(uiText("操作編號已保全，可由本機保全版本下載；未重新送出口令。"));await record.refreshVersions();}
    catch{setMessage(uiText("操作編號已保全；無法讀取本機保全版本，請重新載入頁面。"));}
    finally{if(active.current)setBusy(false);}
  }
  if(!profile&&!pending&&!record.loading&&!record.readError&&damaged===null&&!record.versions.length&&!message)return null;
  return <Surface className="detail auth-panel"><Disclosure className="admin-disclosure" open={expanded} onOpenChange={setExpanded}  title={<>{profile ? '重設找回口令' : '口令操作結果'}</>}>
    {profile && <>
    <Text>4–6 位數字，只供舊成分找回，仍須本次 QQ 授權。重設不解除帳號關聯，已關聯成分不能靠口令取回。</Text>
    <Text>重設後，這份成分尚未完成的找回授權將失效。口令不保存在瀏覽器。</Text>
    {disabled && !pending && <Text>請先完成或清除關聯草稿，再重設口令。</Text>}
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <Field className="account-field" label={<>新找回口令</>}><input type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={pin} disabled={disabled || locked} onChange={event => { setPin(event.target.value); setConfirm(false); }} /></Field>
      <Field label="重設原因"><textarea id={'music-pin-reason-' + id} rows={2} maxLength={500} value={reason} disabled={disabled || locked} onChange={event => { setReason(event.target.value); setConfirm(false); }} /></Field>
      <Checkbox className="consent" checked={confirm} disabled={disabled || locked} onChange={event => setConfirm(event.target.checked)} label={<><span>確認已核對成分及申請人，重設找回口令</span></>} />
      <Button type="submit" loading={busy} disabled={disabled || locked || !confirm || !reason.trim() || !/^[0-9]{4,6}$/.test(pin.trim())}>重設口令</Button>
    </form>
    </>}
    {!pending && (pin || reason) && <Button variant="secondary" disabled={busy || disabled} onClick={() => { setPin(''); setReason(''); setConfirm(false); }}>清除未送出口令</Button>}
    {pending && <Button variant="secondary" loading={busy} disabled={unavailable||busy||legacyInvalid!==null} onClick={() => void check()}>查詢口令重設結果</Button>}
    {notFound && profile && <Button variant="secondary" disabled={unavailable||busy||legacyInvalid!==null} onClick={() => void restart()}>核對版本並重新輸入</Button>}
    {!pending && profile && <Button variant="secondary" disabled={disabled||locked} onClick={()=>void refresh()}>核對目前成分版本</Button>}
    {notFound && !profile && <Button variant="secondary" disabled={unavailable||busy||legacyInvalid!==null} onClick={()=>void finishMissing()}>保全操作編號並結束核對</Button>}
    {!profile && !pending && !message && !record.loading && !record.readError && damaged===null && <Notice>沒有待確認的口令操作。</Notice>}
    <DraftFeedback form={{...record,message:message||record.message,readError:damaged!==null&&!record.conflict&&!record.expired?'':record.readError}} navigation={false}/>
    {damaged!==null&&<div role="alert"><Text>口令操作紀錄格式無法辨識。請先下載保全檔，再清除紀錄；原始內容不會複製到保全版本。</Text>
      <Button disabled={busy||record.loading||record.expired} onClick={()=>{const url=URL.createObjectURL(new Blob([damaged],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='qgroup-pin-operation-recovery.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setDownloaded(true);}}>下載舊操作紀錄</Button>
      <Button disabled={!downloaded||busy||record.loading||record.conflict||record.expired} onClick={()=>void (async()=>{try{if(legacyInvalid!==null){if(sessionStorage.getItem(storageKey)!==legacyInvalid)throw Error('舊紀錄已有變更，請重新載入後核對。');sessionStorage.removeItem(storageKey);setLegacyInvalid(null);}else{if(!await persist(null))return;await record.recover();}}catch(error){setMessage(error instanceof Error?errorText(error):uiText("無法清除操作紀錄。"));}})()}>清除已下載的舊紀錄</Button>
    </div>}
    {profile && <><Heading level={3}>口令重設紀錄</Heading>{history.isPending ? <Notice>正在讀取紀錄…</Notice> : history.error ? <Failure error={history.error} retry={() => void history.refetch()} /> : <>
      {history.data.pages.flatMap(page => page.history).map(row => <div key={row.id}><Text>{row.createdAt} · {row.actor}</Text><Text className="preserve-lines">{row.reason}</Text></div>)}
      {!history.data.pages[0]?.history.length && <Notice>目前沒有口令重設紀錄。</Notice>}{history.hasNextPage && <Button variant="secondary" loading={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>載入更多口令紀錄</Button>}
    </>}
    </>}
  </Disclosure></Surface>;
}
