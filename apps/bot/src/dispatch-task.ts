import { parentPort, workerData } from 'node:worker_threads';
import type { QQBotAPI, BotAPIResult } from './api';
import { BotDispatchService } from './dispatch-business';
import type { DispatchToWorker, DispatchFromWorker, DispatchWorkerInput } from './dispatch-types';
import { abortable, checkAbort } from './lifecycle';
import { AbbreviationSendBlocked } from './send-policy';
import { createBotObserver, safeError } from './observability';
/** Explicit Worker entry only. Importing in the main thread is inert. */
if(parentPort&&(workerData as Partial<DispatchWorkerInput>|undefined)?.qgroupDispatch===true){
  const port=parentPort,input=workerData as DispatchWorkerInput;
  const controllers=new Map<number,AbortController>(),calls=new Map<number,{id:number;resolve:(value:BotAPIResult)=>void;reject:(blocked?:boolean)=>void}>();
  let nextCall=0;
  const send=(message:DispatchFromWorker)=>port.postMessage(message);
  const observer=createBotObserver(row=>send({type:'log',id:typeof row.task_id==='number'?row.task_id:0,row}));
  const service=new BotDispatchService(input.config,input.defaults,{observer});
  port.on('message',(message:DispatchToWorker)=>{
    if(message.type==='cancel'){controllers.get(message.id)?.abort();return;}
    if(message.type==='send-result'){
      const call=calls.get(message.call);if(!call||call.id!==message.id)return;
      calls.delete(message.call);if(message.failed||!message.result)call.reject(message.blocked);else call.resolve(message.result);return;
    }
    const controller=new AbortController(),id=message.id;controllers.set(id,controller);
    const signal=controller.signal;
    const api:Pick<QQBotAPI,'replyGroup'>={replyGroup:async(group,text,options={})=>{
      checkAbort(signal);const call=++nextCall;
      const result=new Promise<BotAPIResult>((resolve,reject)=>calls.set(call,{id,resolve,reject:(blocked)=>reject(blocked?new AbbreviationSendBlocked():Error('Platform request unavailable'))}));
      send({type:'send',id,call,group,text,options:{msgId:options.msgId,eventId:options.eventId,seq:options.seq,markdown:options.markdown}});
      try{return await abortable(result,signal);}finally{calls.delete(call);}
    }};
    void observer.scope({task_id:id},async()=>{
      try {
        if(message.work.kind==='reply'&&((message.work.request.command==='缩写')!==(input.lane==='abbreviation')))throw Error('Invalid business lane');
        await service.execute(message.work,api,signal);send({type:'done',id});
      }catch(error){observer.event('business_task_failed',safeError(error));send({type:'done',id,failed:true});}
      finally{controller.abort();controllers.delete(id);}
    });
  });
  port.on('close',()=>{for(const controller of controllers.values())controller.abort();service.close();});
}
