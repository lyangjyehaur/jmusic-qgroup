import Database from 'better-sqlite3';
import {z} from 'zod';
import {copyForwardProofInput,openForwardProofSources,proofInputPins,type ForwardProofInput} from './forward-proof-source';
import {verifyForwardProofBundle} from './forward-proof-reconciliation';
import {assertForwardImage,forwardHash,type PinnedForwardBytes} from './forward-board-storage';

export type ForwardSourceRebaseInput={proofs:ForwardProofInput;proofImage:PinnedForwardBytes;rebasedAt:string};
export function copyForwardSourceRebaseInput(input:ForwardSourceRebaseInput){
  const proofs=copyForwardProofInput(input.proofs);z.iso.datetime().parse(input.rebasedAt);
  if(Date.parse(input.rebasedAt)<Date.parse(proofs.reconciledAt))throw Error('Source rebase predates proof reconciliation');
  const item=input.proofImage;if(!item||!Buffer.isBuffer(item.bytes)||!/^[a-f0-9]{64}$/.test(item.sha256)||forwardHash(item.bytes)!==item.sha256)throw Error('Source rebase proof pin differs');assertForwardImage(item.bytes);
  return {proofs,proofImage:{bytes:Buffer.from(item.bytes),sha256:item.sha256},rebasedAt:input.rebasedAt};
}
export const sourceRebasePins=(input:ForwardSourceRebaseInput)=>({...proofInputPins(input.proofs),proofImage:input.proofImage.sha256});
export function openForwardSourceRebase(input:ForwardSourceRebaseInput){
  verifyForwardProofBundle(input.proofs,{nativeImage:input.proofImage.bytes,nativeJournal:input.proofs.sources.nativeJournal.bytes,retainedBusinessImage:input.proofs.businessImage.bytes,musicSources:input.proofs.musicSources.bytes,identitySources:input.proofs.identitySources.bytes});
  const sources=openForwardProofSources(input.proofs);let proof:Database.Database|undefined,identity:Database.Database|undefined;
  try{proof=new Database(input.proofImage.bytes);identity=new Database(input.proofs.identitySources.bytes);return {sources,proof,identity,close(){identity!.close();proof!.close();sources.close();}};}catch(error){identity?.close();proof?.close();sources.close();throw error;}
}
