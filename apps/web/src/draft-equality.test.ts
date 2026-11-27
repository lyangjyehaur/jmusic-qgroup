import { describe, expect, it } from 'vitest';
import { normalizedRoomMembers, sameDraftValue, sameMusicSelections } from './draft-equality';
describe('draft equality',()=>{
 it('ignores object insertion order and absent optional properties, while preserving ordered form rows',()=>{
  expect(sameDraftValue({choices:{a:'yes',b:'no'},note:undefined},{choices:{b:'no',a:'yes'}})).toBe(true);
  expect(sameDraftValue({rooms:['a','b']},{rooms:['b','a']})).toBe(false);
  expect(sameDraftValue({amount:'1'},{amount:'01'})).toBe(false);
  expect(sameDraftValue({reason:'',source:{reviewRequired:true}},{reason:''})).toBe(false);
 });
 it('ignores checkbox insertion order inside a room while preserving room order and actual assignments',()=>{
  const rooms=[{id:'a',person_ids:['one','two']},{id:'b',person_ids:['three']}];
  expect(sameDraftValue(normalizedRoomMembers(rooms),normalizedRoomMembers([{id:'a',person_ids:['two','one']},rooms[1]!]))).toBe(true);
  expect(sameDraftValue(normalizedRoomMembers(rooms),normalizedRoomMembers([...rooms].reverse()))).toBe(false);
  expect(sameDraftValue(normalizedRoomMembers(rooms),normalizedRoomMembers([{id:'a',person_ids:['one']},rooms[1]!]))).toBe(false);
  expect(rooms[0]!.person_ids).toEqual(['one','two']);
 });
 it('treats music selections as a set of IDs and levels, without masking a changed level or duplicate entry',()=>{
  const saved=[{entryId:'a',level:4},{entryId:'b',level:3}];
  expect(sameMusicSelections([...saved].reverse(),saved)).toBe(true);
  expect(sameMusicSelections([{entryId:'b',level:4},saved[0]!],saved)).toBe(false);
  expect(sameMusicSelections([saved[0]!,saved[0]!],saved)).toBe(false);
  expect(sameMusicSelections([],saved)).toBe(false);
 });
});
