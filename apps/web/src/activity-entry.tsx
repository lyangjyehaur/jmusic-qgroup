import { Navigate, useSearchParams } from 'react-router-dom';
import { Activities } from './activities';
const actions=new Set(['join','conditions','settlement','finance','manage','onsite']);
/** Legacy bot cards select an event; opening one never executes the requested action. */
export function ActivityEntry(){
  const [search]=useSearchParams();const id=search.get('event');
  if(!id)return <Activities/>;
  const management=search.get('management_invite');
  if(management&&/^[A-Za-z0-9_-]{32}$/.test(management))return <Navigate replace to={'/activities/'+encodeURIComponent(id)+'/delegation/'+encodeURIComponent(management)}/>;
  const claim=search.get('claim');
  if(claim&&/^[A-Za-z0-9_-]{32}$/.test(claim))return <Navigate replace to={'/activities/'+encodeURIComponent(id)+'/claims/'+encodeURIComponent(claim)}/>;
  const invitation=search.get('attendee_invite');
  if(invitation&&/^[A-Za-z0-9_-]{32}$/.test(invitation))return <Navigate replace to={'/activities/'+encodeURIComponent(id)+'/invitations/'+encodeURIComponent(invitation)}/>;
  const action=search.get('action');
  if(action==='todos')return <Navigate replace to={'/inbox?'+new URLSearchParams({event:id})}/>;
  if(action==='onsite'||action==='attendance')return <Navigate replace to={'/activities/'+encodeURIComponent(id)+'/attendance'}/>;
  const query=action&&actions.has(action)?'?'+new URLSearchParams({task:action}):'';
  return <Navigate replace to={'/activities/'+encodeURIComponent(id)+query}/>;
}
