import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { assertDatabaseUsable, markBotPolicyApplied, readBotPolicy, recordBotDeployment, REBUILD_SCHEMA_VERSION } from '@qgroup/database';
import { botDryRun } from '@qgroup/domain';
import { BotOutboxWorker, OutboxSendSuppressed, type DeliveryResult } from './outbox';
import { loadBotConfig } from './config';
import type { BotAPIResult } from './api';
import { abortable, checkAbort } from './lifecycle';
import { createBotObserver, safeError, writeBotHealth } from './observability';
import { object } from './protocol';
import type { MaintenanceFromWorker, MaintenanceInput, MaintenanceToWorker, RuntimePolicy, StartupRefusalReason } from './maintenance-types';
class StartupRefusal extends Error {constructor(readonly reason:StartupRefusalReason){super('Native bot startup refused');}}
/** Main-thread imports are inert. Only the explicit worker marker opens a DB. */
if(parentPort&&(workerData as Partial<MaintenanceInput>|undefined)?.qgroupMaintenance===true){
  const port=parentPort,input=workerData as MaintenanceInput,config={...loadBotConfig({}),...input.config};
  let db:Database.Database|undefined,consumer:BotOutboxWorker|undefined,closing=false,nextCall=0,policy:RuntimePolicy|undefined,lastPoll:number|null=null;
  let polling:{id:number;signal:AbortSignal}|undefined;
  const controllers=new Map<number,AbortController>(),tasks=new Set<Promise<void>>();
  const calls=new Map<number,{id:number;guard:()=>void;resolve:(value:BotAPIResult)=>void;reject:(suppressed?:DeliveryResult)=>void}>();
  const send=(message:MaintenanceFromWorker)=>port.postMessage(message);
  const observer=createBotObserver(row=>send({type:'log',row}));
  const database=()=>{if(!db)throw Error('Maintenance not initialized');assertDatabaseUsable(db);return db;};
  const refresh=()=>{
    const connection=database();return connection.transaction(()=>{
      const settings=readBotPolicy(connection,input.defaults);markBotPolicyApplied(connection,settings.revision,new Date().toISOString());
      return policy={revision:settings.revision,dryRun:botDryRun(settings.config,config.dryRun),group:config.group};
    })();
  };
  port.on('message',(message:MaintenanceToWorker)=>{
    if(message.type==='cancel'){controllers.get(message.id)?.abort();return;}
    if(message.type==='send-result'){
      const call=calls.get(message.call);if(!call)return;calls.delete(message.call);
      if(message.failed||!message.result)call.reject(message.suppressed);else call.resolve(message.result);return;
    }
    if(message.type==='close'){
      closing=true;for(const controller of controllers.values())controller.abort();
      void Promise.allSettled([...tasks]).then(()=>{db?.close();db=undefined;send({type:'closed'});port.close();});return;
    }
    if(closing){send({type:'done',id:message.id,failed:true});return;}
    const id=message.id,controller=new AbortController();controllers.set(id,controller);const signal=controller.signal;
    const task=observer.scope({task_id:id},async()=>{
      try{
        checkAbort(signal);let value:unknown;
        switch(message.work.kind){
          case 'init':{
            if(db)throw Error('Maintenance already initialized');
            db=new Database(config.database,{fileMustExist:true});db.pragma('busy_timeout=5000');db.pragma('foreign_keys=ON');
            assertDatabaseUsable(db);
            const version=db.prepare('SELECT version FROM rebuild_schema').get() as {version:number}|undefined;
            if(version?.version!==REBUILD_SCHEMA_VERSION)throw new StartupRefusal('unsupported_schema');
            db.transaction(()=>{
              assertDatabaseUsable(db!);
              if(db!.prepare("SELECT 1 FROM bot_outbox WHERE status='sending' LIMIT 1").get())throw new StartupRefusal('unreviewed_sending');
              recordBotDeployment(db!,config.group);
            }).immediate();
            consumer=new BotOutboxWorker(db!,config,{post:async(path,body,callSignal,beforeSend)=>{
              checkAbort(callSignal);const current=polling;if(!current)throw Error('No active outbox poll');const call=++nextCall;
              const pending=new Promise<BotAPIResult>((resolve,reject)=>calls.set(call,{id:current.id,guard:()=>{checkAbort(current.signal);checkAbort(callSignal);beforeSend?.();},resolve,reject:suppressed=>reject(suppressed?new OutboxSendSuppressed(suppressed):Error('Platform request unavailable'))}));
              send({type:'send',id:current.id,call,path,body});
              try{return await abortable(pending,callSignal);}finally{calls.delete(call);}
            }},{observer,policyDefaults:input.defaults,composition:input.composition});
            value=refresh();break;
          }
          case 'policy':value=refresh();break;
          case 'panels-guard':if(refresh().dryRun)throw Error('Panels suppressed by current policy');break;
          case 'guard':{const call=calls.get(message.work.call);if(!call)throw Error('Expired outbox request');call.guard();break;}
          case 'poll':if(!consumer||polling)throw Error('Maintenance poll unavailable');polling={id,signal};try{value=await consumer.pollOnce(signal);lastPoll=Date.now()/1000;}finally{polling=undefined;}break;
          case 'health':{
            const state=message.work;
            writeBotHealth(config.logDirectory,{dry_run:policy?.dryRun??config.dryRun,deployment_dry_run:config.dryRun,policy_resolved:!!policy,policy_revision:policy?.revision,
              last_ack:state.gateway.last_ack,last_ready:state.gateway.last_ready,last_poll:lastPoll,reconnects:state.gateway.reconnects,gateway_connected:state.gateway.connected,runtime_state:state.state},observer);break;
          }
        }
        send({type:'done',id,value});
      }catch(error){
        if(error instanceof OutboxSendSuppressed){send({type:'done',id,failed:true,suppressed:error.result});return;}
        const reason=error instanceof StartupRefusal?error.reason:error instanceof Error&&error.message.startsWith('Recovery candidate')?'recovery_review' as const:undefined;
        observer.event('maintenance_failed',{...safeError(error),reason});
        send({type:'done',id,failed:true,reason,busy:object(error)&&typeof error.code==='string'&&['SQLITE_BUSY','SQLITE_BUSY_SNAPSHOT','SQLITE_LOCKED'].includes(error.code)});
      }finally{controller.abort();controllers.delete(id);}
    });
    tasks.add(task);void task.finally(()=>tasks.delete(task));
  });
}
