import { z } from 'zod';
export type PendingOperation={id:string;label:string;to:string;damaged:boolean;requestKey?:string};
const root='qgroup:rebuild:';
const uuid=z.string().uuid(),token=/^[A-Za-z0-9_-]{32}$/;
const segment=(value:string)=>encodeURIComponent(value);
/** Inventory only. Stored payloads, names, PINs, secrets and arbitrary URLs never leave the original form. */
export function pendingOperations(storage:Pick<Storage,'length'|'key'|'getItem'>,scope:string):PendingOperation[]{
  const rows:PendingOperation[]=[];
  for(let i=0;i<storage.length;i++){
    const key=storage.key(i);if(!key||!key.startsWith(root)||key.includes(':recovery:'))continue;
    let label='',to='',standalone=false;
    if(key===root+'privacy-pending:v1'){
      try{const raw=JSON.parse(storage.getItem(key)??'null');if(typeof raw?.scope!=='string'||!/^[a-f0-9]{64}$/.test(raw.scope))throw Error('scope');if(raw.scope!==scope)continue;}catch{rows.push({id:key,label:'無法辨識帳號的刪除紀錄',to:'/me/privacy',damaged:true});continue;}
      label='資料刪除';to='/me/privacy';standalone=true;
    }else if(key===root+'notifications-read:v1:'+scope){continue;/* Recovered directly in the inbox. */}
    else if(key===root+'music:v1:'+scope){label='成分選擇';to='/me/music';}
    else if(key===root+'account-profile:v1:'+scope){label='帳號稱呼';to='/me/profile';}
    else if(key===root+'payment-codes:v1:'+scope){label='我的收款碼';to='/me/payment-codes';}
    else if(key===root+'music:claim:v1:'+scope){label='找回舊成分';to='/me/music/recover';standalone=true;}
    else if(key.startsWith(root+'music:fields:v1:'+scope+':')){label='成分資料';to='/me/music/details';}
    else if(key.startsWith(root+'music:contact:v1:'+scope+':')){label='聯絡 QQ';to='/me/music/contact';}
    else if(key.startsWith(root+'music:entries:v1:'+scope+':')){const target=key.slice((root+'music:entries:v1:'+scope+':').length);if(target==='new'){label='建立詞條';to='/me/music/entries/new';}else{const match=/^([^:]{1,80}):(update|delete)$/.exec(target);if(!match)continue;label=match[2]==='delete'?'刪除詞條':'編輯詞條';to='/me/music/entries/'+segment(match[1]!)+(match[2]==='delete'?'/delete':'/edit');}}
    else{
      const activity=/^qgroup:rebuild:activity-draft:(?:(arrangements|registration|consent|lifecycle|invitations|claims|delegation|attendance|finance|settlement|rooms|poll-create|poll-vote|poll-manage):)?v1:([^:]+):(.+)$/.exec(key);
      const admin=/^qgroup:rebuild:admin-(privacy|music|music-pin|user):v1:([^:]+):[^:]+:(.+)$/.exec(key);
      if(activity&&activity[2]===scope){
        const kind=activity[1]??'draft';let id=activity[3]!,mode='';
        if(['registration','invitations','claims','delegation'].includes(kind)){
          const match=/^(.*):(manage|signup|issue|(?:accept|request):[A-Za-z0-9_-]{32})$/.exec(id);if(!match)continue;id=match[1]!;mode=match[2]!;
        }
        if(!id||id.length>80)continue;const path='/activities/'+segment(id);
        if(kind.startsWith('poll-')){label=kind==='poll-create'?'建立時間投票':kind==='poll-vote'?'投票填答':'投票管理';to=kind==='poll-create'?'/time-polls/new':'/time-polls/'+segment(id)+(kind==='poll-manage'?'/manage':'');}
        else if(kind==='draft'){label='活動草稿';to=id==='new'?'/activities/new':id.startsWith('copy:')?'/activities/new?copyFrom='+segment(id.slice(5)):path+'/edit';}
        else{
          const suffix={arrangements:'arrangements',registration:mode==='manage'?'registration':'signup',consent:'conditions',lifecycle:'lifecycle',invitations:'invitations',claims:'claims',delegation:'delegation',attendance:'attendance',finance:'finance',settlement:'settlement/edit',rooms:'rooms'}[kind];
          if(!suffix)continue;label={arrangements:'活動安排',registration:'活動報名',consent:'安排回覆',lifecycle:'活動狀態',invitations:'補報名邀請',claims:'代報認領',delegation:'管理分工',attendance:'現場出席',finance:'收付款帳本',settlement:'逐人結算',rooms:'預分包間'}[kind]!;to=path+'/'+suffix;
          const recipient=mode.split(':')[1];if(recipient&&token.test(recipient))to+='/'+segment(recipient);
        }
      }else if(admin&&admin[2]===scope){
        label={privacy:'隱私審查',music:'成分關聯',user:'帳號管理','music-pin':'成分口令'}[admin[1]!]!;
        to='/admin/'+(admin[1]==='user'?'users':admin[1]==='privacy'?'privacy':'music')+'/'+segment(admin[3]!);standalone=admin[1]==='music-pin';
      }else continue;
    }
    try{
      const value:unknown=JSON.parse(storage.getItem(key)??'null');if(!value||Array.isArray(value)||typeof value!=='object')throw Error('draft');
      const data=value as Record<string,unknown>,pending=data.pending;
      if(standalone){rows.push({id:key,label,to,damaged:!('input' in data)&&!uuid.safeParse(data.requestId).success});continue;}
      if(pending===undefined&&data.requestKey===undefined)continue;
      if(pending!==undefined&&(!pending||typeof pending!=='object'||!('input' in pending)))throw Error('pending');
      const requestKey=uuid.parse(pending&&typeof pending==='object'?'key' in pending?pending.key:undefined:data.requestKey);
      rows.push({id:key,label,to,damaged:false,requestKey});
    }catch{rows.push({id:key,label,to,damaged:true});}
  }
  return rows;
}
