import { Worker } from 'node:worker_threads';
import type { BotPolicyDefaults } from '@qgroup/domain';
import type { ActivityBotDefaults } from '../../api/src/activity-bot';
import type { QQBotAPI } from './api';
import { abortable, checkAbort } from './lifecycle';
import { createBotObserver, safeError, type BotObserver } from './observability';
import { OutboxSendSuppressed } from './outbox';
import type { MaintenanceConfig, MaintenanceFromWorker, MaintenanceInput, MaintenanceToWorker, MaintenanceWork, RuntimePolicy, StartupRefusalReason } from './maintenance-types';
export class BotMaintenanceError extends Error {constructor(readonly busy=false,readonly reason?:StartupRefusalReason){super('Bot maintenance work failed');}}
type Pending={signal:AbortSignal;resolve:(value:unknown)=>void;reject:(error:Error)=>void;abort:()=>void};
/** One isolated outbox/policy/health owner. No work starts until init is explicit. */
export class BotMaintenance {
  readonly #worker:Worker;readonly #observer:BotObserver;readonly #pending=new Map<number,Pending>();readonly #stop=new AbortController();
  #next=0;#closed=false;#failed=false;#closing=false;readonly #exited:Promise<number>;#didClose!:()=>void;readonly #drained=new Promise<void>(resolve=>{this.#didClose=resolve;});
  constructor(config:MaintenanceConfig,readonly options:{api:Pick<QQBotAPI,'post'>;observer?:BotObserver;defaults?:BotPolicyDefaults;composition?:ActivityBotDefaults;workerURL?:URL;onFailure?:(error:Error)=>void}){
    this.#observer=options.observer??createBotObserver();
    const isolated:MaintenanceConfig={database:config.database,group:config.group,dryRun:config.dryRun,markdownReplies:config.markdownReplies,allowedLinkHosts:[...config.allowedLinkHosts],baseURL:config.baseURL,pollInterval:config.pollInterval,maxAttempts:config.maxAttempts,batch:config.batch,claimTimeout:config.claimTimeout,logDirectory:config.logDirectory,logContent:config.logContent,logContentLimit:config.logContentLimit};
    const data:MaintenanceInput={qgroupMaintenance:true,config:isolated,defaults:options.defaults??{},composition:options.composition??{baseURL:config.baseURL}};
    this.#worker=new Worker(options.workerURL??new URL('./maintenance-task.mjs',import.meta.url),{workerData:data,env:{},execArgv:[],resourceLimits:{maxOldGenerationSizeMb:256}});
    this.#worker.on('message',(message:MaintenanceFromWorker)=>{void this.#message(message);});
    this.#worker.on('error',error=>this.#fail(error));
    this.#exited=new Promise(resolve=>this.#worker.on('exit',code=>{resolve(code);if(!this.#closing)this.#fail(Error('Maintenance worker exited'));}));
  }
  #send(message:MaintenanceToWorker){this.#worker.postMessage(message);}
  #fail(error:unknown){
    if(this.#failed||this.#closed)return;this.#failed=true;this.#observer.event('maintenance_worker_unavailable',safeError(error));this.#stop.abort();
    for(const [id,pending] of this.#pending){pending.reject(new BotMaintenanceError());this.#release(id);}
    try{this.options.onFailure?.(new BotMaintenanceError());}catch{/* Callbacks cannot escape Worker events. */}finally{void this.#worker.terminate();}
  }
  #release(id:number){const pending=this.#pending.get(id);if(!pending)return;pending.signal.removeEventListener('abort',pending.abort);this.#pending.delete(id);}
  async #message(message:MaintenanceFromWorker){
    if(message.type==='closed'){this.#didClose();return;}
    if(message.type==='log'){const {event,ts:_stamp,...fields}=message.row;this.#observer.event(typeof event==='string'&&/^[a-z_]{1,80}$/.test(event)?event:'maintenance_diagnostic',fields);return;}
    const pending=this.#pending.get(message.id);
    if(message.type==='done'){
      if(pending){if(message.suppressed)pending.reject(new OutboxSendSuppressed(message.suppressed));else if(message.failed)pending.reject(new BotMaintenanceError(message.busy,message.reason));else pending.resolve(message.value);this.#release(message.id);}return;
    }
    try{
      if(!pending||this.#closing||this.#failed)throw Error('Expired outbox request');checkAbort(pending.signal);
      const result=await this.options.api.post(message.path,message.body,pending.signal,async()=>{
        await this.#work({kind:'guard',call:message.call},pending.signal);checkAbort(pending.signal);
      });
      if(!this.#closed&&!this.#failed)this.#send({type:'send-result',call:message.call,result});
    }catch(error){if(!this.#closed&&!this.#failed)this.#send({type:'send-result',call:message.call,failed:true,...(error instanceof OutboxSendSuppressed?{suppressed:error.result}:{})});}
  }
  async #work(work:MaintenanceWork,parent:AbortSignal):Promise<unknown>{
    const signal=AbortSignal.any([parent,this.#stop.signal]);checkAbort(signal);
    if(this.#closing||this.#failed)throw new BotMaintenanceError();if(this.#pending.size>=32)throw Error('Maintenance queue full');
    const id=++this.#next;
    return new Promise((resolve,reject)=>{
      const abort=()=>{try{this.#send({type:'cancel',id});}finally{reject(new DOMException('Maintenance cancelled','AbortError'));}};
      this.#pending.set(id,{signal,resolve,reject,abort});signal.addEventListener('abort',abort,{once:true});
      try{this.#send({type:'work',id,work});if(signal.aborted)abort();}catch(error){reject(error);this.#release(id);}
    });
  }
  async init(signal:AbortSignal){return await this.#work({kind:'init'},signal) as RuntimePolicy;}
  async policy(signal:AbortSignal){return await this.#work({kind:'policy'},signal) as RuntimePolicy;}
  async poll(signal:AbortSignal){return await this.#work({kind:'poll'},signal);}
  async panelsGuard(signal:AbortSignal){await this.#work({kind:'panels-guard'},signal);}
  async health(work:Extract<MaintenanceWork,{kind:'health'}>,signal:AbortSignal){await this.#work(work,signal);}
  async close(timeoutMs=10000){
    if(this.#closed)return true;this.#closing=true;this.#stop.abort();
    let graceful=false;
    try{
      if(!this.#failed){this.#send({type:'close'});await abortable(this.#drained,AbortSignal.timeout(timeoutMs));graceful=true;}
    }catch{this.#observer.event('maintenance_forced_stop');}
    finally{
      this.#closed=true;await this.#worker.terminate();await this.#exited;
      for(const [id,pending] of this.#pending){pending.reject(new BotMaintenanceError());this.#release(id);}
    }
    return graceful;
  }
}
