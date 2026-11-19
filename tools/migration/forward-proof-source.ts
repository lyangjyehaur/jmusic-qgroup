import Database from 'better-sqlite3';
import {z} from 'zod';
import {copyForwardMusicInput,musicBytes,openForwardMusicSources,type ForwardMusicInput} from './forward-music-sources';
import {assertForwardImage,forwardHash,type PinnedForwardBytes} from './forward-board-storage';
import {verifyForwardBusiness} from './forward-business-reconciliation';
import type {RollbackMusic} from './rollback-music';

export type ForwardProofInput={sources:ForwardMusicInput;businessImage:PinnedForwardBytes;musicSources:PinnedForwardBytes;identitySources:PinnedForwardBytes;reconstructedAt:string;reconciledAt:string};
export function copyForwardProofInput(input:ForwardProofInput){
  z.iso.datetime().parse(input.reconstructedAt);z.iso.datetime().parse(input.reconciledAt);
  if(Date.parse(input.reconciledAt)<Date.parse(input.reconstructedAt))throw Error('Forward proof reconciliation predates business reconstruction');
  const held={sources:copyForwardMusicInput(input.sources),reconstructedAt:input.reconstructedAt,reconciledAt:input.reconciledAt} as ForwardProofInput;
  for(const key of ['businessImage','musicSources','identitySources'] as const){const item=input[key];if(!item||!Buffer.isBuffer(item.bytes)||!/^[a-f0-9]{64}$/.test(item.sha256)||forwardHash(item.bytes)!==item.sha256)throw Error('Forward proof source pin differs');if(key==='musicSources'){if(item.bytes.length>64*1024*1024)throw Error('Forward proof music source exceeds limit');}else assertForwardImage(item.bytes);held[key]={bytes:Buffer.from(item.bytes),sha256:item.sha256};}
  return held;
}
export function proofInputPins(input:ForwardProofInput){return {...Object.fromEntries(Object.entries(input.sources).map(([key,item])=>[key,item.sha256])),businessImage:input.businessImage.sha256,musicSources:input.musicSources.sha256,identitySources:input.identitySources.sha256};}
export function openForwardProofSources(input:ForwardProofInput){
  const music=musicBytes(input.musicSources.bytes) as unknown as RollbackMusic;
  verifyForwardBusiness(input.sources,input.businessImage.bytes,music,input.identitySources.bytes,input.reconstructedAt);
  const original=openForwardMusicSources(input.sources);
  try{const business=new Database(input.businessImage.bytes);return {original,business,music,close(){business.close();original.close();}};}catch(error){original.close();throw error;}
}
export type ForwardProofSources=ReturnType<typeof openForwardProofSources>;
