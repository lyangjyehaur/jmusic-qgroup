import type { FastifyInstance } from 'fastify';
import type { DB } from '@qgroup/database';
import { LegacyRequestCheck,LegacyFinanceRetry,decodeLegacyFinance } from '@qgroup/contracts';
import { DomainError } from '@qgroup/domain';
import type { Security } from './security';
import { originalRequestSignature } from './legacy-local';
import { requireActivityAccess } from './activity-access';
import { eventRow,legacyStamp,requireEventRevision } from './activity-arrangements';
import { executeFinance,requireFinanceAuthority,previewFinance } from './finance';
import { createActivityBot,type ActivityBotDefaults } from './activity-bot';
export function registerLegacyFinance(app:FastifyInstance,db:DB,security:Security,now:()=>Date,defaults:ActivityBotDefaults={}){
 const limits={config:{rateLimit:{max:30,timeWindow:'1 minute'}}},bot=createActivityBot(db,now,defaults);
 function inspect(request:Parameters<Security['memberWrite']>[0],input:ReturnType<typeof LegacyRequestCheck.parse>){
  const user=security.memberWrite(request);let decoded:ReturnType<typeof decodeLegacyFinance>;try{decoded=decodeLegacyFinance(input);}catch{throw new DomainError('LEGACY_REQUEST_UNSUPPORTED','原款項欄位尚未支援或缺失；原請求保留，不能重試',400);}
  requireActivityAccess(db,decoded.eventId,user.id);const event=eventRow(db,decoded.eventId)!;
  requireFinanceAuthority(db,event,user,decoded.operation);
  const signature=originalRequestSignature(input.method,input.path,input.data),old=db.prepare('SELECT signature,response_json FROM request_results WHERE user_id=? AND request_key=?').get(user.id,input.requestKey) as {signature:string;response_json:string}|undefined;
  if(old&&old.signature!==signature)throw new DomainError('LEGACY_REQUEST_CONFLICT','原操作編號與內容不符，請保留原紀錄；不能重試不同內容',409);
  if(old){let result:unknown;try{result=JSON.parse(old.response_json);}catch{throw new DomainError('LEGACY_REQUEST_RESULT_MISMATCH','原回執無法解析，請保留並核對原紀錄',409);}if(!result||typeof result!=='object'||!('id' in result)||result.id!==event.id)throw new DomainError('LEGACY_REQUEST_RESULT_MISMATCH','原回執活動與原請求不一致，請保留並核對原紀錄',409);}
  if(!old&&!user.nickname)throw new DomainError('LEGACY_REQUEST_NICKNAME','請先設定稱呼，再核對原請求',400);
  if(!old&&event.status==='deleted')throw new DomainError('LEGACY_REQUEST_GONE','原活動已移除，不能重試款項操作',404);
  return {user,event,decoded,signature,old};
 }
 const receipt=(id:string)=>({committed:true,target:{kind:'activity' as const,id}});
 app.post('/api/v2/me/legacy-requests/finance/inspect',limits,async request=>db.transaction(()=>{
  const input=LegacyRequestCheck.parse(request.body),s=inspect(request,input);
  if(s.old)return {state:'committed',receipt:receipt(s.event.id)};
  requireEventRevision(s.event,s.decoded.revision);
  const preview=previewFinance(db,s.event,s.user,s.decoded.operation,now());
  if(preview.preview_token!==s.decoded.preview_token)throw new DomainError('LEGACY_PREVIEW_EXPIRED','原款項預覽已不符合目前帳本；原請求保留，請核對後更正原稿',409);
  return {state:'retryable',event_id:s.event.id,title:s.event.title,preview};
 })());
 app.post('/api/v2/me/legacy-requests/finance/retry',limits,async request=>db.transaction(()=>{
  const {confirm,...input}=LegacyFinanceRetry.parse(request.body);void confirm;const s=inspect(request,input);
  if(s.old)return receipt(s.event.id);
  executeFinance(db,s.event,s.user,s.decoded,now(),bot,()=>app.log.error({eventId:s.event.id},'Recovered finance bot hook failed; business write preserved'));
  // The old receipt readers refresh event responses when starts_at is present.
  // Store this compatible marker instead of a frozen owner/private event snapshot.
  const marker={id:s.event.id,starts_at:s.event.starts_at};
  db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run(s.user.id,input.requestKey,s.signature,JSON.stringify(marker),200,legacyStamp(now()));
  return receipt(s.event.id);
 }).immediate());
}
