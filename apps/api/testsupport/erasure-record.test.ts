import { describe, expect, it } from 'vitest';
import { AdminErasure, MemberErasure, erasureKey, parseErasure } from '../../web/src/erasure-record';
const scope='a'.repeat(64),proof={requestId:'12345678-1234-4234-8234-123456789012',secret:'b'.repeat(64)};
const member={kind:'member' as const,scope,input:{...proof,target:'account' as const,confirm:true as const,profileId:null,profileRevision:0},result:null,cleaned:false};
const admin={kind:'admin' as const,scope,authority:'c'.repeat(64),path:'/admin/music-reset',input:{...proof,revision:'d'.repeat(64),confirm:'RESET' as const},result:null};
describe('dedicated erasure recovery records',()=>{
  it('retains strict proof and original account without allowing arbitrary draft payloads',()=>{
    expect(parseErasure('member',JSON.stringify(member))).toEqual(member);
    expect(()=>parseErasure('member',JSON.stringify({...member,password:'not accepted'}))).toThrow();
    expect(()=>parseErasure('member',JSON.stringify({...member,input:{...member.input,secret:'bad'}}))).toThrow();
    expect(()=>parseErasure('member',JSON.stringify({...member,cleaned:true}))).toThrow();
  });
  it('requires receipt UUID and exact member deletion target',()=>{
    const result={...proof,target:'account',status:'completed'};delete (result as Partial<typeof result>).secret;
    expect(MemberErasure.safeParse({...member,result,cleaned:true}).success).toBe(true);
    expect(MemberErasure.safeParse({...member,result:{...result,target:'both'}}).success).toBe(false);
    expect(MemberErasure.safeParse({...member,result:{...result,requestId:crypto.randomUUID()}}).success).toBe(false);
  });
  it('binds reset and per-profile deletion to canonical path, confirmation and receipt command',()=>{
    expect(parseErasure(erasureKey(admin),JSON.stringify(admin))).toEqual(admin);
    const result={requestId:proof.requestId,target:'admin_music',command:'reset_music',status:'completed',profiles:2,entries:3};
    expect(AdminErasure.safeParse({...admin,result}).success).toBe(true);
    for(const patch of [{input:{...admin.input,confirm:'DELETE'}},{path:'/admin/music/%6D/erase'},{path:'https://example.test/admin/music-reset'},{result:{...result,command:'delete_profile'}},{result:{...result,requestId:crypto.randomUUID()}}])expect(AdminErasure.safeParse({...admin,...patch}).success).toBe(false);
    expect(()=>parseErasure('admin:'+scope+':/admin/music/other/erase',JSON.stringify(admin))).toThrow();
  });
});
