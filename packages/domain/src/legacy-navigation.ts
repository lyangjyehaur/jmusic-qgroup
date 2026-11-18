/** Old links select native workflows only; no URL ever authorizes a business write. */
export type LegacyNavigation = {kind:'redirect';to:string}|{kind:'invalid'}|null;
const validId=(id:string|null)=>!!id&&/^[A-Za-z0-9_-]{1,80}$/.test(id);
const validToken=(token:string|null)=>!!token&&/^[A-Za-z0-9_-]{32}$/.test(token);
const controls=['event','poll','action','invite','attendee_invite','management_invite','claim','account_link','qq'];
export function legacyNavigation(pathname:string,search:string,hash:string):LegacyNavigation{
  const params=new URLSearchParams(search),redirect=(to:string):LegacyNavigation=>({kind:'redirect',to}),invalid={kind:'invalid'} as const;
  const root=pathname==='/'||pathname==='/index.html';
  if(root){
    if(controls.some(key=>params.getAll(key).length>1))return invalid;
    const event=params.get('event'),poll=params.get('poll'),action=params.get('action');
    const tokens=['invite','attendee_invite','management_invite','claim','account_link'].filter(key=>params.has(key));
    if(tokens.length>1||(poll!==null&&(event!==null||tokens.length>0||action!==null))||(params.has('qq')&&(event!==null||poll!==null||tokens.length>0||action!==null)))return invalid;
    if(params.has('qq'))return params.get('qq')==='return'?redirect('/auth/confirm'):invalid;
    if(tokens[0]==='account_link')return event!==null||action!==null||!validToken(params.get('account_link'))?invalid:redirect('/me/devices/accept#token='+params.get('account_link'));
    if(poll!==null)return validId(poll)?redirect('/time-polls/'+poll):invalid;
    if(event!==null&&!validId(event))return invalid;
    if(tokens.length){
      const key=tokens[0]!,token=params.get(key);if(!event||!validToken(token)||action!==null)return invalid;
      const suffix={invite:'access',attendee_invite:'invitations',management_invite:'delegation',claim:'claims'}[key];
      return redirect('/activities/'+event+'/'+suffix+'/'+token);
    }
    if(action==='create')return event?invalid:redirect('/activities/new');
    if(action==='mine')return event?invalid:redirect('/me/activities');
    if(!event)return action!==null?invalid:pathname==='/index.html'?redirect('/activities'):null;
    const base='/activities/'+event;
    switch(action??'detail'){
      case 'detail':return redirect(base);
      case 'join':return redirect(base+'/signup');
      case 'party':case 'tentative':return redirect(base+'/signup?preset='+action);
      case 'withdraw':return redirect(base+'/registration?preset=withdraw');
      case 'conditions':case 'finance':case 'settlement':case 'attendance':return redirect(base+'/'+action);
      case 'report':return redirect(base+'/finance?preset=report#finance-operation');
      case 'invite':return redirect(base+'/invitations');
      case 'claim':return redirect(base+'/claims');
      case 'management':return redirect(base+'/delegation');
      case 'manage':return redirect(base+'/arrangements');
      case 'copy':return redirect('/activities/new?copyFrom='+event);
      case 'todos':return redirect('/inbox?event='+event);
      case 'onsite':return redirect(base+'/attendance?preset=onsite');
      default:return invalid;
    }
  }
  if(['/privacy.html','/music/privacy.html'].includes(pathname))return redirect('/privacy');
  if(pathname==='/guide.html')return redirect('/guide'+(/^#section-(?:[1-9]|10|11)$/.test(hash)?hash:''));
  if(['/contact.html'].includes(pathname))return redirect('/contact');
  if(['/music/admin','/music/admin.html'].includes(pathname))return redirect('/admin');
  if(pathname==='/admin'&&hash==='#music-links-section')return redirect('/admin/music');
  if(['/music','/music/','/music/index.html'].includes(pathname)){
    const section=hash.slice(1);if(pathname==='/music'&&!section)return null;
    if(params.getAll('event').length>1)return invalid;
    const event=params.get('event');if(event!==null&&!validId(event))return invalid;
    switch(section||'board'){
      case 'board':return redirect('/music');case 'rest':return redirect('/music?library=all');
      case 'matches':return redirect('/people');case 'event':return redirect(event?'/tools/room-lab?eventId='+event:'/activities?task=rooms');
      case 'room':return redirect('/tools/room-lab');case 'shout':return redirect('/people/shouts');
      case 'trend':return redirect('/music/trends');case 'mine':return redirect('/me/music');
      default:return invalid;
    }
  }
  return null;
}
