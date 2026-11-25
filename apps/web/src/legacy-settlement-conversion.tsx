import { errorText, uiText } from './language';
import { useEffect,useId,useRef,useState } from 'react';
import { Link } from 'react-router-dom';
import { Text } from 'yahha-ui';
import { Button } from './kimi-ui';
import { Notice } from './shared';
import type { Member } from './member-access';
import { decodeSettlement } from './legacy-settlement';
import { prepareSettlement,adoptSettlement,type SettlementPlan } from './legacy-settlement-migration';
import { SettlementEditorRecord } from './settlement-editor-record';
import type { LegacyInventory,LegacySnapshot } from './legacy-local-store';
export function LegacySettlementConversion({viewer,inventory,row,validate,refresh}:{viewer:Member;inventory:LegacyInventory;row:LegacySnapshot;validate:()=>Promise<Member>;refresh:()=>Promise<unknown>}){
 const help=useId(),active=useRef(false),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[zone,setZone]=useState(''),[duration,setDuration]=useState(''),[plan,setPlan]=useState<SettlementPlan|null>(null),[confirm,setConfirm]=useState(false),[preserve,setPreserve]=useState(false);
 useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
 let decoded:ReturnType<typeof decodeSettlement>|null=null,error='';try{decoded=decodeSettlement(row,viewer.scope);}catch(failure){error=failure instanceof Error?errorText(failure):uiText('原欄位尚未完成映射。');}
 async function prepare(){if(busy)return;setBusy(true);setMessage('');setPlan(null);setConfirm(false);setPreserve(false);try{const fresh=await validate();if(!active.current)return;const next=await prepareSettlement(fresh,inventory,row,zone,duration);await validate();if(active.current)setPlan(next);}catch(failure){if(active.current)setMessage(failure instanceof Error?errorText(failure):uiText("轉換檢查失敗，原稿保留。"));}finally{if(active.current)setBusy(false);}}
 async function adopt(){if(!plan||busy||!confirm)return;setBusy(true);setMessage('');try{await adoptSettlement(plan,viewer.scope,inventory.epoch,preserve,validate,()=>active.current);if(active.current){setMessage(uiText("目的原稿與轉換紀錄已保存，尚未發布結算。"));await refresh();}}catch(failure){if(active.current)setMessage(failure instanceof Error?errorText(failure):uiText("轉換尚未確認，原稿保留。"));}finally{if(active.current)setBusy(false);}}
 const mapped=inventory.mappings.find(m=>m.id===row.id);
 if(mapped)return <Notice>{mapped.sourceId===row.id?'此原稿已轉換。':'此版本已保全，採用同一原稿的目前版本。'}<Link to={mapped.path}>開啟目的原稿</Link>{message&&<Text>{message}</Text>}</Notice>;
 if(!decoded)return <Notice>此稿不能轉換：{error}</Notice>;
 return <div className="legacy-conversion"><div className="account-field"><label>原裝置 IANA 時區<input value={zone} placeholder="Asia/Taipei" disabled={busy} aria-describedby={help} onChange={e=>{setZone(e.target.value);setPlan(null);setConfirm(false);}}/></label><Text id={help}>原付款時間使用當時裝置時區。未填時區則保留原值，到表單核對補齊；不使用目前裝置設定。</Text></div>
 {decoded.durationHours===null&&decoded.value.items.some(i=>i.mode==='duration')&&<div className="account-field"><label>原活動時長（小時）<input inputMode="decimal" value={duration} disabled={busy} onChange={e=>{setDuration(e.target.value);setPlan(null);setConfirm(false);}}/></label><Text>只用於原來未填的參與分鐘。原時長未保存；未填則逐人補齊，不套用目前活動時長。</Text></div>}
 <Button variant="secondary" disabled={busy} onClick={()=>void prepare()}>檢查此舊稿的轉換</Button>
 {plan&&<Notice><SettlementConversionPreview plan={plan}/>{plan.rows.length>1&&<Text>另有 {plan.rows.length-1} 筆同一發布帳號的原稿版本一併保全；原請求仍須核對。</Text>}{plan.pending?<Text>目的表單有待確認操作，不能覆寫；請先確認原結果。</Text>:<>{plan.previous!==null&&plan.previous!==plan.raw&&<label className="consent"><input type="checkbox" disabled={busy} checked={preserve} onChange={e=>setPreserve(e.target.checked)}/>保全目的表單的現有原稿，再採用此舊稿</label>}<label className="consent"><input type="checkbox" disabled={busy} checked={confirm} onChange={e=>setConfirm(e.target.checked)}/>已核對原分攤、付款設定與時間；只帶入表單，尚未發布</label><Button disabled={busy||!confirm||plan.previous!==null&&plan.previous!==plan.raw&&!preserve} onClick={()=>void adopt()}>保全並帶入新版表單</Button></>}</Notice>}{message&&<Notice>{message}</Notice>}
 </div>;
}
function SettlementConversionPreview({plan}:{plan:SettlementPlan}){
 const v=SettlementEditorRecord.parse(JSON.parse(plan.raw)).value,modes={shares:uiText("共同份數"),equal:uiText("均分"),fixed:uiText("固定金額"),weights:uiText("比例"),duration:uiText("參與分鐘")},kinds={expense:uiText("消費"),refund:uiText("店家退款"),discount:uiText("減免")},time=v.room_payment_details?.occurred_at;
 return <div className="legacy-local-data" aria-label="結算轉換核對"><Text>原名冊版本：{plan.source.baseRevision??'未記錄'}；原結算版本：{plan.source.baseVersion??'未記錄'}。帶入後須核對最新名冊與帳本。</Text><Text>列入 {v.people.length} 人；另保留 {v.retained_people?.length??0} 人的份數與付款設定。</Text><Text>原付款時間（{plan.zone||'原裝置時區未記錄'}）：{plan.source.value.merchant_time||'未填'}；帶入 UTC 時間：{time||'未填，需補齊'}。</Text>
 <ul>{plan.source.value.people.map(p=><li key={p.id}>{p.id} · {p.include?'列入':'未列入'} · {p.share||'未填'} 份 · {p.payment_mode==='fixed'?'固定付款金額':'付款比例'}：{p.payments.map(a=>a.payer_id+'／'+(p.payment_mode==='fixed'?a.amount:a.share)).join('、')||'未填'}</li>)}</ul>
 <Text>結算方式：{v.rooms!==undefined?'實際包間':'費用項目'}；未採用的另一方式設定保留於原稿。</Text><ul>{v.items.map(i=><li key={i.id}>{i.name||'未命名'} · {kinds[i.kind]} · {i.amount||'未填'} · {modes[i.mode]} · {i.scope==='common'?'全體':'所選人員'}{i.receipt?' · 原憑證保留':''}</li>)}</ul><ul>{(v.rooms??v.retained_rooms??[]).map(r=><li key={r.id}>{r.name||'未命名'} · {r.amount||'未填金額'} · {r.payer_id||'未選付款人'} · {r.person_ids.join('、')||'未分配'}</li>)}</ul><Text>收款碼 {v.payment_codes.length} 張；{v.rooms!==undefined?'包間模式不附統一收款碼，原選擇保留。':'原圖片／碼庫編號／歷史版本保持。'}</Text>
 {v.legacySource?.notes.map((note,i)=><Text key={i}>{note.field}：{note.original||'未填'}。{note.message}</Text>)}</div>;
}
