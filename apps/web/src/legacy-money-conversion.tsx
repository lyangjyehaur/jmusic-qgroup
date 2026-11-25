import { errorText, uiText } from './language';
import { useEffect,useId,useRef,useState } from 'react';
import { Link } from 'react-router-dom';
import { Text } from 'yahha-ui';
import { Button } from './kimi-ui';
import { Notice } from './shared';
import type { Member } from './member-access';
import { decodeMoney } from './legacy-money';
import { prepareMoney,adoptMoney,type MoneyPlan } from './legacy-money-migration';
import { FinanceEditorDraft } from './finance-editor-record';
import { RoomEditorRecord } from './room-editor-record';
import type { LegacyInventory,LegacySnapshot } from './legacy-local-store';
export function LegacyMoneyConversion({viewer,inventory,row,validate,refresh}:{viewer:Member;inventory:LegacyInventory;row:LegacySnapshot;validate:()=>Promise<Member>;refresh:()=>Promise<unknown>}){
 const help=useId(),active=useRef(false),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[zone,setZone]=useState(''),[plan,setPlan]=useState<MoneyPlan|null>(null),[confirm,setConfirm]=useState(false),[preserve,setPreserve]=useState(false);
 useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
 let decoded:ReturnType<typeof decodeMoney>|null=null,error='';try{decoded=decodeMoney(row,viewer.scope);}catch(failure){error=failure instanceof Error?errorText(failure):uiText('原欄位尚未完成映射。');}
 async function prepare(){if(busy)return;setBusy(true);setMessage('');setPlan(null);setConfirm(false);setPreserve(false);try{const fresh=await validate();if(!active.current)return;const next=await prepareMoney(fresh,inventory,row,zone);await validate();if(active.current)setPlan(next);}catch(failure){if(active.current)setMessage(failure instanceof Error?errorText(failure):uiText("轉換檢查失敗，原稿保留。"));}finally{if(active.current)setBusy(false);}}
 async function adopt(){if(!plan||busy||!confirm)return;setBusy(true);setMessage('');try{await adoptMoney(plan,viewer.scope,inventory.epoch,preserve,validate,()=>active.current);if(active.current){setMessage(uiText("目的原稿與轉換紀錄已保存，尚未送出網站操作。"));await refresh();}}catch(failure){if(active.current)setMessage(failure instanceof Error?errorText(failure):uiText("轉換尚未確認，原稿保留。"));}finally{if(active.current)setBusy(false);}}
 const mapped=inventory.mappings.find(m=>m.id===row.id);
 if(mapped)return <Notice>{mapped.sourceId===row.id?'此原稿已轉換。':'此版本已保全，採用同一原稿的目前版本。'}<Link to={mapped.path}>開啟目的原稿</Link>{message&&<Text>{message}</Text>}</Notice>;
 if(!decoded)return <Notice>此稿不能轉換：{error}</Notice>;
 return <div className="legacy-conversion">{decoded.kind==='finance'&&['record','report'].includes(decoded.command)&&<div className="account-field"><label>原款項 IANA 時區<input value={zone} placeholder="Asia/Taipei" disabled={busy} aria-describedby={help} onChange={e=>{setZone(e.target.value);setPlan(null);setConfirm(false);}}/></label><Text id={help}>原款項稿未保存活動時區；請填寫當時使用的時區。未填或歧義時間保留原值，到表單核對補齊。</Text></div>}
 <Button variant="secondary" disabled={busy} onClick={()=>void prepare()}>檢查此舊稿的轉換</Button>
 {plan&&<Notice><MoneyPreview plan={plan}/>{plan.rows.length>1&&<Text>另有 {plan.rows.length-1} 筆同一原稿版本一併保全。不同款項編號或原請求仍需核對。</Text>}{plan.pending?<Text>目的表單有待確認操作，不能覆寫；請先確認原結果。</Text>:<>{plan.previous!==null&&plan.previous!==plan.raw&&<label className="consent"><input type="checkbox" disabled={busy} checked={preserve} onChange={e=>setPreserve(e.target.checked)}/>保全目的表單的現有原稿，再採用此舊稿</label>}<label className="consent"><input type="checkbox" disabled={busy} checked={confirm} onChange={e=>setConfirm(e.target.checked)}/>已核對原資料、款項結果與時間；只帶入表單，尚未送出</label><Button disabled={busy||!confirm||plan.previous!==null&&plan.previous!==plan.raw&&!preserve} onClick={()=>void adopt()}>保全並帶入新版表單</Button></>}</Notice>}{message&&<Notice>{message}</Notice>}
 </div>;
}
function MoneyPreview({plan}:{plan:MoneyPlan}){
 const actions:Record<string,string>={record:uiText("登記款項"),report:uiText("申報款項"),accept:uiText("確認申報"),reject:uiText("退回申報"),withdraw:uiText("撤回申報"),reverse:uiText("沖正款項"),close:uiText("確認結清"),reopen:uiText("重新核對帳務")},statuses:Record<string,string>={recorded:uiText("已登記"),pending:uiText("待核對"),accepted:uiText("已確認"),rejected:uiText("已退回"),withdrawn:uiText("已撤回")};
 const displayTime=(time:string)=>time?new Date(Date.parse(time)+8*3600000).toISOString().slice(0,19).replace('T',' '):uiText('未填，需補齊');
 const value=JSON.parse(plan.raw),room=plan.source.kind==='rooms'?RoomEditorRecord.parse(value).value:null,finance=plan.source.kind==='finance'?FinanceEditorDraft.parse(value):null,metadata=room?.legacySource??finance?.legacySource;
 return <div className="legacy-local-data" aria-label="包間與款項轉換核對"><Text>原保存版本：{plan.source.baseRevision??'未記錄'}；帶入後須核對最新{room?'名冊':'帳本'}。</Text>{room?<ul>{room.rooms.map((r,i)=><li key={r.id}>包間 {i+1}：{r.name||'未命名'} · 付款人 {r.payer_id||'未選'} · 人員 {r.person_ids.join('、')||'未分配'}</li>)}</ul>:finance&&<><Text>原操作：{plan.source.kind==='finance'?actions[plan.source.command]:''}；原款項／目標編號：{'id' in finance.operation?finance.operation.id:'report_id' in finance.operation?finance.operation.report_id:'entry_id' in finance.operation?finance.operation.entry_id:'不新增款項編號'}</Text>{metadata?.resolvedId&&<Text>原款項已存在（{statuses[plan.originState??'']}），後續稿只讀保留，不能重建。</Text>}{'transaction' in finance.operation&&<dl><dt>金額</dt><dd>{finance.operation.transaction.amount||'未填'}</dd><dt>原實際時間（{plan.zone||'原時區未記錄'}）</dt><dd>{plan.source.kind==='finance'?plan.source.value.occurred_at:''}</dd><dt>帶入時間（台北 UTC+08:00）</dt><dd>{displayTime(finance.operation.transaction.occurred_at)}</dd><dt>原自訂人員選項</dt><dd>{finance.operation.transaction.custom_parties.map(p=>p.name||p.id).join('、')||'無'}</dd></dl>}</>}{metadata?.notes.map((note,i)=><Text key={i}>{note.field}：{note.message}；原值：{note.original||'未填'}</Text>)}</div>;
}
