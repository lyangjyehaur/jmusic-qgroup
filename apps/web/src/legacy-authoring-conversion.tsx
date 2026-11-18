import { errorText, uiText } from './language';
import { useEffect,useId,useRef,useState } from 'react';
import { Link } from 'react-router-dom';
import { Button,Text } from 'yahha-ui';
import { Notice } from './shared';
import type { Member } from './member-access';
import { decodeAuthoring } from './legacy-authoring';
import { prepareAuthoring,adoptAuthoring,reconcileAuthoringRequests,type AuthoringPlan } from './legacy-authoring-migration';
import { ActivityEditorDraft } from './activity-draft-record';
import { PollCreateRecord } from './poll-create-record';
import type { LegacyInventory,LegacySnapshot } from './legacy-local-store';
export function LegacyAuthoringConversion({viewer,inventory,row,validate,refresh}:{viewer:Member;inventory:LegacyInventory;row:LegacySnapshot;validate:()=>Promise<Member>;refresh:()=>Promise<unknown>}){
  const zoneHelp=useId();
  const active=useRef(false),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[zone,setZone]=useState(''),[plan,setPlan]=useState<AuthoringPlan|null>(null),[confirm,setConfirm]=useState(false),[preserve,setPreserve]=useState(false),[destination,setDestination]=useState('');
  useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  let decoded:ReturnType<typeof decodeAuthoring>|null=null,error='';try{decoded=decodeAuthoring(row,viewer.scope);}catch(failure){error=failure instanceof Error?errorText(failure):uiText('原欄位尚未完成映射。');}
  async function prepare(){
    if(busy)return;setBusy(true);setMessage('');setPlan(null);setConfirm(false);setPreserve(false);
    try{const fresh=await validate();if(!active.current)return;const next=await prepareAuthoring(fresh,inventory,row,zone);await validate();if(active.current)setPlan(next);}
    catch(failure){if(active.current)setMessage(failure instanceof Error?errorText(failure):uiText("轉換檢查失敗，原稿保留。"));}finally{if(active.current)setBusy(false);}
  }
  async function adopt(){
    if(!plan||busy||!confirm)return;setBusy(true);setMessage('');
    try{const path=await adoptAuthoring(plan,viewer.scope,inventory.epoch,preserve,async()=>{await validate();},()=>active.current);if(!active.current)return;setDestination(path);setMessage(uiText("目的原稿與轉換紀錄已保存，尚未送出網站操作。"));await refresh();}
    catch(failure){if(active.current)setMessage(failure instanceof Error?errorText(failure):uiText("轉換尚未確認，原稿保留。"));}finally{if(active.current)setBusy(false);}
  }
  async function reconcile(){
    if(!mapped||busy)return;setBusy(true);setMessage('');
    try{const count=await reconcileAuthoringRequests(row,mapped,inventory.epoch,async()=>{await validate();},()=>active.current);if(active.current){setMessage(count?uiText("已保全同一建立識別的後續請求，原請求未重送。"):uiText("沒有未核對的同一建立請求。"));await refresh();}}
    catch(failure){if(active.current)setMessage(failure instanceof Error?errorText(failure):uiText("核對失敗，原紀錄保留。"));}finally{if(active.current)setBusy(false);}
  }
  const mapped=inventory.mappings.find(m=>m.id===row.id);
  if(mapped)return <Notice>{mapped.sourceId===row.id?'此原稿已轉換。':'此版本已保全，採用同一原稿的目前版本。'}<Link to={mapped.path}>開啟目的原稿</Link>{mapped.sourceId===row.id&&decoded?.creation&&<Button variant="secondary" disabled={busy} onClick={()=>void reconcile()}>核對後續原建立請求</Button>}{message&&<Text>{message}</Text>}</Notice>;
  if(!decoded)return <Notice>此稿不能轉換：{error}</Notice>;
  return <div className="legacy-conversion">{!decoded.value.timezone&&<div className="account-field"><label>原 IANA 時區<input value={zone} placeholder="Asia/Taipei" disabled={busy} aria-describedby={zoneHelp} onChange={e=>{setZone(e.target.value);setPlan(null);setConfirm(false);}}/></label><Text id={zoneHelp}>原稿未保存時區；時間轉換需填寫原裝置使用的時區。</Text></div>}
    <Button variant="secondary" disabled={busy} onClick={()=>void prepare()}>檢查此舊稿的轉換</Button>
    {plan&&<Notice>{plan.source.kind==='activity'?'將帶入活動表單；已建立活動仍須核對最新安排。':'候選按原順序帶入；已建立投票只保留後續稿，不能重建。'}<ConversionPreview plan={plan}/>{plan.rows.length>1&&<Text>另有 {plan.rows.length-1} 筆同一原稿版本或建立請求一併保全；原請求不會重送。</Text>}{plan.pending?<Text>目的表單有待確認操作，不能覆寫；請先確認原結果。</Text>:<>{plan.previous!==null&&plan.previous!==plan.raw&&<label className="consent"><input type="checkbox" disabled={busy} checked={preserve} onChange={e=>setPreserve(e.target.checked)}/>保全目的表單的現有原稿，再採用此舊稿</label>}<label className="consent"><input type="checkbox" disabled={busy} checked={confirm} onChange={e=>setConfirm(e.target.checked)}/>已核對原資料、結果與時區；只帶入表單，尚未送出</label><Button disabled={busy||!confirm||plan.previous!==null&&plan.previous!==plan.raw&&!preserve} onClick={()=>void adopt()}>保全並帶入新版表單</Button></>}</Notice>}
    {message&&<Notice>{message}</Notice>}{destination&&<Link to={destination}>開啟已轉換原稿</Link>}
  </div>;
}
function ConversionPreview({plan}:{plan:AuthoringPlan}){
  const parsed=JSON.parse(plan.raw),activity=plan.source.kind==='activity'?ActivityEditorDraft.parse(parsed):null,poll=plan.source.kind==='poll'?PollCreateRecord.parse(parsed).value:null;
  const metadata=activity?.legacySource??poll?.legacySource;
  const times:[string,string,string][]=plan.source.kind==='activity'&&activity?[
    [uiText('開始時間'),plan.source.value.event_date+' '+plan.source.value.start_time+uiText('（凌晨日期偏移 ')+(plan.source.value.start_day_offset||uiText('未選'))+'）',activity.form.startsAt],
    [uiText('報名截止'),plan.source.value.deadline,activity.form.deadline],[uiText('退出期限'),plan.source.value.withdrawal_deadline,activity.form.withdrawalDeadline],
  ]:plan.source.kind==='poll'&&poll?[
    [uiText('投票截止'),plan.source.value.deadline_date+' '+(plan.source.value.exact_time?plan.source.value.deadline_time:'23:59'),poll.deadline],
    ...plan.source.value.slots.map((slot,i)=>[uiText('候選 ')+(i+1),slot.date+(plan.source.kind==='poll'&&plan.source.value.exact_time?' '+slot.time:''),poll.options[i]??''] as [string,string,string]),
  ]:[];
  return <div className="legacy-local-data" aria-label="轉換時間核對"><Text>原時間時區：{plan.source.value.timezone||activity?.form.timezone||poll?.timezone||'未記錄'}；{activity?'目的時間以台北 UTC+08:00 輸入。':'目的時間保留明確 UTC 或候選日期。'}</Text><dl>{times.map(([label,old,value])=><div key={label}><dt>{label}</dt><dd>原值：{old||'未填'}</dd><dd>帶入：{value||'未填，需補齊'}</dd></div>)}</dl>{metadata?.notes.map((note,i)=><Text key={i}>{note.field}：{note.message}；原值已保全。</Text>)}</div>;
}
