import type { BotPolicyDefaults } from '@qgroup/domain';
import type { ActivityBotDefaults } from '../../api/src/activity-bot';
import { QQBotAPI, fetchBotJSON, type BotRequest } from './api';
import { validateBotConfig, type BotConfig } from './config';
import { BotDispatcher } from './dispatch';
import { BotDispatchWorkers } from './dispatch-workers';
import { QQGateway, type GatewayOptions, type GatewayState } from './gateway';
import { BotMaintenance, BotMaintenanceError } from './maintenance';
import { checkAbort, delay, within } from './lifecycle';
import { persistentBotObserver, safeError, writeBotHealth, type BotObserver } from './observability';
import { BotOwnership } from './ownership';
import { BOT_COMMANDS } from './commands';
import type { RuntimePolicy, RuntimeState } from './maintenance-types';
export interface BotRuntimeOptions {
  observer?:BotObserver;defaults?:BotPolicyDefaults;composition?:ActivityBotDefaults;
  request?:BotRequest;tokenHosts?:readonly string[];dispatchWorkerURL?:URL;maintenanceWorkerURL?:URL;
  gateway?:Pick<GatewayOptions,'socket'|'allowLoopback'|'connectTimeoutMs'>;
  startupTimeoutMs?:number;shutdownTimeoutMs?:number;
}
/** Explicit native runtime. Nothing starts on import; never migrates a database.
 * The ownership lock is held until workers and their platform requests stop.
 */
export async function runBot(config:BotConfig,parent:AbortSignal,options:BotRuntimeOptions={}){
  checkAbort(parent);
  if(validateBotConfig(config).length)throw Error('Invalid bot configuration');
  const shutdownMs=options.shutdownTimeoutMs??10000,startupMs=options.startupTimeoutMs??10000;
  if(![shutdownMs,startupMs].every(value=>Number.isSafeInteger(value)&&value>=1&&value<=60000))throw Error('Invalid runtime lifetime limits');
  const owner=new BotOwnership(config.database),stop=new AbortController(),signal=AbortSignal.any([parent,stop.signal]);
  const sink=options.observer??persistentBotObserver(config);
  const observer:BotObserver={...sink,event:(name,fields)=>{
    if(config.appSecret&&typeof fields?.text_preview==='string'){
      let preview=fields.text_preview.split(config.appSecret).join('[redacted]');
      // A credential may cross the child worker's preview cutoff. It cannot
      // redact it locally because workers deliberately never receive secrets.
      if(fields.text_truncated)for(let length=Math.min(config.appSecret.length-1,preview.length);length>0;length--){
        if(preview.endsWith(config.appSecret.slice(0,length))){preview=preview.slice(0,-length)+'[redacted]';break;}
      }
      fields={...fields,text_preview:preview};
    }
    sink.event(name,fields);
  }};
  let failure:unknown,maintenance:BotMaintenance|undefined,dispatcher:BotDispatcher|undefined,api:QQBotAPI|undefined;
  let lastPoll:number|null=null;
  let state:RuntimeState='starting',policy:RuntimePolicy|undefined,gatewayState:GatewayState={connected:false,last_ack:null,last_ready:null,reconnects:0,sequence:null};
  let healthDirty=false,healthTask:Promise<void>|undefined,panelTask:Promise<void>|undefined,panelsRevision:number|undefined;
  const tasks:Promise<unknown>[]=[];
  const fail=(error:unknown)=>{failure??=error;stop.abort();};
  const health=()=>{
    healthDirty=true;if(healthTask||!maintenance||signal.aborted)return;
    healthTask=(async()=>{
      while(healthDirty&&!signal.aborted){healthDirty=false;await maintenance!.health({kind:'health',gateway:{...gatewayState},state},signal);}
    })().catch(error=>{if(!signal.aborted)observer.event('health_state_unavailable',safeError(error));}).finally(()=>{healthTask=undefined;});
  };
  const syncPanels=(current:RuntimePolicy)=>{
    if(current.dryRun){panelsRevision=undefined;return;}
    if(!config.setupPanels||panelsRevision===current.revision||panelTask)return;
    panelTask=(async()=>{
      const done=await api!.setupPanels([...BOT_COMMANDS],config.group,signal,async()=>{owner.assert();await maintenance!.panelsGuard(signal);checkAbort(signal);});
      if(done){
        const latest=await maintenance!.policy(signal);
        panelsRevision=!latest.dryRun&&latest.revision===current.revision?current.revision:undefined;
        observer.event(panelsRevision!==undefined?'panels_registered':'panels_registration_superseded');
      }
      else observer.event('panels_failed');
    })().catch(error=>{if(!signal.aborted)observer.event('panels_failed',safeError(error));}).finally(()=>{panelTask=undefined;});
  };
  try{
    api=new QQBotAPI(config,{observer,tokenHosts:options.tokenHosts,request:async(...args)=>{
      try{owner.assert();}catch(error){fail(error);throw error;}
      checkAbort(signal);
      return (options.request??fetchBotJSON)(...args);
    }});
    maintenance=new BotMaintenance({...config,database:owner.database},{api,observer,defaults:options.defaults,composition:options.composition??{baseURL:config.baseURL},workerURL:options.maintenanceWorkerURL,onFailure:fail});
    policy=await within(startupMs,signal,child=>maintenance!.init(child));
    await maintenance.health({kind:'health',gateway:gatewayState,state},signal);
    const business=new BotDispatchWorkers({...config,database:owner.database},{api,observer,defaults:options.defaults,workerURL:options.dispatchWorkerURL,onFailure:fail});
    dispatcher=new BotDispatcher({api,business,observer,verboseEvents:config.verboseEvents});
    state='running';observer.event('bot_started',{dry_run:policy.dryRun,deployment_dry_run:config.dryRun});
    const gateway=new QQGateway({api,intents:config.intents,observer,onDispatch:(event,lifetime)=>dispatcher!.onDispatch(event,lifetime),onState:next=>{gatewayState=next;health();},...options.gateway});
    tasks.push(gateway.run(signal).catch(error=>{if(!signal.aborted)fail(error);}));
    tasks.push((async()=>{
      while(!signal.aborted){
        try{
          owner.assert();policy=await maintenance!.policy(signal);syncPanels(policy);
          const counts=await maintenance!.poll(signal);lastPoll=Date.now()/1000;observer.event('poll_completed',counts as Record<string,unknown>);health();
        }catch(error){
          if(signal.aborted)break;
          observer.event('poll_failed',safeError(error));
          if(!(error instanceof BotMaintenanceError&&error.busy))throw error;
        }
        await delay(config.pollInterval*1000,signal);
      }
    })().catch(error=>{if(!signal.aborted)fail(error);}));
    await Promise.all(tasks);
  }catch(error){if(!parent.aborted||failure)failure??=error;}
  finally{
    state=failure?'failed':'stopping';stop.abort();api?.close();
    await Promise.allSettled(tasks);
    await Promise.allSettled([...(healthTask?[healthTask]:[]),...(panelTask?[panelTask]:[])]);
    await dispatcher?.close();
    let graceful=true,finalHealthPublished=false;
    if(maintenance){
      try{await within(shutdownMs,new AbortController().signal,child=>maintenance!.health({kind:'health',gateway:{...gatewayState,connected:false},state:failure?'failed':'stopped'},child));finalHealthPublished=true;}catch{/* A failed worker cannot publish health. */}
      graceful=await maintenance.close(shutdownMs);
    }
    if(!graceful)failure??=Error('Bot shutdown required worker termination; review sending work before restart');
    // Publish a final timestamp even if the worker failed. No last_poll/ACK is invented.
    if(!finalHealthPublished||!graceful)writeBotHealth(config.logDirectory,{dry_run:policy?.dryRun??config.dryRun,deployment_dry_run:config.dryRun,policy_resolved:!!policy,policy_revision:policy?.revision,last_ack:gatewayState.last_ack,last_ready:gatewayState.last_ready,last_poll:lastPoll,reconnects:gatewayState.reconnects,gateway_connected:false,runtime_state:failure?'failed':'stopped'},observer);
    owner.close();observer.event('bot_stopped',{graceful,failed:!!failure});
  }
  if(failure)throw failure;
}
