import { errorText, uiText } from './language';
import { useEffect,useRef,useState,type ReactNode } from 'react';
import { Link,useLocation } from 'react-router-dom';
import { useQuery,useQueryClient } from '@tanstack/react-query';
import { Button,Heading,Surface,Text } from 'yahha-ui';
import { LegacyRequestReceipt } from '@qgroup/contracts';
import { authHttp } from './auth';
import { MemberAccess,type Member } from './member-access';
import { Failure,Notice,PageIntro,sessionQuery,useSession } from './shared';
import { describeLegacy,legacyBlocks,legacyCreateIntent } from './legacy-local-record';
import { CreateIntentLookup } from './create-intents';
import { LegacyAuthoringConversion } from './legacy-authoring-conversion';
import { LegacyMoneyConversion } from './legacy-money-conversion';
import { LegacySettlementConversion } from './legacy-settlement-conversion';
import { LegacyFinanceRecovery } from './legacy-finance-recovery';
import { deviceDraftEpoch } from './draft-store';
import { checkLegacySnapshot,preserveLegacy,type LegacyInventory,type LegacySnapshot } from './legacy-local-store';
const endpoint='/me/local-history';
function useOriginals(viewer:Member){return useQuery({queryKey:['private',viewer.scope,'legacy-local'],queryFn:async()=>{const inventory=await preserveLegacy(viewer.scope),epoch=await deviceDraftEpoch();return {...inventory,mappings:inventory.mappings.filter(m=>m.deviceEpoch===epoch)};},refetchOnWindowFocus:'always',staleTime:0});}
export function LegacyLocalLink(){return <Link to={endpoint}>舊看板本機紀錄</Link>;}
/** A legacy snapshot must be reconciled before its related new editor can create a second action. */
export function LegacyLocalGuard({children}:{children:ReactNode}){
  const session=useSession(),route=useLocation();
  if(session.isPending)return <Notice>正在確認帳號…</Notice>;
  if(session.error)return <Failure error={session.error} retry={()=>void session.refetch()}/>;
  if(!session.data.authenticated)return children;
  return <Guard key={session.data.scope+':'+route.pathname} viewer={session.data} path={route.pathname}>{children}</Guard>;
}
function Guard({viewer,path,children}:{viewer:Member;path:string;children:ReactNode}){
  const query=useOriginals(viewer);
  if(query.isPending||query.isFetching)return <Notice>正在核對舊本機紀錄…</Notice>;
  if(query.error)return <Failure error={query.error} retry={()=>void query.refetch()}/>;
  const mapped=new Set(query.data.mappings.map(m=>m.id));
  if(query.data.rows.some(row=>!mapped.has(row.id)&&legacyBlocks(describeLegacy(row.source,viewer.scope),path)))return <Notice>此操作仍有舊看板原稿或原請求。請先核對原結果；目前不會轉成另一筆新版操作。<LegacyLocalLink/></Notice>;
  return children;
}
export function LegacyLocalPage(){return <><PageIntro title="舊看板本機紀錄"/><MemberAccess>{viewer=><Inventory key={viewer.scope} viewer={viewer}/>}</MemberAccess></>;}
function Inventory({viewer}:{viewer:Member}){
  const query=useOriginals(viewer);
  return <Surface className="detail"><Notice>原草稿與請求按身份保全，原儲存仍保留。草稿先核對結果與時間，再明確帶入新版表單；原款項請求可核對並明確重試，其他原請求不重送。</Notice>
    {query.isPending?<Notice>正在讀取舊紀錄…</Notice>:query.error?<Failure error={query.error} retry={()=>void query.refetch()}/>:<>
      {query.data.disabled?<Notice>已登出清除這台裝置的舊紀錄，舊分頁不能自動寫回。</Notice>:!query.data.rows.length?<Text>此帳號在這個瀏覽器沒有舊看板紀錄。</Text>:<ul className="inbox-list">{query.data.rows.map(row=><li key={row.id}><Snapshot viewer={viewer} inventory={query.data} row={row}/></li>)}</ul>}
      <Button variant="secondary" disabled={query.isFetching} onClick={()=>void query.refetch()}>重新讀取舊紀錄</Button>
    </>}
  </Surface>;
}
function visibleData(value:unknown):ReactNode{
  if(value===null||value===undefined)return <span>未填</span>;
  if(typeof value==='string')return <span className="preserve-lines">{value}</span>;
  if(typeof value==='number'||typeof value==='boolean')return <span>{String(value)}</span>;
  if(Array.isArray(value))return <ol>{value.map((item,i)=><li key={i}>{visibleData(item)}</li>)}</ol>;
  if(typeof value==='object')return <dl>{Object.entries(value).filter(([key])=>!/token|pin|csrf|cookie|secret|oauth|authorization/i.test(key)).map(([key,item])=><div key={key}><dt>{key}</dt><dd>{visibleData(item)}</dd></div>)}</dl>;
  return null;
}
function imageSource(value:string){const source=value.startsWith('data:image/png;base64,')?value.slice(22):value;return /^[A-Za-z0-9+/]+={0,2}$/.test(source)&&source.startsWith('iVBOR')?'data:image/png;base64,'+source:null;}
function DraftContents({data}:{data:Record<string,unknown>}){
  const labels:Record<string,string>={fields:uiText("表單內容"),dataset:uiText("原稿狀態"),slots:uiText("候選時段"),rooms:uiText("包廂"),people:uiText("結算人員"),items:uiText("費用與憑證"),custom:uiText("自訂付款人"),paymentCodes:uiText("收款碼"),qr:uiText("舊收款碼"),revision:uiText("原版本"),_revision:uiText("原版本"),_intent:uiText("原建立識別"),client_intent:uiText("原建立識別"),_lifecycle:uiText("原活動狀態"),capacity_unlimited:uiText("不限人數"),exact_time:uiText("精確時間"),deadline_date:uiText("截止日期"),deadline_time:uiText("截止時間"),deadlineTouched:uiText("已修改截止時間"),codes:uiText("收款碼"),edit:uiText("原款項操作"),id:uiText("原編號"),name:uiText("名稱"),title:uiText("名稱"),value:uiText("原值"),checked:uiText("原勾選狀態"),intent:uiText("原建立識別"),lifecycle:uiText("原活動狀態"),amount:uiText("金額"),receipt:uiText("消費憑證"),image:uiText("圖片"),kind:uiText("類型"),share:uiText("份數"),reason:uiText("原因"),person_ids:uiText("人員編號"),payer_id:uiText("付款人編號"),date:uiText("日期"),time:uiText("時間"),recordId:uiText("原款項編號"),command:uiText("原操作"),preview:uiText("原預覽"),description:uiText("內容"),capacity:uiText("人數上限"),event_date:uiText("活動日期"),start_time:uiText("開始時間"),deadline:uiText("截止時間"),timezone:uiText("時區"),fee_policy:uiText("費用約定"),start_day_offset:uiText("開始日期偏移"),duration_hours:uiText("時長"),location:uiText("地點"),minimum_participants:uiText("成團人數"),visibility:uiText("可見性"),bot_enabled:uiText("群同步"),withdrawal_deadline:uiText("退出截止時間")};
  const label=(key:string)=>labels[key]??key;
  const image=(value:unknown):ReactNode=>{
    if(typeof value==='string'){const src=imageSource(value);return src?<img src={src} alt="舊草稿圖片" style={{maxWidth:'100%'}}/>:visibleData(value);}
    if(Array.isArray(value))return <ol>{value.map((item,i)=><li key={i}>{image(item)}</li>)}</ol>;
    if(value&&typeof value==='object')return <dl>{Object.entries(value).filter(([key])=>!/token|pin|csrf|cookie|secret|oauth|authorization/i.test(key)).map(([key,item])=><div key={key}><dt>{label(key)}</dt><dd>{key==='name'&&'value' in value&&typeof item==='string'?label(item):image(item)}</dd></div>)}</dl>;
    return visibleData(value);
  };
  return <div className="legacy-local-data">{['fields','value','dataset','slots','rooms','people','items','custom','paymentCodes','qr','revision','edit'].filter(key=>data[key]!==undefined).map(key=><details key={key}><summary>{key==='value'&&data.react===1?'表單內容':label(key)}</summary>{image(data[key])}</details>)}</div>;
}
function hasCredentials(value:unknown):boolean{
  if(!value||typeof value!=='object')return false;
  const credential=(key:string)=>/token|(?:^|_)pin(?:_|$)|csrf|cookie|secret|oauth|authorization/i.test(key);
  if(Array.isArray(value))return value.some(hasCredentials);
  if('name' in value&&'value' in value&&typeof value.name==='string'&&credential(value.name))return true;
  return Object.entries(value).some(([key,item])=>credential(key)||hasCredentials(item));
}
function Snapshot({viewer,inventory,row}:{viewer:Member;inventory:LegacyInventory;row:LegacySnapshot}){
  const description=describeLegacy(row.source,viewer.scope),intent=legacyCreateIntent(description),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[receipt,setReceipt]=useState<ReturnType<typeof LegacyRequestReceipt.parse>|null>(null),active=useRef(false),client=useQueryClient();
  useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  async function original(){
    const fresh=await client.fetchQuery({...sessionQuery,staleTime:0});
    if(!fresh.authenticated||fresh.scope!==viewer.scope)throw Error('帳號已變更，請重新讀取目前帳號。');
    await checkLegacySnapshot(viewer.scope,inventory.epoch,row);return fresh;
  }
  async function check(){
    if(busy||!description.request)return;setBusy(true);setMessage('');setReceipt(null);
    try{
      const fresh=await original();if(!active.current)return;
      const result=await authHttp(fresh).request('POST /api/v2/me/legacy-requests/check', { body: description.request }, LegacyRequestReceipt);
      await original();if(active.current){setReceipt(result);setMessage(result.committed?uiText("原操作已提交。請查看目前資料與權限；不會重送。"):uiText("尚未查到原回執。原 payload 與編號保留，不能據此認定未建立。"));}
    }catch(error){if(active.current)setMessage(error instanceof Error?errorText(error):uiText("無法查詢原結果，請保留原紀錄。"));}
    finally{if(active.current)setBusy(false);}
  }
  async function download(){
    if(busy||description.kind!=='draft'||hasCredentials(row.source))return;setBusy(true);setMessage('');
    try{await original();if(!active.current)return;const url=URL.createObjectURL(new Blob([row.raw],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='kanban-local-draft-'+row.id.slice(0,12)+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);setMessage(uiText("已下載原草稿保全檔；包含本機資料與圖片，請自行保管。"));}
    catch(error){if(active.current)setMessage(error instanceof Error?errorText(error):uiText("無法下載原稿。"));}finally{if(active.current)setBusy(false);}
  }
  return <><Heading level={3}>{description.label}</Heading><Text>原保存時間：{typeof (row.source as {at?:unknown}).at==='number'?new Date((row.source as {at:number}).at).toLocaleString('zh-TW'):'未記錄'}</Text>
    {description.kind==='unknown'?<Notice>原紀錄已保全，但格式尚未完成映射，不能轉換或重送。</Notice>:description.kind==='request'?<><Text>原編號：{description.request!.requestKey}</Text><Text>方法：{description.request!.method}</Text><Button variant="secondary" disabled={busy} onClick={()=>void check()}>核對原請求結果</Button></>:hasCredentials(row.source)?<Notice>原稿含授權資料，保留在本機；不能展示或匯出。</Notice>:<><DraftContents data={description.data!}/><Button variant="secondary" disabled={busy} onClick={()=>void download()}>下載此舊草稿</Button></>}
    {message&&<Notice>{message}</Notice>}{receipt?.target&&<Link to={(receipt.target.kind==='activity'?'/activities/':'/time-polls/')+encodeURIComponent(receipt.target.id)}>查看原{receipt.target.kind==='activity'?'活動':'時間投票'}</Link>}
    {description.request?.method==='POST'&&/^\/api\/events\/[A-Za-z0-9_-]{1,80}\/finance$/.test(description.request.path)&&<LegacyFinanceRecovery viewer={viewer} inventory={inventory} row={row} request={description.request} validate={original} refresh={()=>client.invalidateQueries({queryKey:['private',viewer.scope,'legacy-local']})}/>}
    {intent&&!hasCredentials(row.source)&&<CreateIntentLookup key={row.id} viewer={viewer} {...intent} disabled={busy} validate={async()=>{await original();}}/>}
    {description.kind==='draft'&&['舊包廂草稿','舊款項草稿'].includes(description.label)&&!hasCredentials(row.source)&&<LegacyMoneyConversion viewer={viewer} inventory={inventory} row={row} validate={original} refresh={()=>client.invalidateQueries({queryKey:['private',viewer.scope,'legacy-local']})}/>}
    {description.kind==='draft'&&description.label==='舊結算草稿'&&!hasCredentials(row.source)&&<LegacySettlementConversion viewer={viewer} inventory={inventory} row={row} validate={original} refresh={()=>client.invalidateQueries({queryKey:['private',viewer.scope,'legacy-local']})}/>}
    {description.kind==='draft'&&['舊活動草稿','舊時間投票草稿'].includes(description.label)&&!hasCredentials(row.source)&&<LegacyAuthoringConversion viewer={viewer} inventory={inventory} row={row} validate={original} refresh={()=>client.invalidateQueries({queryKey:['private',viewer.scope,'legacy-local']})}/>}
  </>;
}
