import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { legacyNavigation } from './legacy-navigation';
const token='a'.repeat(32),id='listen';
const resolve=(url:string)=>{const u=new URL(url,'https://example.test');return legacyNavigation(u.pathname,u.search,u.hash);};
const routes:Record<string,string>={detail:'/activities/listen',create:'/activities/new',mine:'/me/activities',join:'/activities/listen/signup',party:'/activities/listen/signup?preset=party',tentative:'/activities/listen/signup?preset=tentative',withdraw:'/activities/listen/registration?preset=withdraw',conditions:'/activities/listen/conditions',finance:'/activities/listen/finance',report:'/activities/listen/finance?preset=report#finance-operation',invite:'/activities/listen/invitations',claim:'/activities/listen/claims',management:'/activities/listen/delegation',manage:'/activities/listen/arrangements',copy:'/activities/new?copyFrom=listen',todos:'/inbox?event=listen',attendance:'/activities/listen/attendance',onsite:'/activities/listen/attendance?preset=onsite',settlement:'/activities/listen/settlement'};
describe('legacy links select explicit native workflows',()=>{
  it.each(Object.entries(routes))('maps the %s action', (action,to)=>expect(resolve('/?'+new URLSearchParams({...(!['mine','create'].includes(action)?{event:id}:{}),action}))).toEqual({kind:'redirect',to}));
  it('cross-checks the actual Python bot action and URL producers without starting any worker',()=>{
    const result=JSON.parse(execFileSync('python3',['-c',`import json
from qgroup_bot.replies import LINK_ACTIONS
from qgroup_core.bot_outbox import event_url
print(json.dumps({key:event_url('listen',action=value[0]) for key,value in LINK_ACTIONS.items()}))`],{encoding:'utf8'}));
    for(const url of Object.values(result) as string[]){const action=new URL(url).searchParams.get('action')!;expect(resolve(url),url).toEqual({kind:'redirect',to:routes[action]});}
  });
  it.each([['invite','access'],['attendee_invite','invitations'],['management_invite','delegation'],['claim','claims']])('preserves the %s token', (key,path)=>expect(resolve('/?event=listen&'+key+'='+token)).toEqual({kind:'redirect',to:'/activities/listen/'+path+'/'+token}));
  it('moves device tokens to the native fragment and QQ return to explicit confirmation',()=>{
    expect(resolve('/?account_link='+token)).toEqual({kind:'redirect',to:'/me/devices/accept#token='+token});expect(resolve('/?qq=return')).toEqual({kind:'redirect',to:'/auth/confirm'});
    expect(resolve('/index.html?event=listen')).toEqual({kind:'redirect',to:'/activities/listen'});
  });
  it.each(['event=listen&event=karaoke','event=listen&action=join&action=finance','event=listen&claim=x','event=listen&invite='+token+'&claim='+token,'event=listen&invite='+token+'&action=join','poll=x&event=listen','poll=x&action=join','account_link='+token+'&event=listen','qq=return&event=listen','action=join','action=close&event=listen','event=..','event=%2F%2Fevil.test','event=%00','event=','poll=','qq=no','action=create&event=listen'])('rejects ambiguous or malformed control parameters: %s',query=>expect(resolve('/?'+query)).toEqual({kind:'invalid'}));
  it.each(Object.entries({board:'/music',rest:'/music?library=all',matches:'/people',event:'/tools/room-lab?eventId=listen',room:'/tools/room-lab',shout:'/people/shouts',trend:'/music/trends',mine:'/me/music'}))('preserves old music section %s', (hash,to)=>{
    for(const path of ['/music/','/music/index.html','/music'])expect(resolve(path+'?event=listen#'+hash)).toEqual({kind:'redirect',to});
  });
  it('keeps native URLs and supports only explicit HTML/admin aliases',()=>{
    expect(resolve('/music?library=all')).toBeNull();expect(resolve('/activities/listen/signup')).toBeNull();expect(resolve('/?unrelated=ok')).toBeNull();
    expect(resolve('/music/#event')).toEqual({kind:'redirect',to:'/activities?task=rooms'});
    expect(resolve('/music/index.html')).toEqual({kind:'redirect',to:'/music'});
    expect(resolve('/music/admin.html')).toEqual({kind:'redirect',to:'/admin'});expect(resolve('/admin#music-links-section')).toEqual({kind:'redirect',to:'/admin/music'});
    expect(resolve('/music/privacy.html')).toEqual({kind:'redirect',to:'/privacy'});expect(resolve('/contact.html')).toEqual({kind:'redirect',to:'/contact'});
    expect(resolve('/unrecognised.html')).toBeNull();expect(resolve('/music/#delete')).toEqual({kind:'invalid'});
  });
  it('preserves all legacy handbook chapters and drops unrelated queries and unrecognized fragments',()=>{
    for(let chapter=1;chapter<=11;chapter++)expect(resolve('/guide.html?event=PRIVATE&token=SECRET#section-'+chapter)).toEqual({kind:'redirect',to:'/guide#section-'+chapter});
    expect(resolve('/guide.html#unknown')).toEqual({kind:'redirect',to:'/guide'});expect(resolve('/guide#music')).toBeNull();
  });
});
