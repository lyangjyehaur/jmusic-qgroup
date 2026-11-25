import { createContext, useContext, useEffect, type Dispatch, type SetStateAction } from 'react';
export type DiscoveryDetails={path:string;title:string;description?:string};
export const DiscoveryDetailsContext=createContext<{path:string;set:Dispatch<SetStateAction<DiscoveryDetails|null>>}|null>(null);
export function useDiscoveryDetails(title?:string,description?:string){
 const context=useContext(DiscoveryDetailsContext),path=context?.path,set=context?.set;
 useEffect(()=>{if(path&&set)set(title?{path,title,description}:null);},[path,set,title,description]);
}
