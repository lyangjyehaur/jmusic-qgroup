import { uiText } from './language';
import { z } from 'zod';
import { MusicRecoveryRecord } from './music-recovery-record';
import { musicShoutDraftTarget,parseMusicShoutDraft } from './music-shout-record';
import { activityAccessDraftRoute, PendingActivityAccess } from './activity-access-record';
import { botDeliveryDraftRoute, PendingBotDelivery } from './bot-delivery-record';
import { parsePrivacyConsent } from './privacy-consent-record';
export type PendingOperation={id:string;label:string;to:string;damaged:boolean;requestKey?:string;adminScope?:string};
const root='qgroup:rebuild:';
const uuid=z.string().uuid(),token=/^[A-Za-z0-9_-]{32}$/;
const segment=(value:string)=>encodeURIComponent(value);
/** Inventory only. Stored payloads, names, PINs, secrets and arbitrary URLs never leave the original form. */
export function pendingOperations(storage:Pick<Storage,'length'|'key'|'getItem'>,scope:string):PendingOperation[]{
  const rows:PendingOperation[]=[];
  for(let i=0;i<storage.length;i++){
    const key=storage.key(i);if(!key||!key.startsWith(root)||key.includes(':recovery:'))continue;
    if(key===root+'privacy-consent:v1:'+scope){
      try{const pending=parsePrivacyConsent(storage.getItem(key)??'null',scope);if(pending)rows.push({id:key,label:uiText('政策同意'),to:'/me/privacy/consent',damaged:false,requestKey:pending.key});}
      catch{rows.push({id:key,label:uiText('政策同意'),to:'/me/privacy/consent',damaged:true});}
      continue;
    }
    if(key===root+'music:claim:v1:'+scope){
      try{const pending=MusicRecoveryRecord.nullable().parse(JSON.parse(storage.getItem(key)??'null'));if(pending)rows.push({id:key,label:uiText("找回舊成分"),to:'/me/music/recover',damaged:false});}
      catch{rows.push({id:key,label:uiText("找回舊成分"),to:'/me/music/recover',damaged:true});}
      continue;
    }
    const shout=musicShoutDraftTarget(key,scope);
    if(shout){
      try{
        const draft=parseMusicShoutDraft(storage.getItem(key)??'{}',shout);
        if(draft.pending)rows.push({id:key,label:uiText("發布找搭子"),to:'/people/shouts',damaged:false,requestKey:draft.pending.key});
      }catch{rows.push({id:key,label:uiText("發布找搭子"),to:'/people/shouts',damaged:true});}
      continue;
    }
    const access=activityAccessDraftRoute(key,scope);
    if(access){
      try{
        const pending=PendingActivityAccess.nullable().parse(JSON.parse(storage.getItem(key)??'null'));
        if(pending)rows.push({id:key,label:uiText("活動查看邀請"),to:access.path,damaged:false,requestKey:pending.key});
      }catch{rows.push({id:key,label:uiText("活動查看邀請"),to:access.path,damaged:true});}
      continue;
    }
    const delivery=botDeliveryDraftRoute(key,scope);
    if(delivery){
      try{
        const pending=PendingBotDelivery.nullable().parse(JSON.parse(storage.getItem(key)??'null'));
        if(pending)rows.push({id:key,label:uiText("群通知重送"),to:delivery.path,damaged:false,requestKey:pending.key});
      }catch{rows.push({id:key,label:uiText("群通知重送"),to:delivery.path,damaged:true});}
      continue;
    }
    let label='',to='',standalone=false,adminScope:string|undefined;
    if(key===root+'privacy-pending:v1'){
      try{const raw=JSON.parse(storage.getItem(key)??'null');if(typeof raw?.scope!=='string'||!/^[a-f0-9]{64}$/.test(raw.scope))throw Error('scope');if(raw.scope!==scope)continue;}catch{rows.push({id:key,label:uiText("無法辨識帳號的刪除紀錄"),to:'/me/privacy',damaged:true});continue;}
      label=uiText("資料刪除");to='/me/privacy';standalone=true;
    }else if(key===root+'notifications-read:v1:'+scope){continue;/* Recovered directly in the inbox. */}
    else if(key===root+'music:v1:'+scope){label=uiText("成分選擇");to='/me/music';}
    else if(key===root+'account-profile:v1:'+scope){label=uiText("帳號稱呼");to='/me/profile';}
    else if(key===root+'payment-codes:v1:'+scope){label=uiText("我的收款碼");to='/me/payment-codes';}
    else if(key.startsWith(root+'music:fields:v1:'+scope+':')){label=uiText("成分資料");to='/me/music/details';}
    else if(key.startsWith(root+'music:contact:v1:'+scope+':')){label=uiText("聯絡 QQ");to='/me/music/contact';}
    else if(key.startsWith(root+'music:entries:v1:'+scope+':')){const target=key.slice((root+'music:entries:v1:'+scope+':').length);if(target==='new'){label=uiText("建立詞條");to='/me/music/entries/new';}else{const match=/^([^:]{1,80}):(update|delete)$/.exec(target);if(!match)continue;label=match[2]==='delete'?uiText("刪除詞條"):uiText("編輯詞條");to='/me/music/entries/'+segment(match[1]!)+(match[2]==='delete'?'/delete':'/edit');}}
    else if(new RegExp('^qgroup:rebuild:admin-(bot|catalog|appearance|shouts):v1:'+scope+':[a-f0-9]{64}$').test(key)){
      const kind=key.split(':')[2]!.slice(6);label={bot:uiText("bot 設定"),catalog:uiText("音樂詞庫管理"),appearance:uiText("壁紙管理"),shouts:uiText("找搭子管理")}[kind]!;to={bot:'/admin/bot',catalog:'/admin/music-entries',appearance:'/admin/appearance',shouts:'/admin/shouts'}[kind]!;
      adminScope=key.split(':')[5]!;
    }
    else{
      const activity=/^qgroup:rebuild:activity-draft:(?:(arrangements|registration|consent|lifecycle|invitations|claims|delegation|attendance|finance|settlement|rooms|poll-create|poll-vote|poll-manage):)?v1:([^:]+):(.+)$/.exec(key);
      const admin=/^qgroup:rebuild:admin-(privacy|music|music-pin|user):v1:([^:]+):([a-f0-9]{64}):([^:]{1,128})$/.exec(key);
      if(activity&&activity[2]===scope){
        const kind=activity[1]??'draft';let id=activity[3]!,mode='';
        if(['registration','invitations','claims','delegation'].includes(kind)){
          const match=/^(.*):(manage|signup|issue|(?:accept|request):[A-Za-z0-9_-]{32})$/.exec(id);if(!match)continue;id=match[1]!;mode=match[2]!;
        }
        if(!id||id.length>80)continue;const path='/activities/'+segment(id);
        if(kind.startsWith('poll-')){label=kind==='poll-create'?uiText("建立時間投票"):kind==='poll-vote'?uiText("投票填答"):uiText("投票管理");to=kind==='poll-create'?'/time-polls/new':'/time-polls/'+segment(id)+(kind==='poll-manage'?'/manage':'');}
        else if(kind==='draft'){label=uiText("活動草稿");to=id==='new'?'/activities/new':id.startsWith('copy:')?'/activities/new?copyFrom='+segment(id.slice(5)):path+'/edit';}
        else{
          const suffix={arrangements:'arrangements',registration:mode==='manage'?'registration':'signup',consent:'conditions',lifecycle:'lifecycle',invitations:'invitations',claims:'claims',delegation:'delegation',attendance:'attendance',finance:'finance',settlement:'settlement/edit',rooms:'rooms'}[kind];
          if(!suffix)continue;label={arrangements:uiText("活動安排"),registration:uiText("活動報名"),consent:uiText("安排回覆"),lifecycle:uiText("活動狀態"),invitations:uiText("補報名邀請"),claims:uiText("代報認領"),delegation:uiText("管理分工"),attendance:uiText("現場出席"),finance:uiText("收付款帳本"),settlement:uiText("逐人結算"),rooms:uiText("預分包間")}[kind]!;to=path+'/'+suffix;
          const recipient=mode.split(':')[1];if(recipient&&token.test(recipient))to+='/'+segment(recipient);
        }
      }else if(admin&&admin[2]===scope){
        label={privacy:uiText("隱私審查"),music:uiText("成分關聯"),user:uiText("帳號管理"),'music-pin':uiText("成分口令")}[admin[1]!]!;
        to='/admin/'+(admin[1]==='user'?'users':admin[1]==='privacy'?'privacy':'music')+'/'+segment(admin[4]!);standalone=admin[1]==='music-pin';adminScope=admin[3]!;
      }else continue;
    }
    try{
      const value:unknown=JSON.parse(storage.getItem(key)??'null');if(value===null&&(key.startsWith(root+'admin-music-pin:v1:'+scope+':')||new RegExp('^qgroup:rebuild:admin-bot:v1:'+scope+':[a-f0-9]{64}$').test(key)))continue;if(!value||Array.isArray(value)||typeof value!=='object')throw Error('draft');
      const data=value as Record<string,unknown>,pending=data.pending;
      if(standalone){rows.push({id:key,label,to,damaged:!('input' in data)&&!uuid.safeParse(data.requestId).success});continue;}
      if(pending===undefined&&data.requestKey===undefined)continue;
      if(pending!==undefined&&(!pending||typeof pending!=='object'||!('input' in pending)))throw Error('pending');
      const requestKey=uuid.parse(pending&&typeof pending==='object'?'key' in pending?pending.key:undefined:data.requestKey);
      rows.push({id:key,label,to,damaged:false,requestKey,...adminScope?{adminScope}:{}});
    }catch{rows.push({id:key,label,to,damaged:true});}
  }
  return rows;
}
