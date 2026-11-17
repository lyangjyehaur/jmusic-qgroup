import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { botStrip } from '@qgroup/domain';
import { abbreviationContinuation, abbreviationContinuationPrefix } from './abbreviation-input';
import { AbbreviationText, maskAbbreviationText } from './abbreviation-text';
import { BotMaskLoader, type BotWordMask } from './word-mask';
import { createBotObserver, safeError, type BotObserver } from './observability';
import { abortable, checkAbort } from './lifecycle';
import { object } from './protocol';
import type { BotAPIResult, QQBotAPI } from './api';
export const ABBREVIATION_TTL=3600;
export interface AbbreviationPage { text:string|AbbreviationText; token?:string }
type Metadata={group:string;created:number;offset:number;budget:number;uncertain:boolean;body?:string;section_ends?:unknown};
export type AbbreviationDeliveryResult=Pick<BotAPIResult,'ok'|'code'|'data'>;
class CursorSaveError extends Error {}
export { AbbreviationSendBlocked } from './send-policy';
import { AbbreviationSendBlocked } from './send-policy';
const unavailable='续读结果不存在、已过期或不属于本群，请重新查询缩写。';
const locks=new Map<string,{tail:Promise<void>;count:number}>();
const hash=(group:string)=>createHash('sha256').update(group).digest('hex');
/** Full masked results, compatible byte cursors and bounded QQ passive windows. */
export class AbbreviationDelivery {
  readonly root:string;readonly pageBytes:number;readonly #mask:()=>BotWordMask;readonly #clock:()=>number;readonly #token:()=>string;readonly #observer:BotObserver;
  constructor(root:string,options:{pageBytes?:number;loadMask?:()=>BotWordMask;clock?:()=>number;token?:()=>string;observer?:BotObserver}={}){
    this.root=resolve(root);this.pageBytes=Math.max(4,options.pageBytes??2000);const loader=new BotMaskLoader();this.#mask=options.loadMask??(()=>loader.load());this.#clock=options.clock??(()=>Date.now()/1000);this.#token=options.token??(()=>randomBytes(12).toString('hex'));this.#observer=options.observer??createBotObserver();
    if(!Number.isSafeInteger(this.pageBytes))throw Error('Invalid abbreviation page budget');
  }
  async #exclusive<T>(work:()=>Promise<T>|T,signal?:AbortSignal):Promise<T>{
    checkAbort(signal);let state=locks.get(this.root);if(!state){state={tail:Promise.resolve(),count:0};locks.set(this.root,state);}if(state.count>=16)throw Error('Abbreviation delivery busy');
    const previous=state.tail;let release!:()=>void;state.tail=new Promise<void>(resolve=>{release=resolve;});state.count++;
    const pending=(async()=>{await previous;try{checkAbort(signal);return await work();}finally{release();state!.count--;if(!state!.count)locks.delete(this.root);}})();
    return abortable(pending,signal);
  }
  #paths(token:string){if(!/^[0-9a-f]{24}$/.test(token))throw Error('Invalid continuation');return [join(this.root,token+'.json'),join(this.root,token+'.txt')] as const;}
  #root(){mkdirSync(this.root,{recursive:true,mode:0o700});const stat=lstatSync(this.root);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Invalid continuation directory');chmodSync(this.root,0o700);}
  #readFile(path:string){
    const root=lstatSync(this.root);if(!root.isDirectory()||root.isSymbolicLink())throw Error('Invalid continuation directory');
    const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||(stat.mode&0o077))throw Error('Invalid continuation file');return readFileSync(fd);}finally{closeSync(fd);}
  }
  #write(path:string,data:Uint8Array){
    this.#root();if(existsSync(path)){const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw Error('Invalid continuation file');}
    const temporary=path+'.'+randomBytes(6).toString('hex')+'.tmp';
    try{const fd=openSync(temporary,'wx',0o600);try{writeFileSync(fd,data);fsyncSync(fd);}finally{closeSync(fd);}renameSync(temporary,path);}finally{if(existsSync(temporary))unlinkSync(temporary);}
  }
  #save(token:string,meta:Metadata){this.#write(this.#paths(token)[0],Buffer.from(JSON.stringify(meta)));}
  #body(token:string,meta:Metadata){const name=meta.body??token+'.txt';if(!new RegExp('^'+token+'(?:\\.[0-9a-f]{12})?\\.txt$').test(name))throw Error('Invalid continuation body');return join(this.root,name);}
  #cleanup(){this.#root();for(const name of readdirSync(this.root))if(/^[0-9a-f]{24}(?:\.[0-9a-f]{12})?\.(?:json|txt)(?:\.[0-9a-f]{12}\.tmp)?$/.test(name)){
    const path=join(this.root,name),stat=lstatSync(path);if(stat.isSymbolicLink()||!stat.isFile()||stat.nlink!==1)throw Error('Invalid continuation file');if(this.#clock()-stat.mtimeMs/1000>ABBREVIATION_TTL)unlinkSync(path);}}
  #create(group:string,text:AbbreviationText){
    this.#cleanup();const token=this.#token(),paths=this.#paths(token);if(paths.some(existsSync))throw Error('Continuation collision');
    const meta:Metadata={group:hash(group),created:this.#clock(),offset:0,budget:this.pageBytes,uncertain:false,section_ends:text.sectionEnds()};this.#write(paths[1],Buffer.from(String(text)));this.#save(token,meta);return {token,meta};
  }
  #read(group:string,token:string){
    const value:unknown=JSON.parse(this.#readFile(this.#paths(token)[0]).toString('utf8'));
    if(!object(value)||value.group!==hash(group)||typeof value.created!=='number'||!Number.isFinite(value.created)||this.#clock()-value.created>ABBREVIATION_TTL||!Number.isSafeInteger(value.offset)||Number(value.offset)<0||!Number.isSafeInteger(value.budget)||Number(value.budget)<1||typeof value.uncertain!=='boolean'||(value.body!==undefined&&typeof value.body!=='string'))throw Error('Invalid continuation metadata');
    const meta=value as Metadata,body=this.#body(token,meta),raw=this.#readFile(body);if(meta.offset>raw.byteLength)throw Error('Invalid continuation offset');
    const text=AbbreviationText.remaining(raw.subarray(meta.offset),meta.offset,meta.section_ends),masked=maskAbbreviationText(text,this.#mask());
    if(String(masked)!==String(text)){
      const next=join(this.root,token+'.'+randomBytes(6).toString('hex')+'.txt');this.#write(next,Buffer.from(String(masked)));
      const updated={...meta,offset:0,body:next.slice(this.root.length+1),section_ends:masked.sectionEnds()};this.#save(token,updated);unlinkSync(body);return {meta:updated,text:masked};
    }
    return {meta,text:masked};
  }
  continuation(group:string,argument:unknown,signal?:AbortSignal):Promise<AbbreviationPage|null>{
    const text=botStrip(String(argument||''));if(!abbreviationContinuationPrefix.test(text))return Promise.resolve(null);
    const token=abbreviationContinuation.exec(text)?.[1];if(!token)return Promise.resolve({text:'请使用上一条回复提供的完整续读指令：/缩写 继续 编号。'});
    return this.#exclusive(()=>{try{return {text:this.#read(group,token).text,token};}catch{return {text:unavailable};}},signal);
  }
  async #call(api:Pick<QQBotAPI,'replyGroup'>,group:string,text:string,seq:number,options:{msgId?:string;eventId?:string;signal?:AbortSignal;beforeSend?:()=>void|Promise<void>}):Promise<AbbreviationDeliveryResult>{
    checkAbort(options.signal);await options.beforeSend?.();checkAbort(options.signal);
    try{return await abortable(api.replyGroup(group,text,{seq,msgId:options.msgId,eventId:options.eventId,signal:options.signal}),options.signal);}
    catch(error){if(error instanceof AbbreviationSendBlocked)throw error;this.#observer.event('abbreviation_send_unconfirmed',safeError(error));return {ok:false,code:null,data:{uncertain:true}};}
  }
  send(api:Pick<QQBotAPI,'replyGroup'>,group:string,page:AbbreviationPage,options:{msgId?:string;eventId?:string;signal?:AbortSignal;beforeSend?:()=>void|Promise<void>}={}):Promise<AbbreviationDeliveryResult>{
    return this.#exclusive(async()=>{
      try{return await this.#send(api,group,page,options);}
      catch(error){if(options.signal?.aborted||error instanceof AbbreviationSendBlocked)throw error;this.#observer.event('abbreviation_result_storage_failed',safeError(error));
        await this.#call(api,group,error instanceof CursorSaveError?'上一段已确认送出，但续读位置未能保存；请核对后继续，续读可能重复。':'暂时无法保存完整查询结果，请稍后重新查询。',5,options);return {ok:false,code:null,data:{storage_error:true}};}
    },options.signal);
  }
  async #send(api:Pick<QQBotAPI,'replyGroup'>,group:string,page:AbbreviationPage,options:{msgId?:string;eventId?:string;signal?:AbortSignal;beforeSend?:()=>void|Promise<void>}):Promise<AbbreviationDeliveryResult>{
    let token=page.token??'',text:AbbreviationText,meta:Metadata|undefined,seq=1;
    if(token){try{({meta,text}=this.#read(group,token));}catch{return this.#call(api,group,'续读结果已过期，请重新查询缩写。',seq,options);}}
    else text=maskAbbreviationText(page.text,this.#mask());
    let remaining=String(text);if(!remaining)return this.#call(api,group,'该查询结果已全部显示。',seq,options);
    let failure:AbbreviationDeliveryResult|null=null;
    if(!token){const result=await this.#call(api,group,remaining,seq,options);if(result.ok)return result;seq++;failure=result;
      const created=this.#create(group,text);token=created.token;meta=created.meta;}
    let budget=meta!.budget;
    if(failure&&failure.code===40054007){budget=Math.min(budget,Math.max(1,Math.floor(Buffer.byteLength(remaining)/2)));failure=null;}
    if(failure)meta!.uncertain=failure.code===null||failure.code===0;
    while(remaining&&seq<=4&&!failure&&options.msgId){
      checkAbort(options.signal);
      // A byte budget may split a Unicode scalar. Decode a valid prefix only.
      let valid='';const bytes=Buffer.from(remaining);for(let size=Math.min(budget,bytes.length);size>0;size--)try{valid=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes.subarray(0,size));break;}catch{/* Find last complete scalar. */}
      const part=valid||Array.from(remaining)[0]!;
      // Persist the pre-send cursor as uncertain before starting another request.
      // A failed acknowledged-cursor write must not look safe to replay.
      meta!.uncertain=true;this.#save(token,meta!);
      const result=await this.#call(api,group,part,seq,options);seq++;
      if(result.ok){const updated={...meta!,offset:meta!.offset+Buffer.byteLength(part),uncertain:false};try{this.#save(token,updated);}catch{throw new CursorSaveError();}meta=updated;remaining=remaining.slice(part.length);}
      else if(result.code===40054007&&Array.from(part).length>1)budget=Math.max(1,Math.floor(budget/2));
      else{failure=result;meta!.uncertain=result.code===null||result.code===0;}
    }
    meta!.budget=budget;this.#save(token,meta!);
    if(!remaining){unlinkSync(this.#body(token,meta!));for(const path of this.#paths(token))if(existsSync(path))unlinkSync(path);return {ok:true,code:0,data:{}};}
    const prefix=meta!.uncertain?'上一段发送结果未确认，未自动重发；续读可能重复该段。\n':failure?'部分内容发送失败，未跳过该段。\n':'';
    const notice=prefix+'首次查询后1小时内，请 @机器人 续读：\n/缩写 继续 '+token;
    // Cancellation after an in-flight call retains an uncertain cursor and does
    // not start a second send, including the failure/continuation notice.
    if(options.signal?.aborted)return failure??{ok:false,code:null,data:{uncertain:true}};
    const result=await this.#call(api,group,notice,seq,options);this.#observer.event('abbreviation_result_pending',{remaining_bytes:Buffer.byteLength(remaining),uncertain:meta!.uncertain,notice_sent:result.ok});return failure??result;
  }
}
