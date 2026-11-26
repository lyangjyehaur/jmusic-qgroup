import { useContext, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { InactivePageContext } from './discovery-dialog';

/** Match the legacy visible-detail refresh without remounting forms or writing data. */
export function useActivityDetailRefresh(id:string,scope:string|undefined,visible:boolean) {
  const client=useQueryClient(),inactive=useContext(InactivePageContext);
  useEffect(()=>{
    if(!scope||!visible||inactive)return;
    const refresh=()=>{
      if(document.visibilityState!=='visible')return;
      for(const key of ['activity','activity-roster','activity-registration','activity-lifecycle','activity-delegation','room-overview'])
        void client.refetchQueries({queryKey:['private',scope,key,id],type:'active'});
    };
    const timer=window.setInterval(refresh,30000);
    document.addEventListener('visibilitychange',refresh);
    return()=>{window.clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};
  },[client,id,scope,visible,inactive]);
}
