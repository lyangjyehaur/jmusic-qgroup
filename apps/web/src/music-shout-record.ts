import { z } from 'zod';
import { PublishMusicShout } from '@qgroup/contracts';
export const MusicShoutDraft=z.object({text:z.string(),pending:z.object({key:z.string().uuid(),input:PublishMusicShout}).strict().optional()}).strict()
  .refine(value=>!value.pending||value.text===value.pending.input.text,{message:'original shout text'});
export type MusicShoutDraft=z.infer<typeof MusicShoutDraft>;
export function musicShoutDraftTarget(key:string,scope:string){
  if(!/^[a-f0-9]{64}$/.test(scope))return null;
  const prefix='qgroup:rebuild:music:shout:v1:'+scope+':';if(!key.startsWith(prefix))return null;
  const match=/^(0|[1-9][0-9]*):([^:]{1,80})$/.exec(key.slice(prefix.length));
  if(!match||!Number.isSafeInteger(Number(match[1])))return null;
  return {musicEpoch:Number(match[1]),profileId:match[2]!};
}
export function parseMusicShoutDraft(raw:string,target:{profileId:string;musicEpoch:number}){
  const draft=MusicShoutDraft.parse(JSON.parse(raw));
  if(draft.pending&&(draft.pending.input.profileId!==target.profileId||draft.pending.input.musicEpoch!==target.musicEpoch))throw Error('original shout profile');
  return draft;
}
