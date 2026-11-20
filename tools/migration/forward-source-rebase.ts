import {copyForwardSourceRebaseInput,openForwardSourceRebase,type ForwardSourceRebaseInput} from './forward-source-rebase-source';
import {rebaseForwardSourceRows} from './forward-source-rebase-rows';

/** Ordinary unbound sources cannot supersede an existing epoch. The complete
 * account-authority parent has a separate, fully verified source-chain entry. */
export function rebaseForwardSources(input:ForwardSourceRebaseInput,assertBoundary?:()=>void){
  const held=copyForwardSourceRebaseInput(input),s=openForwardSourceRebase(held);
  try{
    if(s.proof.prepare("SELECT 1 FROM music_documents WHERE kind='source_rebase'").get())throw Error('Source epoch already rebased; use a new independently verified source chain');
    return rebaseForwardSourceRows(input,s,assertBoundary);
  }finally{s.close();}
}
