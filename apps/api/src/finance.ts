import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DB } from '@qgroup/database';
import { FinancePayload, FinancePreview, FinancePreviewInput, FinanceSaveInput, FinanceResult, ViewFinanceOrigin, FinanceOriginResult, type FinanceCommand, type FinancePrepared, type FinanceTransaction } from '@qgroup/contracts';
import { DomainError } from '@qgroup/domain';
import { z } from 'zod';
import { hash, type Security } from './security';
import { activityDate, appendEventAudit, eventRow, eventScopes, legacyStamp, requireEventRevision, type EventRow } from './activity-arrangements';
import { requireActivityAccess } from './activity-access';
import { createActivityBot, type ActivityBotDefaults } from './activity-bot';
import { projectJournal } from './finance-projection';
import { financeBill, financeBlockers, financeEntries, financeKinds, financeParties, financeReports, financeRooms, financeSummary, financeView, relabelParties, validateRoomJournal } from './finance-context';
type User={id:string;nickname:string};
function fail(message:string,status=400):never{throw new DomainError('FINANCE_OPERATION',message,status);}
/** Same sorted Unicode JSON as the retained Python preview. */
function canonical(value:unknown):string{if(typeof value==='bigint')return value.toString();if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,v])=>JSON.stringify(key)+':'+canonical(v)).join(',')+'}';return JSON.stringify(value);}
export const financeToken=(event:EventRow,operation:z.infer<typeof FinancePrepared>)=>hash(canonical([event.id,event.revision,{...operation,...(operation.last_seq!==undefined?{last_seq:BigInt(operation.last_seq)}:{})}]));
export function financeTransaction(db:DB,event:EventRow,user:User,input:z.infer<typeof FinanceTransaction>,reporting:boolean,now:Date,roomDefinitions?:{id:string;name:string}[]):z.infer<typeof FinancePayload>{
  const {parties,owned}=financeParties(db,event,user.id),used:string[]=[];
  if(reporting&&!['collection','expense','deposit'].includes(input.kind))fail('只能申報轉帳、個人墊付或訂金／押金',403);
  if(reporting&&input.custom_parties.length)fail('其他款項人員須由結算管理者核對建立',403);
  for(const p of input.custom_parties){if(parties.has(p.id))fail('其他款項人員標識重複');parties.set(p.id,{...p,label:p.name});}relabelParties(parties);
  function party(value:string|undefined){if(!value||!/^(account|person|custom):[a-f0-9]{16}$/.test(value)||!parties.has(value))fail('請選擇本活動有效的款項人員');used.push(value);return value;}
  const occurred_at=activityDate(input.occurred_at);if(Date.parse(occurred_at)>now.getTime())fail('實際款項時間不能在將來');
  const [whole,decimal='']=input.amount.split('.'),amount_cents=Number(whole)*100+Number(decimal.padEnd(2,'0'));if(amount_cents<=0)fail('款項金額須大於零');
  const kind=input.kind,result:z.infer<typeof FinancePayload>={kind,amount_cents,occurred_at,note:input.note,reason:input.reason};
  if(['collection','refund','reimbursement'].includes(kind)){
    result.payer_id=party(input.payer_id);const funding=kind==='collection'?'pool':input.funding??'pool';if(kind!=='collection')result.funding=funding;
    if(funding==='payer'){result.funder_id=party(input.funder_id);if(result.funder_id===result.payer_id)fail('個人墊退／償還的出資人與款項歸屬不能相同');}else result.custodian_id=party(input.custodian_id);
    result.actual_party_id=input.actual_party_id?party(input.actual_party_id):result.payer_id;if(result.actual_party_id!==result.payer_id&&!input.reason)fail('實際轉款／收款人與款項歸屬不同，請填寫代付依據');
  }else if(['expense','deposit','merchant_refund','deposit_return'].includes(kind)){
    if(!input.funding||(reporting&&input.funding!=='payer'))fail('請選擇個人墊付或活動代收資金');result.funding=input.funding;
    if(input.funding==='payer')result.payer_id=party(input.payer_id);else result.custodian_id=party(input.custodian_id);
    if(kind==='expense'||kind==='deposit'){if(!input.merchant)fail('請填寫店家');result.merchant=input.merchant;}
  }else if(kind==='credit_transfer'||kind==='cash_transfer'){
    result.from_id=party(input.from_id);result.to_id=party(input.to_id);if(result.from_id===result.to_id)fail('轉出與轉入人員不能相同');if(!input.reason)fail('移交資金或更正歸屬須填寫原因');
  }
  let reference:ReturnType<typeof financeEntries>[number]|undefined;
  if(['merchant_refund','deposit_return','deposit_apply'].includes(kind)){
    reference=financeEntries(db,event.id).find(e=>e.id===input.reference_id);const expected=kind==='merchant_refund'?['expense','deposit_apply']:['deposit'];
    if(!input.reference_id||!/^[a-f0-9]{16}$/.test(input.reference_id)||!reference||!expected.includes(reference.kind))fail('請選擇本活動對應的店家支出或訂金記錄');
    result.reference_id=reference.id;result.merchant=reference.payload.merchant;if(kind==='deposit_apply'&&!input.reason)fail('訂金抵消費或押金轉損失須填寫依據');
  }
  const rooms=roomDefinitions??financeRooms(db,event.id);if(rooms.length||input.room_id){const room=rooms.find(r=>r.id===input.room_id);if(!room)fail('請選擇本活動的包間');if(reference&&reference.payload.room_id!==room.id)fail('退款或訂金處理須與原款項屬於同一包間');result.room_id=room.id;result.room_name=room.name;}
  if(reporting&&(!result.payer_id||!owned.has(result.payer_id)))fail('只能申報本人或自己管理的未綁定同行款項',403);
  if(input.custom_parties.some(p=>!used.includes(p.id)))fail('新款項人員必須用於本次記錄');
  result.parties=[...new Set(used)].map(id=>parties.get(id)!);result.method=input.method;return result;
}
export function prepareFinance(db:DB,event:EventRow,user:User,input:z.infer<typeof FinanceCommand>,now:Date):z.infer<typeof FinancePrepared>{
  if(event.lifecycle==='draft')fail('發布活動後才能登記款項',409);const manage=eventScopes(db,event,user.id).has('settlement'),action=input.command;
  if(!['report','withdraw'].includes(action)&&!manage)fail('只有發起者或指定結算人可以確認或更正款項',403);
  const entries=financeEntries(db,event.id),claims=financeReports(db,event.id),summary=financeSummary(db,event,user.id,entries,claims),result:z.infer<typeof FinancePrepared>={command:action};
  function validate(candidate:(typeof entries)[number]){const all=[...entries,candidate];projectJournal(all);validateRoomJournal(all,financeRooms(db,event.id),!!financeBill(db,event.id).invoice?.rooms?.length);}
  const next=(id:string,kind:string,payload:z.infer<typeof FinancePayload>,reversal_of:string|null=null)=>({id,kind,payload,reversal_of,seq:BigInt(summary.last_seq)+1n,actor_name:user.nickname,occurred_at:legacyStamp(now),created_at:legacyStamp(now),source_report_id:null});
  if(input.command==='record'||input.command==='report'){
    if(db.prepare('SELECT 1 FROM finance_entries WHERE id=? UNION ALL SELECT 1 FROM finance_reports WHERE id=?').get(input.id,input.id))fail('這筆記錄已存在，請載入最新版核對',409);
    result.id=input.id;result.transaction=financeTransaction(db,event,user,input.transaction,action==='report',now);
    if(action==='report'){if(claims.filter(r=>!r.decision&&r.reporter_id===user.id).length>=20||claims.filter(r=>!r.decision).length>=500)fail('待核對申報過多，請先處理已有申報',409);}else validate(next(result.id,result.transaction.kind!,result.transaction));
  }else if(input.command==='accept'||input.command==='reject'||input.command==='withdraw'){
    const claim=claims.find(r=>r.id===input.report_id);if(!claim||(!manage&&claim.reporter_id!==user.id))fail('申報不存在或無權處理',404);if(claim.decision)fail('申報已處理，請載入最新版',409);if(action==='withdraw'&&claim.reporter_id!==user.id)fail('只能撤回自己的未確認申報',403);if(action==='reject'&&!input.reason)fail('請填寫退回原因');
    result.report_id=input.report_id;result.reason=input.reason;if(action==='accept'){result.id=claim.id;result.transaction=claim.payload;validate(next(claim.id,claim.payload.kind!,claim.payload));}
  }else if(input.command==='reverse'){
    const entry=entries.find(e=>e.id===input.entry_id);if(!entry||!financeKinds.has(entry.kind))fail('只能沖正本活動已確認的款項',404);if(projectJournal(entries).reversed.has(entry.id))fail('款項已經沖正',409);result.entry_id=entry.id;result.reason=input.reason;validate(next('preview-reversal','reversal',{},entry.id));
  }else if(input.command==='close'){
    if(summary.state==='closed')fail('帳務已結清',409);const problems=financeBlockers(summary,claims.filter(r=>!r.decision).length);if(problems.length)fail(problems.join('；'),409);result.bill_version=summary.bill_version;result.last_seq=summary.last_seq;
  }else if(input.command==='reopen'){if(summary.state!=='closed')fail('目前帳務尚未結清',409);result.reason=input.reason;}
  return result;
}
export function previewFinance(db:DB,event:EventRow,user:User,input:z.infer<typeof FinanceCommand>,now:Date){const command=prepareFinance(db,event,user,input,now),entries=financeEntries(db,event.id);if(['record','accept','reverse'].includes(command.command))entries.push({id:command.id??'preview',kind:command.command==='reverse'?'reversal':command.transaction!.kind!,seq:BigInt(entries.at(-1)?.seq??0)+1n,payload:command.transaction??{},reversal_of:command.entry_id??null,actor_name:user.nickname,occurred_at:legacyStamp(now),created_at:legacyStamp(now),source_report_id:null});const state=projectJournal(entries);return FinancePreview.parse({command,preview_token:financeToken(event,command),projection:{cost_cents:state.cost,held_cents:state.held,deposit_cents:state.deposit,credit:Object.fromEntries(state.credit)}});}
export function requireFinanceAuthority(db:DB,event:EventRow,user:User,operation:z.infer<typeof FinanceCommand>){
 if(!['report','withdraw'].includes(operation.command)&&!eventScopes(db,event,user.id).has('settlement'))fail('沒有款項管理權限',403);
 if(operation.command==='withdraw'){const claim=financeReports(db,event.id).find(r=>r.id===operation.report_id);if(!claim||claim.reporter_id!==user.id)fail('只能撤回自己的申報',403);}
}
/** Both native writes and original-request recovery use the same append/audit/bot transaction. */
export function executeFinance(db:DB,event:EventRow,user:User,input:{revision:number;operation:z.infer<typeof FinanceCommand>;preview_token:string},at:Date,bot:ReturnType<typeof createActivityBot>,onHookError:()=>void){
 const id=event.id;
    requireEventRevision(event,input.revision);const command=prepareFinance(db,event,user,input.operation,at);if(input.preview_token!==financeToken(event,command))fail('款項內容已有變動，請重新核對預覽',409);
    const stamp=legacyStamp(at),before=financeSummary(db,event,user.id),action=command.command;
    const append=(uid:string,kind:string,payload:z.infer<typeof FinancePayload>|z.infer<typeof FinancePrepared>,source:string|null=null,reversal:string|null=null)=>db.prepare('INSERT INTO finance_entries(id,event_id,kind,payload_json,occurred_at,actor_id,actor_name,created_at,source_report_id,reversal_of) VALUES(?,?,?,?,?,?,?,?,?,?)').run(uid,id,kind,canonical({...payload,...('last_seq' in payload&&payload.last_seq!==undefined?{last_seq:BigInt(payload.last_seq)}:{})}),'occurred_at' in payload?payload.occurred_at??stamp:stamp,user.id,user.nickname,stamp,source,reversal);
    if(action==='report')db.prepare('INSERT INTO finance_reports(id,event_id,reporter_id,reporter_name,payload_json,created_at) VALUES(?,?,?,?,?,?)').run(command.id!,id,user.id,user.nickname,JSON.stringify(command.transaction),stamp);
    else if(action==='accept'||action==='reject'||action==='withdraw'){
      db.prepare('INSERT INTO finance_report_actions(event_id,report_id,decision,actor_id,actor_name,reason,created_at) VALUES(?,?,?,?,?,?,?)').run(id,command.report_id!,{accept:'accepted',reject:'rejected',withdraw:'withdrawn'}[action]!,user.id,user.nickname,command.reason!,stamp);
      if(action==='accept')append(command.id!,command.transaction!.kind!,command.transaction!,command.report_id);
    }else if(action==='record')append(command.id!,command.transaction!.kind!,command.transaction!);
    else append(randomBytes(8).toString('hex'),{reverse:'reversal',close:'close',reopen:'reopen'}[action]!,command,null,command.entry_id??null);
    const after=financeSummary(db,event,user.id),privateAction=['report','reject','withdraw'].includes(action),operation=privateAction?Object.fromEntries(Object.entries(command).filter(([key])=>!['transaction','reason'].includes(key))):command;
    appendEventAudit(db,event,user,'finance_'+action,{state:before.state},{operation,state:after.state},privateAction?'':command.reason??command.transaction?.reason??'',stamp);
    const recipients=new Set([event.owner_id,...(db.prepare('SELECT user_id FROM event_roles WHERE event_id=?').all(id) as {user_id:string}[]).filter(r=>eventScopes(db,event,r.user_id).has('settlement')).map(r=>r.user_id)]),{users}=financeParties(db,event,user.id);
    for(const p of command.transaction?.parties??[]){if(users.has(p.id))recipients.add(users.get(p.id)!);else if(p.id.startsWith('person:')){const row=db.prepare('SELECT manager_id FROM attendees WHERE event_id=? AND id=?').get(id,p.id.slice(7)) as {manager_id:string}|undefined;if(row)recipients.add(row.manager_id);}}
    if(command.report_id)recipients.add((db.prepare('SELECT reporter_id FROM finance_reports WHERE id=?').get(command.report_id) as {reporter_id:string}).reporter_id);
    for(const recipient of recipients)if(recipient!==user.id)db.prepare("INSERT INTO notifications(user_id,event_id,kind,message,created_at) VALUES(?,?,'finance_updated',?,?)").run(recipient,id,event.title+' 的款项记录有更新，请查看收付款账本',stamp);
    try{db.transaction(()=>{if(action==='close')bot.broadcast(eventRow(db,id)!,'finance_closed');else if(action==='reopen'||(before.state==='closed'&&after.state!=='closed'))bot.broadcast(eventRow(db,id)!,'finance_reopened');for(const recipient of recipients)if(recipient!==user.id)bot.personal(id,recipient,'finance_updated');}) ();}catch{onHookError();}
 return {id,revision:eventRow(db,id)!.revision};
}
export function registerFinance(app:FastifyInstance,db:DB,security:Security,now:()=>Date,defaults:ActivityBotDefaults={}){
  const params=z.object({id:z.string().min(1).max(80)}),cursor=z.string().regex(/^[1-9][0-9]{0,17}$/).transform(BigInt),bot=createActivityBot(db,now,defaults),limits={config:{rateLimit:{max:30,timeWindow:'1 minute'}}};
  function access(id:string,userId:string|null){requireActivityAccess(db,id,userId);return eventRow(db,id)!;}
  app.get('/api/v2/activities/:id/finance',async request=>db.transaction(()=>{const {id}=params.parse(request.params),query=z.object({before:cursor.optional(),before_report:cursor.optional()}).strict().parse(request.query),device=security.read(request);if(request.headers['x-account-scope']||device)security.scoped(request);return financeView(db,access(id,device?.kind==='member'?device.id:null),device?.kind==='member'?device.id:null,query.before,query.before_report);})());
  app.post('/api/v2/activities/:id/finance/origin',limits,async request=>db.transaction(()=>{
    const {id}=params.parse(request.params),user=security.memberWrite(request),event=access(id,user.id),input=ViewFinanceOrigin.parse(request.body),manager=eventScopes(db,event,user.id).has('settlement');
    if(event.lifecycle==='draft'||event.status==='deleted')fail('找不到可核對的活動帳本',404);
    if(input.kind==='record'&&!manager)fail('沒有款項管理權限',403);
    const entry=db.prepare('SELECT event_id,source_report_id,kind FROM finance_entries WHERE id=?').get(input.id) as {event_id:string;source_report_id:string|null;kind:string}|undefined;
    const report=db.prepare('SELECT event_id,reporter_id FROM finance_reports WHERE id=?').get(input.id) as {event_id:string;reporter_id:string}|undefined;
    if(entry&&entry.event_id!==id||report&&report.event_id!==id||input.kind==='record'&&(report||entry&&!financeKinds.has(entry.kind))||input.kind==='report'&&entry&&(!report||entry.source_report_id!==input.id))fail('原款項編號已用於不同活動或操作，不能重建',409);
    if(report&&!manager&&report.reporter_id!==user.id)fail('不能核對其他人的原申報',403);
    if(!entry&&!report){if(input.kind==='report'&&!financeSummary(db,event,user.id).can_report)fail('目前不能申報本人款項',403);return FinanceOriginResult.parse({state:'missing'});}
    const decision=report?(db.prepare('SELECT decision FROM finance_report_actions WHERE report_id=?').get(input.id) as {decision:string}|undefined)?.decision:null;
    return FinanceOriginResult.parse({state:'existing',id:input.id,kind:input.kind,status:input.kind==='record'?'recorded':decision??'pending'});
  })());
  app.post('/api/v2/activities/:id/finance/preview',limits,async request=>db.transaction(()=>{const {id}=params.parse(request.params),input=FinancePreviewInput.parse(request.body),user=security.memberWrite(request),event=access(id,user.id);requireEventRevision(event,input.revision);return previewFinance(db,event,user,input.operation,now());})());
  app.post('/api/v2/activities/:id/finance',limits,async request=>db.transaction(()=>{
    const {id}=params.parse(request.params),input=FinanceSaveInput.parse(request.body),user=security.memberWrite(request),event=access(id,user.id),key=z.string().uuid().parse(request.headers['idempotency-key']),signature='finance:'+encodeURIComponent(id)+':'+hash(JSON.stringify(input));
    // Current command authority is checked before returning an old receipt; revisions are checked for new writes.
    requireFinanceAuthority(db,event,user,input.operation);
    const old=db.prepare('SELECT signature,response_json FROM request_results WHERE user_id=? AND request_key=?').get(user.id,key) as {signature:string;response_json:string}|undefined;if(old){if(old.signature!==signature)fail('這個操作編號已用於另一份內容',409);return FinanceResult.parse(JSON.parse(old.response_json));}
    const result=executeFinance(db,event,user,input,now(),bot,()=>app.log.error({eventId:id},'Finance bot hook failed; business write preserved'));
    db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run(user.id,key,signature,JSON.stringify(result),200,legacyStamp(now()));return result;
  }).immediate());
}
