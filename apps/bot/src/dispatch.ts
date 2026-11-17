import { createHash } from 'node:crypto';
import { groupBotCommand, hasBotQuote, normalizeBotContent } from './abbreviation-input';
import { parseBotCommand, type BotCommand } from './commands';
import type { QQBotAPI } from './api';
import type { GatewayDispatch } from './gateway';
import { checkAbort, within } from './lifecycle';
import { createBotObserver, safeError, type BotObserver } from './observability';
import { object, reference, validPlatformId, type APIObject } from './protocol';
export interface BotDispatchReply {
  group: string; command: BotCommand | null; argument: string; msgId?: string; eventId?: string;
}
/** Implementations must isolate synchronous database/mask work from the gateway. */
export interface BotDispatchBusiness {
  observe(group: string, event: string, reason: string | undefined, signal: AbortSignal): Promise<void>;
  reply(request: BotDispatchReply, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
const everyone=/<qqbot-at-everyone\b[^>]*>|<@!?(?:all|everyone)>|[@＠](?:全体成员|全體成員|全员|全員|全体|全體)|(?<![\p{L}\p{N}_])@(?:all|everyone)\b/iu;
export function mentionsThisBot(mentions: unknown, botId: string, content: unknown) {
  if(Array.isArray(mentions)&&mentions.some(item=>object(item)&&(item.is_you===true||(botId&&item.id===botId))))return true;
  if(!botId||typeof content!=='string')return false;
  return [...content.matchAll(/<@!?([A-Za-z0-9_-]+)>|<qqbot-at-user id="([A-Za-z0-9_-]+)"[^>]*>/g)].some(match=>(match[1]??match[2])===botId);
}
export function mentionsEveryone(payload: APIObject) {
  return payload.mention_everyone===true||everyone.test(typeof payload.content==='string'?payload.content:'')||
    (Array.isArray(payload.mentions)&&payload.mentions.some(item=>object(item)&&['all','everyone'].includes(String(item.id))));
}
class ExpiringSet {
  readonly #items=new Map<string,number>();
  constructor(readonly ttl:number, readonly max:number) {}
  prune(now:number){for(const [key,until] of this.#items){if(until>now)break;this.#items.delete(key);}}
  has(key:string){return !!key&&this.#items.has(key);}
  full(){return this.#items.size>=this.max;}
  add(key:string,now:number){if(key)this.#items.set(key,now+this.ttl);}
}
function quoteFingerprint(value:unknown) {
  const seen=new WeakSet<object>();
  return JSON.stringify(value,(_key,item:unknown)=>{
    if(item&&typeof item==='object') {if(seen.has(item))return '[cycle]';seen.add(item);}
    return object(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item;
  });
}
/** Bounded, in-memory dedup; overflow refuses new commands instead of evicting live IDs. */
export class BotDispatchDedup {
  readonly #messages:ExpiringSet;readonly #fingerprints:ExpiringSet;readonly #interactions:ExpiringSet;
  constructor(readonly now=()=>performance.now(),max=8192){
    if(!Number.isSafeInteger(max)||max<1)throw Error('Invalid dedup capacity');
    this.#messages=new ExpiringSet(600000,max);this.#fingerprints=new ExpiringSet(30000,max);this.#interactions=new ExpiringSet(600000,max);
  }
  interaction(id:unknown):'new'|'duplicate'|'full' {
    const now=this.now();this.#interactions.prune(now);
    if(typeof id!=='string'||!id)return 'new';
    const key=reference(id)!;if(this.#interactions.has(key))return 'duplicate';if(this.#interactions.full())return 'full';this.#interactions.add(key,now);return 'new';
  }
  message(payload:APIObject):'new'|'duplicate'|'full' {
    const now=this.now();this.#messages.prune(now);this.#fingerprints.prune(now);
    const author=object(payload.author)?payload.author:{},id=typeof payload.id==='string'?reference(payload.id)??'':'';
    const fingerprint=createHash('sha256').update(JSON.stringify([payload.group_openid,author.id||author.member_openid||'',normalizeBotContent(payload.content),hasBotQuote(payload)?quoteFingerprint(payload.msg_elements):'',payload.timestamp||payload.id||''])).digest('hex');
    if(this.#messages.has(id)||this.#fingerprints.has(fingerprint))return 'duplicate';
    if((id&&this.#messages.full())||this.#fingerprints.full())return 'full';
    this.#messages.add(id,now);this.#fingerprints.add(fingerprint,now);return 'new';
  }
}
/** Accept bounded jobs quickly; their lifetime stays linked to the gateway connection.
 * Acceptance advances gateway sequence; this is not a durable replay queue.
 */
export class BotDispatcher {
  readonly #observer:BotObserver;readonly #dedup:BotDispatchDedup;readonly #jobs=new Set<Promise<void>>();
  readonly #seen=new Map<string,number>();readonly #stop=new AbortController();#botId='';
  constructor(readonly options:{api:Pick<QQBotAPI,'ackInteraction'>;business:BotDispatchBusiness;observer?:BotObserver;verboseEvents?:boolean;now?:()=>number;maxJobs?:number;jobTimeoutMs?:number;dedup?:BotDispatchDedup}){
    this.#observer=options.observer??createBotObserver();this.#dedup=options.dedup??new BotDispatchDedup(options.now);
    if(!Number.isSafeInteger(options.maxJobs??64)||(options.maxJobs??64)<1||!Number.isFinite(options.jobTimeoutMs??30000)||(options.jobTimeoutMs??30000)<=0)throw Error('Invalid dispatch limits');
  }
  get pending(){return this.#jobs.size;}
  #start(parent:AbortSignal,work:(signal:AbortSignal)=>Promise<void>) {
    checkAbort(parent);checkAbort(this.#stop.signal);
    if(this.#jobs.size>=(this.options.maxJobs??64)){this.#observer.event('business_queue_full');return;}
    const job=within(this.options.jobTimeoutMs??30000,AbortSignal.any([parent,this.#stop.signal]),work).catch(error=>{
      this.#observer.event('business_dispatch_failed',safeError(error));
    }).finally(()=>this.#jobs.delete(job));
    this.#jobs.add(job);
  }
  async drain(){while(this.#jobs.size)await Promise.all([...this.#jobs]);}
  async close(){this.#stop.abort();await this.drain();await this.options.business.close();}
  async onDispatch(event:GatewayDispatch,signal:AbortSignal) {
    checkAbort(signal);checkAbort(this.#stop.signal);const payload=object(event.d)?event.d:{},type=event.t;
    if(this.options.verboseEvents)this.#observer.event('platform_event',{event_type:type,payload_fields:Object.keys(payload).sort().slice(0,40)});
    if(type==='READY'){const user=object(payload.user)?payload.user:{};if(validPlatformId(user.id))this.#botId=user.id;return;}
    const group=payload.group_openid;
    if(type==='INTERACTION_CREATE') {
      const inner=object(payload.data)?payload.data:{},kind=payload.type??inner.type;
      if(kind!==11&&kind!==12){this.#observer.event('interaction_authorization',{interaction_type:typeof kind==='number'?kind:null});return;}
      if(!validPlatformId(payload.id)){this.#observer.event('interaction_ignored',{reason:'invalid_id'});return;}
      // Do not reserve an ID when no job can be accepted.
      if(this.#jobs.size>=(this.options.maxJobs??64)){this.#observer.event('business_queue_full');return;}
      const decision=this.#dedup.interaction(payload.id);
      if(decision!=='new'){this.#observer.event('interaction_ignored',{reason:decision});return;}
      const interactionId=payload.id;
      this.#start(signal,async lifetime=>{
        try{await this.options.api.ackInteraction(interactionId,0,lifetime);}catch(error){checkAbort(lifetime);this.#observer.event('interaction_ack_failed',safeError(error));}
        checkAbort(lifetime);if(!validPlatformId(group))return;
        await this.options.business.observe(group,type,undefined,lifetime);
        const resolved=object(inner.resolved)?inner.resolved:{},[command,argument]=parseBotCommand(typeof resolved.button_data==='string'?resolved.button_data:'');
        this.#observer.event('command_parsed',{source:'button',command:command??'unknown',argument_ref:reference(argument)});
        // Only the outer dispatch ID authorizes an event reply.
        if(!validPlatformId(event.id)){this.#observer.event('reply_skipped',{reason:'invalid_event_id'});return;}
        await this.options.business.reply({group,command,argument,eventId:event.id},lifetime);
      });return;
    }
    if(!validPlatformId(group))return;
    const addressed=mentionsThisBot(payload.mentions,this.#botId,payload.content);
    const now=(this.options.now??(()=>performance.now()))(),important=type!=='GROUP_MESSAGE_CREATE'||addressed;
    const observe=important||now-(this.#seen.get(group)??-Infinity)>=60000;
    // A membership event always reaches observation; ordinary traffic is throttled.
    const message=type==='GROUP_AT_MESSAGE_CREATE'||type==='GROUP_MESSAGE_CREATE';
    let request:BotDispatchReply|undefined,reason:string|undefined;
    if(message){
      const author=object(payload.author)?payload.author:{};
      if(author.bot)reason='bot_author';
      else if(mentionsEveryone(payload))reason='everyone_mention';
      else if(!addressed)reason='not_addressed';
      else if(!validPlatformId(payload.id))reason='invalid_message_id';
      else if(this.#jobs.size>=(this.options.maxJobs??64))reason='queue_full';
      else {const decision=this.#dedup.message(payload);if(decision!=='new')reason=decision;else {
        const [command,argument]=groupBotCommand(payload);request={group,command,argument,msgId:payload.id as string};
        // Input and quoted text never receive content previews, even in diagnostic mode.
        this.#observer.event('command_parsed',{source:'message',command:command??'unknown',argument_ref:reference(argument),group_ref:reference(group)});
      }}
      if(reason)this.#observer.event('message_ignored',{reason,group_ref:reference(group)});
    }
    if(!observe&&!request&&reason!=='duplicate')return;
    if(this.#jobs.size>=(this.options.maxJobs??64)){this.#observer.event('business_queue_full');return;}
    if(observe){this.#seen.delete(group);this.#seen.set(group,now);if(this.#seen.size>500)this.#seen.delete(this.#seen.keys().next().value!);}
    this.#start(signal,async lifetime=>{
      if(observe||reason==='duplicate')await this.options.business.observe(group,observe?type:'',reason,lifetime);
      if(request){checkAbort(lifetime);await this.options.business.reply(request,lifetime);}
    });
  }
}
