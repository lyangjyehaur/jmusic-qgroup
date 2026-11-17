import { performance } from 'node:perf_hooks';
import { botLength, botStrip, musicWhitespace } from '@qgroup/domain';
import { AbbreviationText, maskAbbreviationText } from './abbreviation-text';
import { BotMaskLoader, type BotWordMask } from './word-mask';
import { within, checkAbort } from './lifecycle';
import { object } from './protocol';
import { createBotObserver, safeError, type BotObserver } from './observability';
export const ABBREVIATION_API='https://lab.magiconch.com/api/nbnhhsh/guess';
export const ABBREVIATION_USAGE='用法：/缩写 yyds，也可用 /縮寫 或 /nbnhhsh。\n可用空格或逗号分隔，最多 5 个缩写；每个为 2–32 位英文字母或数字。\n也可引用消息后只 @机器人，或 /缩写 一段话，只提取其中的英文缩写。\n若未识别到缩写，请检查原文；QQ 未附引用内容时可复制文字查询。\n仅将缩写发送到第三方「能不能好好说话」查询，候选含义仅供参考。';
export const ABBREVIATION_UNAVAILABLE='缩写查询服务暂时不可用，请稍后再试。';
export function abbreviationTerms(argument:unknown):string[]|null {
  const text=botStrip(String(argument||'')).toLowerCase();if(!text||botLength(text)>164)return null;
  const terms=[...new Set(text.replace(musicWhitespace,',').split(/[,，、]+/))];
  return terms.length>=1&&terms.length<=5&&terms.every(term=>/^[a-z0-9]{2,32}$/.test(term))?terms:null;
}
const truthy=(value:unknown)=>!!value&&(!Array.isArray(value)||!!value.length)&&(!object(value)||!!Object.keys(value).length);
function definitions(values:unknown){
  if(!Array.isArray(values))throw Error('Invalid translation list');const result:string[]=[];
  for(const value of values){if(typeof value!=='string')throw Error('Invalid translation');const text=botStrip(value.replace(/[\x00-\x1f\x7f]+/g,' '));
    if(!text||/[@＠]/.test(text)||/<[\s\u001c-\u001f\u0085]*\/?[\s\u001c-\u001f\u0085]*qqbot-at-|https?:\/\/|www\./i.test(text))continue;result.push(text);}
  return result;
}
export function renderAbbreviations(data:unknown,terms:readonly string[],mask:BotWordMask):AbbreviationText {
  if(!Array.isArray(data))throw Error('Invalid abbreviation response');const entries=new Map<string,Record<string,unknown>>();
  for(const item of data){if(!object(item)||typeof item.name!=='string')throw Error('Invalid abbreviation entry');const name=item.name.toLowerCase();if(terms.includes(name))entries.set(name,item);}
  const sections=['【缩写查询】可能含义：\n'];
  for(const term of terms){const item=entries.get(term)??{};let values:string[]=[],label='';
    if(item.trans!==null&&item.trans!==undefined)values=definitions(item.trans);
    else if(!Object.hasOwn(item,'trans')&&truthy(item.inputting)){values=definitions(item.inputting);label='（待确认候选）';}
    sections.push(term,label,'：',(values.length?values:['暂无可显示的释义']).join('、'),'\n');}
  sections.push('来源：能不能好好说话；含义依语境而定。');return maskAbbreviationText(new AbbreviationText(sections),mask);
}
export type AbbreviationRequest=(terms:string,signal:AbortSignal)=>Promise<Uint8Array>;
/** No QQ authorization, cookies, sender IDs or original sentence are sent. */
export async function fetchAbbreviations(terms:string,signal:AbortSignal):Promise<Uint8Array> {
  const response=await fetch(ABBREVIATION_API,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json','User-Agent':'qgroup-bot/nbnhhsh'},body:JSON.stringify({text:terms}),signal,redirect:'error',credentials:'omit'});
  if(!response.ok)throw Error('Abbreviation upstream rejected request');
  const reader=response.body?.getReader(),chunks:Uint8Array[]=[];
  if(reader)try{for(;;){checkAbort(signal);const {value,done}=await reader.read();if(done)break;chunks.push(value);}}finally{reader.releaseLock();}
  checkAbort(signal);return Buffer.concat(chunks);
}
export class AbbreviationLookup {
  readonly #request:AbbreviationRequest;readonly #mask:()=>BotWordMask;readonly #clock:()=>number;readonly #observer:BotObserver;
  readonly #budget:number;readonly #timeout:number;readonly #cache=new Map<string,{until:number;raw:Uint8Array}>();
  #bytes=0;#busy=false;#fetchBusy=false;#next=0;#closed=new AbortController();
  constructor(options:{request?:AbbreviationRequest;loadMask?:()=>BotWordMask;clock?:()=>number;cacheBytes?:number;timeoutMs?:number;observer?:BotObserver}={}){
    this.#request=options.request??fetchAbbreviations;const loader=new BotMaskLoader();this.#mask=options.loadMask??(()=>loader.load());
    this.#clock=options.clock??(()=>performance.now());this.#budget=options.cacheBytes??8*1024*1024;this.#timeout=options.timeoutMs??4000;this.#observer=options.observer??createBotObserver();
    if(!Number.isSafeInteger(this.#budget)||this.#budget<0||!Number.isFinite(this.#timeout)||this.#timeout<=0)throw Error('Invalid abbreviation lookup limits');
  }
  close(){this.#closed.abort();this.#cache.clear();this.#bytes=0;}
  cacheState(){return {bytes:this.#bytes,keys:[...this.#cache.keys()],busy:this.#busy,fetchBusy:this.#fetchBusy};}
  #render(raw:Uint8Array,terms:string[]){return renderAbbreviations(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)),terms,this.#mask());}
  async answer(argument:unknown,parent?:AbortSignal):Promise<string|AbbreviationText>{
    const signal=AbortSignal.any([this.#closed.signal,...(parent?[parent]:[])]);checkAbort(signal);
    const terms=abbreviationTerms(argument);if(!terms)return ABBREVIATION_USAGE;
    if(this.#busy)return '缩写查询忙碌中，请稍后再试。';this.#busy=true;
    try{
      const key=terms.join(','),current=this.#clock();
      for(const [k,cached] of this.#cache)if(cached.until<=current){this.#cache.delete(k);this.#bytes-=cached.raw.byteLength;}
      const cached=this.#cache.get(key);
      if(cached){this.#cache.delete(key);this.#cache.set(key,cached);try{return this.#render(cached.raw,terms);}catch(error){this.#observer.event('abbreviation_lookup_failed',safeError(error));return ABBREVIATION_UNAVAILABLE;}}
      if(current<this.#next)return '缩写查询过于频繁，请稍后再试。';this.#next=current+1000;
      try{
        if(this.#fetchBusy)throw Error('Previous abbreviation fetch still closing');
        const raw=await within(this.#timeout,signal,async child=>{
          checkAbort(child);this.#fetchBusy=true;
          try{return await this.#request(key,child);}finally{this.#fetchBusy=false;}
        });
        checkAbort(signal);const text=this.#render(raw,terms);
        if(raw.byteLength<=this.#budget){const copy=Uint8Array.from(raw);this.#cache.set(key,{until:this.#clock()+3600000,raw:copy});this.#bytes+=copy.byteLength;
          while(this.#cache.size>256||this.#bytes>this.#budget){const oldest=this.#cache.entries().next().value!;this.#cache.delete(oldest[0]);this.#bytes-=oldest[1].raw.byteLength;}}
        return text;
      }catch(error){checkAbort(signal);this.#next=this.#clock()+10000;this.#observer.event('abbreviation_lookup_failed',safeError(error));return ABBREVIATION_UNAVAILABLE;}
    }finally{this.#busy=false;}
  }
}
