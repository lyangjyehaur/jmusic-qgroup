import { it,expect } from 'vitest';
import { z } from 'zod';
import { createHttpClient,HttpApiError,HttpOperations,HttpProtocolError,HttpScopeChangedError,type HttpInput } from './client';
import { Confirm,Ok,PRIVACY_VERSION,RegisterName } from '../index';

it('uses a fixed operation with normalized shared body, current context and a durable caller request ID',async()=>{
 let scope='a'.repeat(64);const calls:{url:string;init:RequestInit}[]=[];
 const client=createHttpClient({context:()=>({scope,csrf:'b'.repeat(64),adminCsrf:'c'.repeat(64)}),fetch:async(url,init)=>{calls.push({url:String(url),init:init!});return new Response('{"ok":true}');}});
 const input:HttpInput<'POST /api/v2/auth/register-name'>={body:{nickname:'  測試使用者  ',confirm:true as const,acceptPrivacy:true as const,privacyVersion:PRIVACY_VERSION},requestId:'11111111-1111-4111-8111-111111111111',requestScope:scope};
 await client.request('POST /api/v2/auth/register-name',input,Ok);scope='d'.repeat(64);
 await expect(client.request('POST /api/v2/auth/register-name',input,Ok)).rejects.toBeInstanceOf(HttpScopeChangedError);expect(calls).toHaveLength(1);
 await client.request('POST /api/v2/auth/register-name',{...input,requestId:'22222222-2222-4222-8222-222222222222',requestScope:scope},Ok);
 expect(calls).toHaveLength(2);expect(calls[0]!.url).toBe('/api/v2/auth/register-name');
 expect(calls[0]!.init.credentials).toBe('same-origin');expect(calls[0]!.init.redirect).toBe('error');expect(calls[0]!.init.method).toBe('POST');
 expect(JSON.parse(String(calls[0]!.init.body))).toEqual(RegisterName.parse(input.body));
 expect(new Headers(calls[0]!.init.headers).get('idempotency-key')).toBe(input.requestId);
 expect(new Headers(calls[0]!.init.headers).get('x-account-scope')).toBe('a'.repeat(64));expect(new Headers(calls[1]!.init.headers).get('x-account-scope')).toBe('d'.repeat(64));
});
it('encodes route values and query values without letting them add a path or override options',async()=>{
 const calls:string[]=[];const client=createHttpClient({fetch:async url=>{calls.push(String(url));return new Response('{"ok":true}');}});
 await client.request('GET /api/v2/activities/:id',{params:{id:'x/y?z=1#fragment'},query:{page:2,search:'a&b=c',unset:undefined}},Ok);
 expect(calls).toEqual(['/api/v2/activities/x%2Fy%3Fz%3D1%23fragment?page=2&search=a%26b%3Dc']);
});
it.each(['unknown operation','missing parameter','extra parameter','empty parameter','current directory parameter','parent directory parameter','body on read','extra request option','invalid body','Unicode name length','missing confirmation','non-finite query','array query','invalid durable ID'])('rejects %s before any transport call',async change=>{
 let count=0;const client=createHttpClient({context:()=>({scope:'a'.repeat(64)}),fetch:async()=>{count++;return new Response('{"ok":true}');}});
 let key:string='GET /api/v2/activities/:id',input:unknown={params:{id:'synthetic'}};
 if(change==='unknown operation')key='GET /api/v2/does-not-exist';
 if(change==='missing parameter')input={};
 if(change==='extra parameter')input={params:{id:'synthetic',token:'extra'}};
 if(change==='empty parameter')input={params:{id:''}};
 if(change==='current directory parameter')input={params:{id:'.'}};
 if(change==='parent directory parameter')input={params:{id:'..'}};
 if(change==='body on read')input={params:{id:'synthetic'},body:{}};
 if(change==='extra request option')input={params:{id:'synthetic'},method:'POST'};
 if(change==='invalid body'){key='POST /api/v2/me/devices/revoke-link';input={body:{confirm:true,unrecognized:true}};}
 if(change==='Unicode name length'){key='POST /api/v2/auth/register-name';input={body:{nickname:'𠮷'.repeat(25),confirm:true,acceptPrivacy:true,privacyVersion:PRIVACY_VERSION}};}
 if(change==='missing confirmation'){key='POST /api/v2/me/devices/revoke-link';input={body:{}};}
 if(change==='non-finite query')input={params:{id:'synthetic'},query:{page:Infinity}};
 if(change==='array query')input={params:{id:'synthetic'},query:[]};
 if(change==='invalid durable ID')input={params:{id:'synthetic'},requestId:'moving',requestScope:'a'.repeat(64)};
 await expect(client.request(key as keyof typeof HttpOperations,input as never,Ok)).rejects.toBeInstanceOf(Error);expect(count).toBe(0);
});
it.each([400,403,409,500,503])('preserves a %s rejection and language pair without retrying or interpreting it as a committed result',async status=>{
 let count=0;const client=createHttpClient({fetch:async()=>{count++;return new Response(JSON.stringify({code:'SYNTHETIC_FAILURE',message:'請核對',messageDisplay:{hans:'请核对',hant:'請核對'},privateDiagnostic:'not exposed'}),{status});}});
 let failure:unknown;try{await client.request('POST /api/v2/me/devices/revoke-link',{body:{confirm:true}},Ok);}catch(error){failure=error;}
 expect(failure).toBeInstanceOf(HttpApiError);expect(failure).toMatchObject({status,code:'SYNTHETIC_FAILURE',messageDisplay:{hans:'请核对',hant:'請核對'}});expect(failure).not.toHaveProperty('privateDiagnostic');expect(count).toBe(1);
});
it.each(['invalid success JSON','invalid error JSON','invalid error shape','invalid success shape','network failure'])('keeps %s unverified without replay',async mode=>{
 let count=0;const network=new Error('synthetic transport interruption');
 const client=createHttpClient({fetch:async()=>{count++;if(mode==='network failure')throw network;if(mode==='invalid success JSON')return new Response('<html>');if(mode==='invalid error JSON')return new Response('<html>',{status:502});if(mode==='invalid error shape')return new Response('{}',{status:409});return new Response('{"ok":false}');}});
 const promise=client.request('POST /api/v2/me/devices/revoke-link',{body:{confirm:true}},Ok);
 if(mode==='network failure')await expect(promise).rejects.toBe(network);
 else if(mode==='invalid success shape')await expect(promise).rejects.toBeInstanceOf(z.ZodError);
 else await expect(promise).rejects.toBeInstanceOf(HttpProtocolError);
 expect(count).toBe(1);
});
it('keeps binary streams, the caller signal and caller-owned request identifiers intact',async()=>{
 const bytes=new Uint8Array([137,80,78,71]),controller=new AbortController();let captured:RequestInit|undefined;
 const client=createHttpClient({fetch:async(url,init)=>{captured=init;return String(url).includes('/appearance/')?new Response(bytes,{headers:{'content-type':'image/png'}}):new Response('{"ok":true}');}});
 const response=await client.requestRaw('GET /api/v2/appearance/walls/:id/image',{params:{id:'synthetic-wall'},signal:controller.signal});expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
 expect(captured!.signal).toBe(controller.signal);
 await client.request('POST /api/v2/me/devices/revoke-link',{body:{confirm:true}},Ok);expect(new Headers(captured!.headers).has('idempotency-key')).toBe(false);
 expect(Confirm.safeParse({confirm:true,unexpected:1}).success).toBe(false);
});
it('pins a separate receipt namespace without substituting it for the account or CSRF headers',async()=>{
 let captured:RequestInit|undefined;const client=createHttpClient({context:()=>({scope:'account-scope',receiptScope:'original-receipt-scope',csrf:'csrf',adminCsrf:'admin-csrf'}),fetch:async(_url,init)=>{captured=init;return new Response('{"ok":true}');}});
 await client.request('POST /api/v2/admin/music/:id/pin',{params:{id:'synthetic'},body:{pin:'1234',revision:0,reason:'synthetic verification',confirm:true},requestId:'11111111-1111-4111-8111-111111111111',requestScope:'original-receipt-scope'},Ok);
 const headers=new Headers(captured!.headers);expect(headers.get('x-account-scope')).toBe('account-scope');expect(headers.get('x-csrf-token')).toBe('csrf');expect(headers.get('x-admin-csrf')).toBe('admin-csrf');
});
it('keeps generated routing metadata immutable',()=>{
 expect(Object.isFrozen(HttpOperations)).toBe(true);const operation=HttpOperations['GET /api/v2/session'];
 expect(Object.isFrozen(operation)).toBe(true);expect(Reflect.set(operation,'path','https://other.invalid')).toBe(false);expect(operation.path).toBe('/api/v2/session');
});
it('validates query wire values without rewriting server defaults, whitespace or BigInt cursors',async()=>{
 const calls:string[]=[];const client=createHttpClient({fetch:async url=>{calls.push(String(url));return new Response('{"ok":true}');}});
 await client.request('GET /api/v2/activities',{query:{page:2,period:'history'}},Ok);
 await client.request('GET /api/v2/activities',{},Ok);
 await client.request('GET /api/v2/activities/:id/finance',{params:{id:'synthetic'},query:{before:'9007199254740993',before_report:'999999999999999999'}},Ok);
 await client.request('GET /api/v2/admin/users',{query:{search:'  𠮷  '}},Ok);
 expect(calls).toEqual(['/api/v2/activities?page=2&period=history','/api/v2/activities','/api/v2/activities/synthetic/finance?before=9007199254740993&before_report=999999999999999999','/api/v2/admin/users?search=++%F0%A0%AE%B7++']);
});
it.each(['zero page','page limit','wrong period','zero account cursor','zero finance cursor','overflow bot cursor','wrong bot status','unexpected empty-query field','unexpected page field','Unicode search limit'])('rejects %s query before transport',async mode=>{
 let count=0;const client=createHttpClient({fetch:async()=>{count++;return new Response('{"ok":true}');}});let key:string='GET /api/v2/activities',input:unknown={query:{page:0}};
 if(mode==='page limit')input={query:{page:10001}};
 if(mode==='wrong period')input={query:{period:'active'}};
 if(mode==='zero account cursor'){key='GET /api/v2/me/account-history';input={query:{before:0}};}
 if(mode==='zero finance cursor'){key='GET /api/v2/activities/:id/finance';input={params:{id:'synthetic'},query:{before:'0'}};}
 if(mode==='overflow bot cursor'){key='GET /api/v2/admin/bot/deliveries';input={query:{before:'9223372036854775808'}};}
 if(mode==='wrong bot status'){key='GET /api/v2/admin/bot/deliveries';input={query:{status:'simulated'}};}
 if(mode==='unexpected empty-query field'){key='GET /api/v2/admin/bot';input={query:{unrecognized:'1'}};}
 if(mode==='unexpected page field')input={query:{unrecognized:'1'}};
 if(mode==='Unicode search limit'){key='GET /api/v2/admin/users';input={query:{search:'𠮷'.repeat(101)}};}
 await expect(client.request(key as keyof typeof HttpOperations,input as never,Ok)).rejects.toBeInstanceOf(z.ZodError);expect(count).toBe(0);
});
