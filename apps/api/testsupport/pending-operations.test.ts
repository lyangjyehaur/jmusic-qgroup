import { MusicRecoveryRecord } from '../../web/src/music-recovery-record';
import { describe, expect, it } from 'vitest';
import { musicShoutDraftTarget,parseMusicShoutDraft } from '../../web/src/music-shout-record';
import { activityAccessDraftRoute } from '../../web/src/activity-access-record';
import { botDeliveryDraftRoute } from '../../web/src/bot-delivery-record';
import { pendingOperations } from '../../web/src/pending-operations';
const current='a'.repeat(64),other='b'.repeat(64),authority='c'.repeat(64),key='00000000-0000-4000-8000-000000000001',root='qgroup:rebuild:';
function storage(rows:Record<string,string>){const values=Object.entries(rows);return {length:values.length,key:(i:number)=>values[i]?.[0]??null,getItem:(key:string)=>rows[key]??null};}
const pending=JSON.stringify({pending:{key,input:{note:'PRIVATE_NOTE',token:'PRIVATE_TOKEN',pin:'PRIVATE_PIN'}}});
describe('scoped pending operation inventory',()=>{
 it('keeps original policy consent recovery scoped without exposing version or payload',()=>{
   const name=root+'privacy-consent:v1:'+current,raw=JSON.stringify({scope:current,key,input:{acceptPrivacy:true,privacyVersion:'PRIVATE_HISTORICAL_VERSION'}});
   expect(pendingOperations(storage({[name]:raw}),current)).toEqual([{id:name,label:'政策同意',to:'/me/privacy/consent',damaged:false,requestKey:key}]);
   expect(JSON.stringify(pendingOperations(storage({[name]:raw}),current))).not.toContain('PRIVATE_');
   expect(pendingOperations(storage({[name]:raw}),other)).toEqual([]);
   expect(pendingOperations(storage({[name]:'null'}),current)).toEqual([]);
   for(const data of [{scope:other,key,input:{acceptPrivacy:true,privacyVersion:'old'}},{scope:current,key,input:{acceptPrivacy:false,privacyVersion:'old'}},{scope:current,key,input:{acceptPrivacy:true,privacyVersion:'old'},to:'https://evil.example'}])expect(pendingOperations(storage({[name]:JSON.stringify(data)}),current)[0]?.damaged).toBe(true);
 });
 it('covers existing form families while exposing only fixed application destinations and no payloads',()=>{
   const paths:Record<string,string>={['music:entries:v1:'+current+':new']:'/me/music/entries/new',['music:entries:v1:'+current+':entry:update']:'/me/music/entries/entry/edit',['music:entries:v1:'+current+':entry:delete']:'/me/music/entries/entry/delete',['music:v1:'+current]:'/me/music',['music:fields:v1:'+current+':0:p']:'/me/music/details',['music:contact:v1:'+current+':0:p']:'/me/music/contact',['account-profile:v1:'+current]:'/me/profile',['payment-codes:v1:'+current]:'/me/payment-codes',['activity-draft:v1:'+current+':new']:'/activities/new',['activity-draft:v1:'+current+':copy:a/b']:'/activities/new?copyFrom=a%2Fb',['activity-draft:v1:'+current+':activity']:'/activities/activity/edit',['activity-draft:arrangements:v1:'+current+':activity']:'/activities/activity/arrangements',['activity-draft:registration:v1:'+current+':activity:signup']:'/activities/activity/signup',['activity-draft:registration:v1:'+current+':activity:manage']:'/activities/activity/registration',['activity-draft:consent:v1:'+current+':activity']:'/activities/activity/conditions',['activity-draft:lifecycle:v1:'+current+':activity']:'/activities/activity/lifecycle',['activity-draft:attendance:v1:'+current+':activity']:'/activities/activity/attendance',['activity-draft:finance:v1:'+current+':activity']:'/activities/activity/finance',['activity-draft:claims:v1:'+current+':activity:manage']:'/activities/activity/claims',['activity-draft:delegation:v1:'+current+':activity:manage']:'/activities/activity/delegation',['activity-draft:invitations:v1:'+current+':activity:issue']:'/activities/activity/invitations',['admin-user:v1:'+current+':'+authority+':user']:'/admin/users/user',['admin-privacy:v1:'+current+':'+authority+':request']:'/admin/privacy/request',['admin-music:v1:'+current+':'+authority+':profile']:'/admin/music/profile'};
   const result=pendingOperations(storage(Object.fromEntries(Object.keys(paths).map(name=>[root+name,pending]))),current);expect(result.map(row=>row.to)).toEqual(Object.values(paths));expect(result.every(row=>row.requestKey===key&&!row.damaged)).toBe(true);expect(JSON.stringify(result)).not.toMatch(/PRIVATE_/);
   expect(result.filter(row=>row.to.startsWith('/admin/')).every(row=>row.adminScope===authority)).toBe(true);
   expect(result.filter(row=>!row.to.startsWith('/admin/')).every(row=>row.adminScope===undefined)).toBe(true);
 });
 it('links reviewed content-management pending operations to fixed managers, without image data, targets or authority confusion',()=>{
   const authority='c'.repeat(64),families=['bot','catalog','appearance','shouts'],paths=['/admin/bot','/admin/music-entries','/admin/appearance','/admin/shouts'];
   const raw=JSON.stringify({value:{name:'PRIVATE_NAME',data:'PRIVATE_IMAGE',id:'PRIVATE_TARGET'},pending:{key,input:{data:'PRIVATE_IMAGE'}}});
   const rows=Object.fromEntries(families.map(family=>[root+'admin-'+family+':v1:'+current+':'+authority,raw]));
   const result=pendingOperations(storage(rows),current);expect(result.map(row=>row.to)).toEqual(paths);expect(result.every(row=>!row.damaged&&row.requestKey===key&&row.adminScope===authority)).toBe(true);expect(JSON.stringify(result)).not.toMatch(/PRIVATE_/);
   expect(pendingOperations(storage({[root+'admin-appearance:v1:'+other+':'+authority]:raw,[root+'admin-catalog:v1:'+current+':https://evil.example']:raw,[root+'admin-shouts:v1:'+current+':'+authority+':unexpected']:raw}),current)).toEqual([]);
 });
 it('ignores malformed management scopes instead of querying member receipts',()=>{
   for(const invalid of ['admin','https://evil.example','d'.repeat(63),'D'.repeat(64)])
     expect(pendingOperations(storage(Object.fromEntries(['user','privacy','music','bot','catalog','appearance','shouts'].map(kind=>[root+'admin-'+kind+':v1:'+current+':'+invalid+(['user','privacy','music'].includes(kind)?':target':''),pending]))),current)).toEqual([]);
 });
 it('does not expose an empty bot placeholder or unsent policy as an unfinished command',()=>{
   const name=root+'admin-bot:v1:'+current+':'+'c'.repeat(64);
   for(const raw of ['null',JSON.stringify({value:{templates:{private:'PRIVATE_TEMPLATE'},groups:[{id:'PRIVATE_GROUP'}]},dirty:true,command:'save'})])
     expect(pendingOperations(storage({[name]:raw}),current)).toEqual([]);
 });
 it('omits completed PIN placeholders while retaining only the original receipt lookup destination',()=>{
   const name=root+'admin-music-pin:v1:'+current+':'+'c'.repeat(64)+':profile';expect(pendingOperations(storage({[name]:'null'}),current)).toEqual([]);
   expect(pendingOperations(storage({[name]:JSON.stringify({requestId:key})}),current)).toEqual([{id:name,label:'成分口令',to:'/admin/music/profile',damaged:false}]);
 });
 it('keeps recipient token navigation on the original form, escapes event IDs and ignores stored URLs',()=>{const token='x'.repeat(32);const rows=Object.fromEntries(['claims:request','delegation:accept','invitations:accept'].map(kind=>{const [family,mode]=kind.split(':');return [root+'activity-draft:'+family+':v1:'+current+':../activity:'+mode+':'+token,JSON.stringify({url:'https://evil.example',pending:{key,input:{}}})];}));const result=pendingOperations(storage(rows),current);expect(result.map(row=>row.to)).toEqual(['claims','delegation','invitations'].map(kind=>'/activities/..%2Factivity/'+kind+'/'+token));});
 it('excludes other accounts, preserved damaged copies, device authorizations and ordinary unsent drafts',()=>{const result=pendingOperations(storage({[root+'music:v1:'+other]:pending,[root+'activity-draft:v1:'+other+':new']:pending,[root+'music:v1:'+current+':recovery:123']:pending,[root+'device-link']:JSON.stringify({token:'PRIVATE_TOKEN'}),[root+'music:v1:'+current]:JSON.stringify({selections:[],revision:0}),[root+'activity-draft:lifecycle:v1:'+current+':e']:JSON.stringify({action:'start'})}),current);expect(result).toEqual([]);});
 it('retains damaged drafts as actionable entries and keeps standalone privacy, PIN and music recovery operations private',()=>{const rows={[root+'music:v1:'+current]:'broken raw private text',[root+'activity-draft:attendance:v1:'+current+':e']:JSON.stringify({pending:{key}}),[root+'privacy-pending:v1']:JSON.stringify({scope:current,input:{secret:'PRIVATE_SECRET'}}),[root+'admin-music-pin:v1:'+current+':'+authority+':p']:JSON.stringify({requestId:key}),[root+'music:claim:v1:'+current]:JSON.stringify({requestId:key,legacyQQ:'10001'})};const result=pendingOperations(storage(rows),current);expect(result).toHaveLength(5);expect(result.filter(row=>row.damaged)).toHaveLength(2);expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|private text/);expect(pendingOperations(storage({[root+'privacy-pending:v1']:JSON.stringify({scope:other,input:{}})}),current)).toEqual([]);expect(pendingOperations(storage({[root+'privacy-pending:v1']:'damaged PRIVATE_PRIVACY'}),current)).toEqual([{id:root+'privacy-pending:v1',label:'無法辨識帳號的刪除紀錄',to:'/me/privacy',damaged:true}]);});
 it('accepts original requestKey drafts without treating invalid keys as successfully recoverable',()=>{const result=pendingOperations(storage({[root+'music:v1:'+current]:JSON.stringify({requestKey:key}),[root+'account-profile:v1:'+current]:JSON.stringify({requestKey:'bad'})}),current);expect(result[0]).toMatchObject({requestKey:key,damaged:false});expect(result[1]).toMatchObject({damaged:true});});
});

describe('manual bot delivery recovery inventory',()=>{
 const prefix=root+'activity-draft:bot-delivery:v1:'+current+':';
 const raw=JSON.stringify({id:'1',key,input:{reviewToken:'d'.repeat(64),confirm:true}});
 it('keeps both original business routes and member receipts without exposing the command token',()=>{
  const paths=['/activities/listen/bot-deliveries','/time-polls/poll-exact/bot-deliveries'];
  const result=pendingOperations(storage(Object.fromEntries(paths.map(path=>[prefix+path,raw]))),current);
  expect(result).toEqual(paths.map(to=>({id:prefix+to,label:'群通知重送',to,requestKey:key,damaged:false})));
  expect(JSON.stringify(result)).not.toContain('d'.repeat(64));expect(result.every(row=>!row.adminScope)).toBe(true);
  expect(pendingOperations(storage({[prefix+paths[0]]:raw}),other)).toEqual([]);
 });
 it('omits null completion placeholders but preserves damaged original commands as actionable routes',()=>{
  const name=prefix+'/activities/listen/bot-deliveries';
  expect(pendingOperations(storage({[name]:'null'}),current)).toEqual([]);
  for(const value of ['PRIVATE_RAW',JSON.stringify({id:'1',key,input:{reviewToken:'bad',confirm:true}}),JSON.stringify({...JSON.parse(raw),url:'https://evil.example'})])
   expect(pendingOperations(storage({[name]:value}),current)).toEqual([{id:name,label:'群通知重送',to:'/activities/listen/bot-deliveries',damaged:true}]);
 });
 it('accepts canonical encoded IDs and rejects injected or noncanonical navigation',()=>{
  const path='/activities/'+encodeURIComponent('活動/a:b')+'/bot-deliveries';
  expect(botDeliveryDraftRoute(prefix+path,current)).toEqual({path,id:'活動/a:b',entity:'activity'});
  const paths=['https://evil.example','//evil.example/bot-deliveries','/activities/./bot-deliveries','/activities/../bot-deliveries','/activities/%2E/bot-deliveries','/activities/%2e%2e/bot-deliveries','/activities/%zz/bot-deliveries','/activities/%61/bot-deliveries','/activities/a%2fb/bot-deliveries','/activities/x/bot-deliveries?x=1','/activities/x/bot-deliveries#x','/activities/x/bot-deliveries/extra','/activities/'+('x'.repeat(81))+'/bot-deliveries'];
  for(const value of paths){expect(botDeliveryDraftRoute(prefix+value,current),value).toBeNull();expect(pendingOperations(storage({[prefix+value]:raw}),current),value).toEqual([]);}
  expect(botDeliveryDraftRoute(prefix+path,other)).toBeNull();expect(botDeliveryDraftRoute(prefix+path,'A'.repeat(64))).toBeNull();
 });
});

describe('activity view invitation recovery inventory',()=>{
 const prefix=root+'activity-draft:access:v1:'+current+':',token='x'.repeat(32),raw=JSON.stringify({key,input:{revision:7,confirm:true}});
 it('links to the original invitation and member receipt without exposing input fields or payload URLs',()=>{
  const name=prefix+'activity:'+token,to='/activities/activity/access/'+token;
  expect(pendingOperations(storage({[name]:raw}),current)).toEqual([{id:name,label:'活動查看邀請',to,damaged:false,requestKey:key}]);
  expect(pendingOperations(storage({[name]:raw}),other)).toEqual([]);
  expect(pendingOperations(storage({[name]:'null'}),current)).toEqual([]);
  expect(pendingOperations(storage({[name]:JSON.stringify({...JSON.parse(raw),url:'https://evil.example'})}),current)).toEqual([{id:name,label:'活動查看邀請',to,damaged:true}]);
 });
 it('escapes original IDs including colons and rejects malformed scope, token and path normalization segments',()=>{
  expect(activityAccessDraftRoute(prefix+'活動/a:b:'+token,current)).toEqual({id:'活動/a:b',token,path:'/activities/'+encodeURIComponent('活動/a:b')+'/access/'+token});
  for(const tail of [':'+token,'a:bad','a:'+token+':extra','.:'+token,'..:'+token,'x'.repeat(81)+':'+token,'\ud800:'+token]){
   expect(activityAccessDraftRoute(prefix+tail,current),tail).toBeNull();expect(pendingOperations(storage({[prefix+tail]:raw}),current)).toEqual([]);
  }
  expect(activityAccessDraftRoute(prefix+'activity:'+token,other)).toBeNull();
 });
 it('keeps damaged commands actionable while rejecting malformed original bodies',()=>{
  const name=prefix+'activity:'+token;
  for(const value of ['PRIVATE_DAMAGED',JSON.stringify({key,input:{revision:-1,confirm:true}}),JSON.stringify({key,input:{revision:1,confirm:false}})])
   expect(pendingOperations(storage({[name]:value}),current)).toEqual([{id:name,label:'活動查看邀請',to:'/activities/activity/access/'+token,damaged:true}]);
 });
});

describe('scoped shout recovery inventory',()=>{
 const prefix=root+'music:shout:v1:'+current+':',name=prefix+'2:profile',raw=JSON.stringify({text:'PRIVATE_TEXT',pending:{key,input:{profileId:'profile',musicEpoch:2,text:'PRIVATE_TEXT',confirm:true}}});
 it('shows only pending or damaged original commands at the fixed composer and uses member receipts',()=>{
  expect(pendingOperations(storage({[name]:raw}),current)).toEqual([{id:name,label:'發布找搭子',to:'/people/shouts',damaged:false,requestKey:key}]);
  expect(JSON.stringify(pendingOperations(storage({[name]:raw}),current))).not.toContain('PRIVATE_TEXT');
  expect(pendingOperations(storage({[name]:raw}),other)).toEqual([]);
  expect(pendingOperations(storage({[name]:JSON.stringify({text:'PRIVATE_UNSENT'})}),current)).toEqual([]);
  expect(pendingOperations(storage({[name]:'PRIVATE_DAMAGED'}),current)).toEqual([{id:name,label:'發布找搭子',to:'/people/shouts',damaged:true}]);
 });
 it('rejects noncanonical epochs and malformed or cross-account targets',()=>{
  expect(musicShoutDraftTarget(name,current)).toEqual({musicEpoch:2,profileId:'profile'});
  for(const tail of ['02:profile','-1:profile','1e2:profile','9007199254740992:profile','2:','2:profile:extra'])expect(musicShoutDraftTarget(prefix+tail,current)).toBeNull();
  expect(musicShoutDraftTarget(name,other)).toBeNull();
 });
 it('preserves inconsistent text, profile or epoch as damaged instead of silently substituting a new command',()=>{
  for(const patch of [{text:'other'}, {profileId:'other'}, {musicEpoch:3}]){
   const value=JSON.parse(raw);Object.assign(value.pending.input,patch);
   expect(()=>parseMusicShoutDraft(JSON.stringify(value),{musicEpoch:2,profileId:'profile'})).toThrow();
   expect(pendingOperations(storage({[name]:JSON.stringify(value)}),current)[0]?.damaged).toBe(true);
  }
 });
});


describe('safe music claim recovery pointers',()=>{
 const name=root+'music:claim:v1:'+current;
 it('retains the original claim and explicit action at a fixed route without generic receipts or QQ exposure',()=>{
  for(const action of [undefined,'finish','cancel']){
   const raw=JSON.stringify({requestId:key,legacyQQ:'10001',...(action?{action}:{})});
   expect(MusicRecoveryRecord.parse(JSON.parse(raw)).requestId).toBe(key);
   const result=pendingOperations(storage({[name]:raw}),current);
   expect(result).toEqual([{id:name,label:'找回舊成分',to:'/me/music/recover',damaged:false}]);
   expect(JSON.stringify(result)).not.toContain('10001');expect(pendingOperations(storage({[name]:raw}),other)).toEqual([]);
  }
  expect(pendingOperations(storage({[name]:'null'}),current)).toEqual([]);
 });
 it('rejects credentials and malformed pointers instead of restoring or exposing them',()=>{
  for(const patch of [{pin:'123456'},{digest:'PRIVATE_DIGEST'},{token:'PRIVATE_TOKEN'},{action:'start'},{requestId:'bad'},{legacyQQ:'123'}]){
   const value={requestId:key,legacyQQ:'10001',...patch};expect(MusicRecoveryRecord.safeParse(value).success).toBe(false);
   expect(pendingOperations(storage({[name]:JSON.stringify(value)}),current)).toEqual([{id:name,label:'找回舊成分',to:'/me/music/recover',damaged:true}]);
  }
 });
});
