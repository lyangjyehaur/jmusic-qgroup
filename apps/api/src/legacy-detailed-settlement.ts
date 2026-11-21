import type { FastifyInstance } from 'fastify';
import type { DB } from '@qgroup/database';
import { decodeLegacyDetailedSettlement, LegacyRequestCheck, LegacyDetailedSettlementRetry, SettlementInput, SettlementPreview } from '@qgroup/contracts';
import { DomainError } from '@qgroup/domain';
import { withApiError } from './error-display';
import { hash, type Security } from './security';
import { originalRequestSignature } from './legacy-local';
import { requireActivityAccess } from './activity-access';
import { eventRow, legacyStamp, requireEventRevision } from './activity-arrangements';
import { requireSettlement } from './settlement-context';
import { calculateSettlement } from './settlement-calculation';
import { originalSettlementToken } from './legacy-settlement-token';
import { existingPaymentCodes, settlementPublishedBy } from './payment-codes';
import { publishSettlement } from './settlement-command';
import { settlementNotice } from './settlement-notice';
import { createActivityBot, type ActivityBotDefaults } from './activity-bot';
export function registerLegacyDetailedSettlement(app:FastifyInstance,db:DB,security:Security,now:()=>Date,defaults:ActivityBotDefaults={}){
  const bot=createActivityBot(db,now,defaults),limits={bodyLimit:9*1024*1024,config:{rateLimit:{max:30,timeWindow:'1 minute'}}};
  function inspect(request:Parameters<Security['memberWrite']>[0],input:ReturnType<typeof LegacyRequestCheck.parse>){
    const user=security.memberWrite(request);
    let decoded:ReturnType<typeof decodeLegacyDetailedSettlement>;
    try{decoded=decodeLegacyDetailedSettlement(input);}catch{throw withApiError(new DomainError('LEGACY_SETTLEMENT_UNSUPPORTED','原結算欄位尚未支援或缺失；原請求保留，不能重試',400));}
    requireActivityAccess(db,decoded.eventId,user.id);
    const event=eventRow(db,decoded.eventId)!;requireSettlement(db,event,user.id);
    const signature=originalRequestSignature(input.method,input.path,input.data),old=db.prepare('SELECT signature,response_json FROM request_results WHERE user_id=? AND request_key=?').get(user.id,input.requestKey) as {signature:string;response_json:string}|undefined;
    if(old&&old.signature!==signature)throw withApiError(new DomainError('LEGACY_REQUEST_CONFLICT','原操作編號與內容不符，請保留並核對原紀錄',409));
    if(old){
      let result:unknown;try{result=JSON.parse(old.response_json);}catch{throw withApiError(new DomainError('LEGACY_REQUEST_RESULT_MISMATCH','原回執無法解析，請保留並核對原紀錄',409));}
      if(!result||typeof result!=='object'||!('id' in result)||result.id!==event.id)throw withApiError(new DomainError('LEGACY_REQUEST_RESULT_MISMATCH','原回執活動與原請求不一致，請保留並核對原紀錄',409));
    }
    return {user,event,decoded,signature,old,requestKey:input.requestKey};
  }
  const receipt=(id:string)=>({committed:true,target:{kind:'activity' as const,id}});
  function prepare(s:ReturnType<typeof inspect>){
    requireEventRevision(s.event,s.decoded.input.revision);
    let input=s.decoded.input;
    if(s.decoded.paymentChoice==='inherit')input={...input,payment_codes:settlementPublishedBy(db,s.event.id,input.base_version,s.user.id)?existingPaymentCodes(db,s.event.id,input.base_version).map(c=>({kind:c.meta.kind,version:input.base_version})):[]};
    if(s.decoded.paymentChoice==='qr')input={...input,payment_codes:s.decoded.qrImage===null?[]:[{kind:'other',name:'',image:s.decoded.qrImage!}]};
    // Nonempty rooms override omitted/empty unified choices in the original protocol.
    if(s.decoded.paymentChoice==='rooms')input={...input,payment_codes:[]};
    input=SettlementInput.parse(input);
    const calculated=calculateSettlement(db,s.event,s.user,input,now());
    let token:string;try{token=originalSettlementToken(db,s.event,calculated.snapshot,input.base_version);}catch{throw withApiError(new DomainError('LEGACY_SETTLEMENT_PROOF_UNSUPPORTED','原結算憑證資料尚未完整對應；請保留原請求，不能重試',409));}
    if(token!==s.decoded.previewToken)throw withApiError(new DomainError('LEGACY_SETTLEMENT_PREVIEW_CHANGED','原預覽憑證與目前費用、圖片、款項或名冊不符；請保留原請求並核對，不能重試',409));
    const preview=SettlementPreview.parse({snapshot:calculated.snapshot,group_preview:calculated.snapshot.group_notice?settlementNotice(calculated.snapshot).join('\n'):'',preview_token:token,base_revision:s.event.revision,base_version:input.base_version});
    const recovery_token=hash(JSON.stringify({user:s.user.id,key:s.requestKey,signature:s.signature,title:s.event.title,preview,assets:input}));
    return {calculated,input,view:{state:'retryable' as const,title:s.event.title,preview,assets:input,recovery_token}};
  }
  app.post('/api/v2/me/legacy-requests/settlement/inspect',limits,async request=>db.transaction(()=>{
    const input=LegacyRequestCheck.parse(request.body),s=inspect(request,input);return s.old?{state:'committed',receipt:receipt(s.event.id)}:prepare(s).view;
  })());
  app.post('/api/v2/me/legacy-requests/settlement/retry',limits,async request=>db.transaction(()=>{
    const {confirm,recovery_token,...input}=LegacyDetailedSettlementRetry.parse(request.body);void confirm;
    const s=inspect(request,input);if(s.old)return receipt(s.event.id);
    const p=prepare(s);if(p.view.recovery_token!==recovery_token)throw withApiError(new DomainError('LEGACY_SETTLEMENT_REVIEW_CHANGED','原結算核對資料已變更；請重新檢查後確認',409));
    const time=now();
    publishSettlement(db,s.event,s.user,p.input.base_version,p.calculated,()=>time,bot,eventId=>app.log.error({eventId},'Settlement bot hook failed; business write preserved'));
    db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run(s.user.id,input.requestKey,s.signature,JSON.stringify({id:s.event.id,starts_at:s.event.starts_at}),200,legacyStamp(time));
    return receipt(s.event.id);
  }).immediate());
}
