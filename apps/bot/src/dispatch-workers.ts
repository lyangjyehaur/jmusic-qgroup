import { Worker } from 'node:worker_threads';
import type { BotPolicyDefaults } from '@qgroup/domain';
import type { QQBotAPI } from './api';
import type { BotDispatchBusiness, BotDispatchReply } from './dispatch';
import type { DispatchConfig, DispatchFromWorker, DispatchToWorker, DispatchWork, DispatchWorkerInput } from './dispatch-types';
import { checkAbort } from './lifecycle';
import { AbbreviationSendBlocked } from './send-policy';
import { createBotObserver, safeError, type BotObserver } from './observability';
type Pending={signal:AbortSignal;work:DispatchWork;resolve:()=>void;reject:(error:Error)=>void;abort:()=>void;observer:BotObserver};
/** Two independent isolates: slow masks/network cannot occupy the public-query lane.
 * This library does not start a gateway, outbox consumer or production runtime.
 */
export class BotDispatchWorkers implements BotDispatchBusiness {
  readonly #workers:Worker[];readonly #pending=new Map<number,Pending>();readonly #counts=[0,0,0];
  readonly #observer:BotObserver;readonly #stop=new AbortController();#next=0;#closed=false;#failed=false;
  constructor(readonly config:DispatchConfig,readonly options:{api:Pick<QQBotAPI,'replyGroup'>;defaults?:BotPolicyDefaults;workerURL?:URL;observer?:BotObserver;maxPerLane?:number}){
    this.#observer=options.observer??createBotObserver();
    if(!Number.isSafeInteger(options.maxPerLane??32)||(options.maxPerLane??32)<1)throw Error('Invalid worker queue limit');
    this.#workers=[];
    try{for(const lane of ['public','abbreviation'] as const){
      // Pick at runtime too: a structurally compatible BotConfig may carry secrets.
      const isolated:DispatchConfig={database:config.database,group:config.group,dryRun:config.dryRun,markdownReplies:config.markdownReplies,allowedLinkHosts:[...config.allowedLinkHosts],baseURL:config.baseURL,sensitiveWordsFile:config.sensitiveWordsFile,abbreviationPageBytes:config.abbreviationPageBytes,logDirectory:config.logDirectory};
      const data:DispatchWorkerInput={qgroupDispatch:true,config:isolated,defaults:options.defaults??{},lane};
      const worker=new Worker(options.workerURL??new URL('./dispatch-task.mjs',import.meta.url),{workerData:data,env:{},execArgv:[],resourceLimits:{maxOldGenerationSizeMb:256}});
      this.#workers.push(worker);
      worker.on('message',(message:DispatchFromWorker)=>{void this.#message(worker,message);});
      worker.on('error',error=>this.#fail(error));
      worker.on('exit',code=>{if(!this.#closed)this.#fail(Error('Business worker exited: '+code));});
    }}catch(error){this.#fail(error);throw error;}
  }
  #send(worker:Worker,message:DispatchToWorker){worker.postMessage(message);}
  #fail(error:unknown){
    if(this.#failed||this.#closed)return;this.#failed=true;this.#observer.event('business_worker_unavailable',safeError(error));
    this.#stop.abort();
    for(const [id,pending] of this.#pending){pending.reject(Error('Business worker unavailable'));this.#release(id);}
    for(const worker of this.#workers)void worker.terminate();
  }
  async #message(worker:Worker,message:DispatchFromWorker) {
    const pending=this.#pending.get(message.id);
    if(message.type==='log'){if(pending){const {event,ts:_stamp,...fields}=message.row;pending.observer.event(typeof event==='string'&&/^[a-z_]{1,80}$/.test(event)?event:'business_diagnostic',fields);}return;}
    if(message.type==='done'){if(pending){if(message.failed)pending.reject(Error('Business work failed'));else pending.resolve();this.#release(message.id);}return;}
    if(message.type!=='send')return;
    try{
      if(!pending||this.#closed||this.#failed)throw Error('Expired reply');checkAbort(pending.signal);
      const work=pending.work;
      if(work.kind!=='reply'||work.request.group!==message.group||work.request.msgId!==message.options.msgId||work.request.eventId!==message.options.eventId||!Number.isSafeInteger(message.options.seq)||message.options.seq!<1||message.options.seq!>5)throw Error('Invalid reply request');
      // Main-thread cancellation gates every actual request, even if worker CPU
      // or a SQLite lock delays processing its cancellation message.
      const result=await this.options.api.replyGroup(message.group,message.text,{...message.options,signal:pending.signal,beforeSend:async()=>{
        try{await this.#work({kind:'authorize',group:message.group},pending.signal);}
        catch{throw new AbbreviationSendBlocked();}
      }});
      if(!this.#closed&&!this.#failed)this.#send(worker,{type:'send-result',id:message.id,call:message.call,result});
    }catch(error){
      if(!this.#closed&&!this.#failed)this.#send(worker,{type:'send-result',id:message.id,call:message.call,failed:true,...(error instanceof AbbreviationSendBlocked?{blocked:true as const}:{})});
    }
  }
  #release(id:number){
    const pending=this.#pending.get(id);if(!pending)return;
    pending.signal.removeEventListener('abort',pending.abort);this.#pending.delete(id);
    const lane=this.#lane(pending.work);this.#counts[lane]!--;
  }
  #lane(work:DispatchWork){return work.kind==='authorize'?2:work.kind==='reply'&&work.request.command==='缩写'?1:0;}
  async #work(work:DispatchWork,parent:AbortSignal):Promise<void> {
    const signal=AbortSignal.any([parent,this.#stop.signal]);checkAbort(signal);if(this.#closed||this.#failed)return Promise.reject(Error('Business workers unavailable'));
    const lane=this.#lane(work);
    if(this.#counts[lane]!>=(this.options.maxPerLane??32)*(lane===2?2:1))return Promise.reject(Error('Business worker queue full'));
    const id=++this.#next,worker=this.#workers[lane===2?0:lane]!;this.#counts[lane]!++;
    // Capture caller trace before crossing the thread boundary.
    const trace=this.#observer.traceId(),observer:BotObserver={...this.#observer,event:(name,fields)=>this.#observer.scope({trace_id:trace},()=>this.#observer.event(name,fields))};
    return new Promise<void>((resolve,reject)=>{
      const abort=()=>{try{this.#send(worker,{type:'cancel',id});}finally{reject(signal.reason instanceof Error?signal.reason:new DOMException('Operation aborted','AbortError'));}};
      this.#pending.set(id,{signal,work,resolve,reject,abort,observer});signal.addEventListener('abort',abort,{once:true});
      try{this.#send(worker,{type:'work',id,work});if(signal.aborted)abort();}catch(error){reject(error);this.#release(id);}
    });
  }
  observe(group:string,event:string,reason:string|undefined,signal:AbortSignal){return this.#work({kind:'observe',group,event,reason},signal);}
  reply(request:BotDispatchReply,signal:AbortSignal){return this.#work({kind:'reply',request},signal);}
  async close(){
    if(this.#closed)return;this.#closed=true;this.#stop.abort();
    for(const [id,pending] of this.#pending){pending.reject(new DOMException('Workers closed','AbortError'));this.#release(id);}
    await Promise.all(this.#workers.map(worker=>worker.terminate()));
  }
}
