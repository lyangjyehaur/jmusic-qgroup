import { z } from 'zod';
import { RoomLabSource,RoomLabResult,RoomLabRoomInput } from '@qgroup/contracts';
export const MusicRoomDraft=z.object({
 source:RoomLabSource,selected:z.array(z.string()).max(40),
 // Capacity may be temporarily invalid while editing; command validation remains strict.
 rooms:z.array(RoomLabRoomInput.extend({capacity:z.number()})).max(40),
 result:RoomLabResult.nullable(),mode:z.enum(['rooms','capacity','sizes']),value:z.string(),sizes:z.string(),sameGender:z.boolean(),
}).strict();
export type MusicRoomDraft=z.infer<typeof MusicRoomDraft>;
export function musicRoomDraftKey(scope:string,musicEpoch:number,eventId:string|null){
 return `qgroup:rebuild:music:room-lab:v2:${scope}:${musicEpoch}:`+(eventId===null?'free':'event:'+encodeURIComponent(eventId));
}
export function musicRoomDraftTarget(key:string,scope:string){
 const prefix='qgroup:rebuild:music:room-lab:v2:'+scope+':';
 if(!/^[a-f0-9]{64}$/.test(scope)||!key.startsWith(prefix))return null;
 const match=/^(0|[1-9][0-9]*):(free|event:(.+))$/.exec(key.slice(prefix.length));
 if(!match||!Number.isSafeInteger(Number(match[1])))return null;
 if(match[2]==='free')return {musicEpoch:Number(match[1]),eventId:null};
 try{const id=decodeURIComponent(match[3]!);if(!id||id.length>80||encodeURIComponent(id)!==match[3])return null;return {musicEpoch:Number(match[1]),eventId:id};}catch{return null;}
}
export function parseMusicRoomDraft(raw:string,eventId:string|null){
 const draft=MusicRoomDraft.parse(JSON.parse(raw));
 if(draft.source.eventId!==eventId)throw Error('分房原稿與原活動不符');
 return draft;
}
export function musicRoomLegacyKey(key:string,scope:string){const target=musicRoomDraftTarget(key,scope);return target?'qgroup:rebuild:room-lab:v1:'+scope+':'+(target.eventId??'free'):null;}
/** The old free/event key could collide. Never consume a recognizable other context. */
export function musicRoomLegacyMatches(raw:string,eventId:string|null){try{const value=JSON.parse(raw);return !value?.source||!Object.hasOwn(value.source,'eventId')||value.source.eventId===eventId;}catch{return true;}}
