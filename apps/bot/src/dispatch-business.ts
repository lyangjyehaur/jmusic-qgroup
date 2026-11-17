import Database from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { assertDatabaseUsable, observeBotGroup, readBotPolicy, recordBotIgnore, type DB } from '@qgroup/database';
import { botContentProblem, botDryRun, botHasUnapprovedLink, botReplyAllowed, type BotPolicyDefaults } from '@qgroup/domain';
import type { QQBotAPI } from './api';
import { AbbreviationDelivery, AbbreviationSendBlocked } from './abbreviation-delivery';
import { AbbreviationLookup, type AbbreviationRequest } from './abbreviations';
import type { BotDispatchReply } from './dispatch';
import type { DispatchConfig, DispatchWork } from './dispatch-types';
import { checkAbort } from './lifecycle';
import { createBotObserver, type BotObserver } from './observability';
import { reference, validPlatformId } from './protocol';
import { identityDiagnosticFields,type MessageObservation } from './identity-diagnostics';
import { readPublicBotReply } from './replies';
import { BotMaskLoader } from './word-mask';
/** Worker-thread business service. Never migrate/create a database or infer site identity. */
export class BotDispatchService {
  readonly #lookup:AbbreviationLookup;readonly #delivery:AbbreviationDelivery;readonly #observer:BotObserver;
  constructor(readonly config:DispatchConfig,readonly defaults:BotPolicyDefaults={},options:{observer?:BotObserver;abbreviationRequest?:AbbreviationRequest}={}){
    this.#observer=options.observer??createBotObserver();
    const loader=new BotMaskLoader({extraFile:config.sensitiveWordsFile||undefined}),loadMask=()=>loader.load();
    this.#lookup=new AbbreviationLookup({loadMask,request:options.abbreviationRequest,observer:this.#observer});
    this.#delivery=new AbbreviationDelivery(join(dirname(config.database),'bot-abbreviation-results'),{loadMask,pageBytes:config.abbreviationPageBytes,observer:this.#observer});
  }
  close(){this.#lookup.close();}
  diagnose(observation:MessageObservation,signal:AbortSignal){
    checkAbort(signal);const fields=identityDiagnosticFields(this.config.database,observation);checkAbort(signal);
    this.#observer.event('message_received',fields);
  }
  #database<T>(readonly:boolean,work:(db:DB)=>T):T {
    const db=new Database(this.config.database,{readonly,fileMustExist:true});
    try{
      db.pragma('busy_timeout = 5000');if(readonly)db.pragma('query_only = ON');
      const transaction=db.transaction(()=>{assertDatabaseUsable(db);return work(db);});
      // Acquire the writer before taking a read snapshot. A deferred upgrade
      // can fail with SQLITE_BUSY_SNAPSHOT despite the configured busy timeout.
      return readonly?transaction():transaction.immediate();
    }
    finally{db.close();}
  }
  observe(group:string,event:string,reason:string|undefined,signal:AbortSignal) {
    checkAbort(signal);if(!validPlatformId(group))return;
    this.#database(false,db=>{const stamp=new Date().toISOString();if(event)observeBotGroup(db,group,event,stamp);if(reason)recordBotIgnore(db,group,reason,stamp);});
  }
  #policy(){return this.#database(true,db=>readBotPolicy(db,this.defaults).config);}
  #allowed(group:string,signal:AbortSignal,realSend=false) {
    checkAbort(signal);const policy=this.#policy();checkAbort(signal);
    const reason=!botReplyAllowed(policy,group,this.config.group)?'group_not_allowed':!policy.replies_enabled?'replies_disabled':realSend&&botDryRun(policy,this.config.dryRun)?'dry_run':null;
    if(reason){this.#observer.event('reply_skipped',{reason,group_ref:reference(group)});this.observe(group,'',reason,signal);return false;}
    return true;
  }
  async reply(request:BotDispatchReply,api:Pick<QQBotAPI,'replyGroup'>,signal:AbortSignal) {
    const {group,command,argument,msgId,eventId}=request;
    if(!validPlatformId(group)||!(validPlatformId(msgId)||validPlatformId(eventId)))return;
    if(!this.#allowed(group,signal))return;
    const beforeSend=()=>{if(!this.#allowed(group,signal,true))throw new AbbreviationSendBlocked();};
    try {
      if(command==='缩写'){
        let page=await this.#delivery.continuation(group,argument,signal);
        if(!page)page={text:await this.#lookup.answer(argument,signal)};
        checkAbort(signal);
        // No source/quote previews. The delivery service remasks under latest rules.
        this.#observer.event('reply_prepared',{command,group_ref:reference(group),text_hash:reference(String(page.text))});
        beforeSend();await this.#delivery.send(api,group,page,{msgId,eventId,signal,beforeSend});
      }else {
        const reply=readPublicBotReply(this.config.database,command,argument,{baseURL:this.config.baseURL});checkAbort(signal);
        const markdown=this.config.markdownReplies&&reply.markdown&&!botContentProblem(reply.markdown,this.config.allowedLinkHosts)?reply.markdown:undefined;
        if(!markdown&&botHasUnapprovedLink(reply.text,this.config.allowedLinkHosts)){this.#observer.event('reply_skipped',{reason:'unreported_link_host'});return;}
        this.#observer.event('reply_prepared',{command:command??'unknown',msg_type:markdown?2:0,text_hash:reference(markdown||reply.text)});
        beforeSend();const result=await api.replyGroup(group,reply.text,{msgId,eventId,seq:1,markdown,signal});
        this.#observer.event(result.ok?'reply_sent':'reply_failed',{api_code:result.code});
        // Never retry a rejected Markdown reply as plain text: acceptance may be uncertain.
      }
    }catch(error){if(error instanceof AbbreviationSendBlocked)return;throw error;}
  }
  async execute(work:DispatchWork,api:Pick<QQBotAPI,'replyGroup'>,signal:AbortSignal) {
    if(work.kind==='diagnose')this.diagnose(work.observation,signal);
    else if(work.kind==='observe')this.observe(work.group,work.event,work.reason,signal);
    else if(work.kind==='authorize'){if(!this.#allowed(work.group,signal,true))throw new AbbreviationSendBlocked();}
    else await this.reply(work.request,api,signal);
  }
}
