import { Navigate, useSearchParams } from 'react-router-dom';
import { Activities } from './activities';
const actions=new Set(['join','conditions','settlement','finance','manage','onsite']);
/** Legacy bot cards select an event; opening one never executes the requested action. */
export function ActivityEntry(){
  const [search]=useSearchParams();const id=search.get('event');
  if(!id)return <Activities/>;
  const claim=search.get('claim');
  if(claim&&/^[A-Za-z0-9_-]{32}$/.test(claim))return <Navigate replace to={'/activities/'+encodeURIComponent(id)+'/claims/'+encodeURIComponent(claim)}/>;
  const invitation=search.get('attendee_invite');
  if(invitation&&/^[A-Za-z0-9_-]{32}$/.test(invitation))return <Navigate replace to={'/activities/'+encodeURIComponent(id)+'/invitations/'+encodeURIComponent(invitation)}/>;
  const action=search.get('action');const query=action&&actions.has(action)?'?'+new URLSearchParams({task:action}):'';
  return <Navigate replace to={'/activities/'+encodeURIComponent(id)+query}/>;
}
