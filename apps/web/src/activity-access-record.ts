import { z } from 'zod';
import { AcceptActivityAccess } from '@qgroup/contracts';
export const PendingActivityAccess=z.object({key:z.string().uuid(),input:AcceptActivityAccess}).strict();
export type PendingActivityAccess=z.infer<typeof PendingActivityAccess>;
/** The original scoped key owns the destination; a saved payload cannot choose another URL. */
export function activityAccessDraftRoute(key:string,scope:string){
  if(!/^[a-f0-9]{64}$/.test(scope))return null;
  const prefix='qgroup:rebuild:activity-draft:access:v1:'+scope+':';
  if(!key.startsWith(prefix))return null;
  const target=key.slice(prefix.length),split=target.lastIndexOf(':'),id=target.slice(0,split),token=target.slice(split+1);
  if(split<1||id.length>80||id==='.'||id==='..'||!/^[A-Za-z0-9_-]{32}$/.test(token))return null;
  try{return {id,token,path:'/activities/'+encodeURIComponent(id)+'/access/'+token};}catch{return null;}
}
