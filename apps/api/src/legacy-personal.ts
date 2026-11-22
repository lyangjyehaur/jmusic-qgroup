import type { FastifyInstance } from 'fastify';
import type { DB } from '@qgroup/database';
import { LegacyRequestCheck,LegacyPersonalRetry,decodeLegacyPersonal } from '@qgroup/contracts';
import { DomainError } from '@qgroup/domain';
import { withApiError } from './error-display';
import { hash,type Security } from './security';
import { originalRequestSignature } from './legacy-local';
import { accountProfile,saveAccountNickname } from './account-profile';
import { markNotificationsRead } from './inbox';
import { ownedPaymentCode,preparePaymentCode,createPaymentCode,archivePaymentCode,existingPaymentCodes } from './payment-codes';
import { imageDigest,paymentImage } from './payment-media';
import { legacyStamp } from './activity-arrangements';
export function registerLegacyPersonal(app:FastifyInstance,db:DB,security:Security,now:()=>Date,botEnabledDefault=false){
 const options={bodyLimit:3*1024*1024,config:{rateLimit:{max:30,timeWindow:'1 minute'}}};
 function inspect(request:Parameters<Security['memberWrite']>[0],input:ReturnType<typeof LegacyRequestCheck.parse>){
  const user=security.memberWrite(request);let command:ReturnType<typeof decodeLegacyPersonal>;
  try{command=decodeLegacyPersonal(input);}catch{throw withApiError(new DomainError('LEGACY_PERSONAL_UNSUPPORTED','原個人操作的方法或欄位尚未支援；原請求保留',400));}
  const signature=originalRequestSignature(input.method,input.path,input.data),old=db.prepare('SELECT signature,response_json,response_status FROM request_results WHERE user_id=? AND request_key=?').get(user.id,input.requestKey) as {signature:string;response_json:string;response_status:number}|undefined;
  if(old){
   if(old.signature!==signature)throw withApiError(new DomainError('LEGACY_REQUEST_CONFLICT','原操作編號與內容不符；原請求保留',409));
   let result:Record<string,unknown>|undefined;try{result=JSON.parse(old.response_json);}catch{}
   let valid=!!result&&typeof result==='object'&&!Array.isArray(result);
   if(command.kind==='profile')valid=valid&&old.response_status===200&&result!.nickname===command.nickname&&result!.draft_scope===user.scope;
   else if(command.kind==='code-create'){
    valid=valid&&old.response_status===201&&typeof result!.id==='string'&&result!.kind===command.code.kind&&result!.name===command.code.name&&typeof result!.created_at==='string';
    if(valid){const owned=ownedPaymentCode(db,user.id,result!.id as string,true),code=command.code,raw='image' in code?paymentImage(code.image):existingPaymentCodes(db,code.source.event_id,code.source.version).find(c=>c.meta.kind===code.source.kind)?.raw;valid=!!raw&&owned.kind===command.code.kind&&owned.name===command.code.name&&owned.digest===imageDigest(raw)&&result!.url==='/api/payment-codes/'+owned.id+'/image';}
   }else{valid=valid&&old.response_status===200&&result!.ok===true;if(command.kind==='code-archive')ownedPaymentCode(db,user.id,command.id,true);}
   if(!valid)throw withApiError(new DomainError('LEGACY_PERSONAL_RESULT_MISMATCH','原回執與個人操作不一致；原請求保留',409));
  }
  const route=command.kind==='profile'?'/me/profile' as const:command.kind==='notifications'?'/inbox' as const:'/me/payment-codes' as const;
  return {user,input,command,signature,old,route};
 }
 function committed(s:ReturnType<typeof inspect>){return {state:'committed' as const,route:s.route};}
 function prepare(s:ReturnType<typeof inspect>){
  const {command,user}=s,profile=accountProfile(db,user.id);
  const affected=command.kind==='profile'?db.prepare("SELECT DISTINCT e.* FROM events e JOIN attendees a ON a.event_id=e.id WHERE a.user_id=? AND a.status!='withdrawn' ORDER BY e.id").all(user.id):[];
  const attendees=command.kind==='profile'?db.prepare("SELECT a.*,COALESCE(u.nickname,a.name) AS nickname,m.nickname AS manager_name FROM attendees a JOIN users m ON m.id=a.manager_id LEFT JOIN users u ON u.id=a.user_id WHERE a.event_id IN (SELECT event_id FROM attendees WHERE user_id=? AND status!='withdrawn') ORDER BY a.id").all(user.id):[];
  const notifications=command.kind==='notifications'?command.ids.flatMap(id=>db.prepare('SELECT id,read_at FROM notifications WHERE id=? AND user_id=?').all(id,user.id)) as {id:number;read_at:string|null}[]:[];
  const code=command.kind==='code-create'?preparePaymentCode(db,user.id,command.code):undefined;
  const archive=command.kind==='code-archive'?ownedPaymentCode(db,user.id,command.id):undefined;
  if(code&&!user.nickname)throw withApiError(new DomainError('NICKNAME_REQUIRED','請先設定稱呼再保存收款碼',400));
  const library=code?db.prepare('SELECT * FROM user_payment_codes WHERE user_id=? ORDER BY id').all(user.id):[];
  const bot=command.kind==='profile'?db.prepare('SELECT config_json FROM bot_settings WHERE id=1').get():null;
  const value={state:'retryable' as const,kind:command.kind,route:s.route,currentNickname:profile.nickname,nickname:command.kind==='profile'?command.nickname:null,affectedActivities:affected.length,notificationIds:command.kind==='notifications'?command.ids:[],ownedNotifications:new Set(notifications.map(n=>n.id)).size,unreadNotifications:new Set(notifications.filter(n=>n.read_at===null).map(n=>n.id)).size,code:code?{id:null,kind:code.input.kind,name:code.input.name,digest:imageDigest(code.raw),source:'source' in code.input?{eventId:code.input.source.event_id,version:code.input.source.version,kind:code.input.source.kind}:null}:archive?{id:archive.id,kind:archive.kind,name:archive.name,digest:archive.digest,source:null}:null};
  return {code,archive,view:{...value,recovery_token:hash(JSON.stringify({user,key:s.input.requestKey,signature:s.signature,profile,affected,attendees,notifications,library,archive,bot,value}))}};
 }
 app.post('/api/v2/me/legacy-requests/personal/inspect',options,async request=>db.transaction(()=>{const s=inspect(request,LegacyRequestCheck.parse(request.body));return s.old?committed(s):prepare(s).view;})());
 app.post('/api/v2/me/legacy-requests/personal/retry',options,async request=>db.transaction(()=>{
  const {confirm,recovery_token,...input}=LegacyPersonalRetry.parse(request.body);void confirm;const s=inspect(request,input);if(s.old)return committed(s);const p=prepare(s);
  if(p.view.recovery_token!==recovery_token)throw withApiError(new DomainError('LEGACY_PERSONAL_REVIEW_CHANGED','稱呼、消息或收款碼已變更；請重新核對',409));
  const time=now(),stamp=legacyStamp(time);let result:unknown,status=200;
  if(s.command.kind==='profile'){saveAccountNickname(db,s.user,s.command.nickname,()=>time,botEnabledDefault,(details,message)=>app.log.error(details,message));result={nickname:s.command.nickname,draft_scope:s.user.scope};}
  else if(s.command.kind==='notifications'){markNotificationsRead(db,s.user.id,s.command.ids,stamp);result={ok:true};}
  else if(p.code){const code=createPaymentCode(db,s.user,p.code,()=>time);result={...code,url:'/api/payment-codes/'+code.id+'/image'};status=201;}
  else if(p.archive){archivePaymentCode(db,p.archive,stamp);result={ok:true};}
  db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run(s.user.id,input.requestKey,s.signature,JSON.stringify(result),status,stamp);return committed(s);
 }).immediate());
}
