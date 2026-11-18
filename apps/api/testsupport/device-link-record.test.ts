import {describe,it,expect} from 'vitest';
import {DeviceLinkRecord,deviceSlot,deviceToken} from '../../web/src/device-link-record';
describe('bounded device credential records',()=>{
  const valid={token:'a'.repeat(32),capturedAt:10000,expiresAt:610000};
  it('retains exact URL-safe bearer or a token-free uncertain issuance marker for at most ten minutes',()=>{
    expect(DeviceLinkRecord.parse(valid)).toEqual(valid);expect(DeviceLinkRecord.parse({...valid,token:null})).toMatchObject({token:null});
    for(const patch of [{token:'bad'},{expiresAt:610001},{expiresAt:10000},{capturedAt:-1},{expiresAt:NaN},{scope:'not stored'}])expect(DeviceLinkRecord.safeParse({...valid,...patch}).success).toBe(false);
  });
  it('separates received credentials and each original issuer, rejects malformed scopes and tokens',()=>{
    expect(deviceSlot()).toBe('received');expect(deviceSlot('b'.repeat(64))).toBe('issued:'+'b'.repeat(64));expect(()=>deviceSlot('bad')).toThrow();
    expect(deviceToken('a'.repeat(32))).toBe(true);for(const token of [null,'a'.repeat(31),'a'.repeat(33),'../bad','a'.repeat(31)+'\n'])expect(deviceToken(token)).toBe(false);
  });
});
