import { describe,it,expect } from 'vitest';
import { musicRoomDraftKey,musicRoomDraftTarget,musicRoomLegacyKey,musicRoomLegacyMatches,parseMusicRoomDraft } from '../../web/src/music-room-record';
const scope='a'.repeat(64),other='b'.repeat(64);
const draft=(eventId:string|null)=>({source:{eventId,title:'PRIVATE_TITLE',sourceVersion:'c'.repeat(64),selfId:'me',revision:null,canAdopt:false,members:[]},selected:[],rooms:[],result:null,mode:'rooms',value:'2',sizes:'',sameGender:false});
describe('durable room lab context',()=>{
 it('separates free, event free, escaped IDs and music epochs without navigation normalization',()=>{
  for(const eventId of [null,'free','活動/a:b','..','%literal']){
   const key=musicRoomDraftKey(scope,3,eventId);expect(musicRoomDraftTarget(key,scope)).toEqual({musicEpoch:3,eventId});expect(musicRoomDraftTarget(key,other)).toBeNull();
   expect(musicRoomLegacyKey(key,scope)).toBe('qgroup:rebuild:room-lab:v1:'+scope+':'+(eventId??'free'));
  }
  expect(musicRoomDraftKey(scope,0,null)).not.toBe(musicRoomDraftKey(scope,0,'free'));
  for(const suffix of ['03:free','-1:free','1e2:free','9007199254740992:free','0:event:','0:event:%zz','0:event:%61','0:event:a%2fb','0:event:a:b','0:event:'+'x'.repeat(81)])expect(musicRoomDraftTarget('qgroup:rebuild:music:room-lab:v2:'+scope+':'+suffix,scope),suffix).toBeNull();
 });
 it('does not consume a recognizable legacy draft belonging to a colliding other context',()=>{
  expect(musicRoomLegacyMatches(JSON.stringify(draft(null)),'free')).toBe(false);expect(musicRoomLegacyMatches(JSON.stringify(draft('free')),null)).toBe(false);
  expect(musicRoomLegacyMatches(JSON.stringify(draft(null)),null)).toBe(true);expect(musicRoomLegacyMatches('{broken',null)).toBe(true);
  expect(()=>parseMusicRoomDraft(JSON.stringify(draft(null)),'free')).toThrow();
 });
 it('retains intermediate capacity errors for editing and rejects cross-context original snapshots',()=>{
  const value={...draft('a'),rooms:[{id:'00000000-0000-4000-8000-000000000001',capacity:0,members:['original-member']}]};
  expect(parseMusicRoomDraft(JSON.stringify(value),'a')).toEqual(value);expect(()=>parseMusicRoomDraft(JSON.stringify(value),'b')).toThrow();
 });
});
