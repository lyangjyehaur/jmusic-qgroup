import { withApiError } from './error-display';
import type { FastifyInstance } from 'fastify';
import type { DB } from '@qgroup/database';
import { LegacyRequestCheck } from '@qgroup/contracts';
import { DomainError } from '@qgroup/domain';
import { hash,type Security } from './security';
import { requireActivityAccess } from './activity-access';
import { pollRow } from './time-poll-context';

/** Python json.dumps(sort_keys=True, ensure_ascii=False) for original JSON wire values.
 * No new signature is written and a mismatch cannot replay any operation. */
export function originalJSON(value:unknown):string{
  if(value===null||typeof value==='boolean')return String(value);
  if(typeof value==='string')return JSON.stringify(value);
  if(typeof value==='number'){
    if(!Number.isFinite(value))throw Error('Non-JSON number');
    const wire=JSON.stringify(value);
    // Python loads JS integer wire tokens as int, even above the safe integer range.
    if(!/[.e]/i.test(wire))return wire;
    const n=Math.abs(value);
    if(n!==0&&(n<1e-4||n>=1e16))return value.toExponential().replace(/e([+-])(\d+)$/,(_,sign:string,digits:string)=>'e'+sign+digits.padStart(2,'0'));
    return wire;
  }
  if(Array.isArray(value))return '['+value.map(originalJSON).join(', ')+']';
  if(typeof value==='object'&&value&&Object.getPrototypeOf(value)===Object.prototype){
    const compare=(a:string,b:string)=>{const aa=Array.from(a,c=>c.codePointAt(0)!),bb=Array.from(b,c=>c.codePointAt(0)!);for(let i=0;i<Math.min(aa.length,bb.length);i++)if(aa[i]!==bb[i])return aa[i]!-bb[i]!;return aa.length-bb.length;};
    return '{'+Object.keys(value).sort(compare).map(key=>originalJSON(key)+': '+originalJSON((value as Record<string,unknown>)[key])).join(', ')+'}';
  }
  throw Error('Unsupported original JSON');
}
export const originalRequestSignature=(method:string,path:string,data:unknown)=>hash(method+' '+path+' '+originalJSON(data));
export function registerLegacyLocal(app:FastifyInstance,db:DB,security:Security){
  // POST carries potentially private original input; this route only reads and has no write/backup hook.
  app.post('/api/v2/me/legacy-requests/check',{bodyLimit:16*1024*1024,config:{rateLimit:{max:30,timeWindow:'1 minute'}}},async request=>db.transaction(()=>{
    const user=security.memberWrite(request),input=LegacyRequestCheck.parse(request.body);
    const row=db.prepare('SELECT signature,response_json FROM request_results WHERE user_id=? AND request_key=?').get(user.id,input.requestKey) as {signature:string;response_json:string}|undefined;
    if(!row)return {committed:false};
    if(row.signature!==originalRequestSignature(input.method,input.path,input.data))throw withApiError(new DomainError('LEGACY_REQUEST_CONFLICT','原操作編號與內容不符，請保留原紀錄；不能改用新版操作重送',409));
    // Never return frozen owner/private fields. Resolve only a currently accessible destination.
    const result:unknown=JSON.parse(row.response_json);
    if(result&&typeof result==='object'&&'id' in result&&typeof result.id==='string'){
      if('starts_at' in result){requireActivityAccess(db,result.id,user.id);return {committed:true,target:{kind:'activity',id:result.id}};}
      if('time_poll' in result){pollRow(db,result.id);return {committed:true,target:{kind:'poll',id:result.id}};}
    }
    return {committed:true};
  })());
}
