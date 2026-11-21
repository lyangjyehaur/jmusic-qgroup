import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AccountProfile, BotDeliveryResult, BotDeliveryReceipt, Ok } from '@qgroup/contracts';
import { HttpProtocolError } from '@qgroup/contracts/http';
import { createWebHttpClient } from './http';
import { ApiError } from './api';
import { errorText } from './language';
import { analyticsRequest } from './analytics';
vi.mock('./analytics', () => ({ analyticsRequest: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());
const key='11111111-1111-4111-8111-111111111111', scope='a'.repeat(64);
const input={body:{nickname:'新的稱呼',revision:0},requestId:key,requestScope:scope};

it('preserves durable nickname identity, current headers and response validation at the UI boundary',async()=>{
  let captured:RequestInit|undefined;
  const http=createWebHttpClient({context:()=>({scope,csrf:'csrf'}),fetch:async(url,init)=>{
    expect(url).toBe('/api/v2/me/profile');captured=init;
    return new Response(JSON.stringify({nickname:'新的稱呼',revision:1}));
  }});
  expect(await http.request('PUT /api/v2/me/profile',input,AccountProfile)).toEqual({nickname:'新的稱呼',revision:1});
  const headers=new Headers(captured!.headers);
  expect(headers.get('x-account-scope')).toBe(scope);expect(headers.get('x-csrf-token')).toBe('csrf');expect(headers.get('idempotency-key')).toBe(key);
  expect(JSON.parse(String(captured!.body))).toEqual(input.body);expect(captured!.credentials).toBe('same-origin');expect(captured!.redirect).toBe('error');
  expect(analyticsRequest).toHaveBeenCalledExactlyOnceWith('/api/v2/me/profile','PUT',200,'success');
});
it.each([401,403,409,429,503])('keeps %s errors recognizable by existing UI checks and preserves the server language pair',async status=>{
  let calls=0;
  const http=createWebHttpClient({context:()=>({scope}),fetch:async()=>{calls++;return new Response(JSON.stringify({code:'SYNTHETIC_REJECTION',message:'請核對',messageDisplay:{hans:'请核对',hant:'請核對'}}),{status});}});
  const error=await http.request('PUT /api/v2/me/profile',input,AccountProfile).catch(error=>error);
  expect(error).toBeInstanceOf(ApiError);expect(error).toMatchObject({status,code:'SYNTHETIC_REJECTION'});
  vi.stubGlobal('document',{documentElement:{lang:'zh-Hans'}});expect(errorText(error)).toBe('请核对');
  vi.stubGlobal('document',{documentElement:{lang:'zh-Hant'}});expect(errorText(error)).toBe('請核對');
  expect(calls).toBe(1);expect(analyticsRequest).toHaveBeenCalledExactlyOnceWith('/api/v2/me/profile','PUT',status,'rejected');
});
it.each(['unreadable success','wrong success shape','unreadable failure','wrong failure shape','network failure'])('keeps %s uncertain, without an ApiError rejection or an automatic second write',async mode=>{
  let calls=0;const network=new Error('synthetic network interruption'),json=new SyntaxError('synthetic unreadable JSON');
  const http=createWebHttpClient({context:()=>({scope}),fetch:async()=>{
    calls++;if(mode==='network failure')throw network;
    if(mode==='unreadable success')return Object.assign(new Response('{'),{json:async()=>{throw json;}});
    if(mode==='wrong success shape')return new Response('{"nickname":3}');
    const response=new Response(mode==='unreadable failure'?'{':'{}',{status:409});
    return mode==='unreadable failure'?Object.assign(response,{json:async()=>{throw json;}}):response;
  }});
  const error=await http.request('PUT /api/v2/me/profile',input,AccountProfile).catch(error=>error);
  expect(error).toBeInstanceOf(Error);expect(error).not.toBeInstanceOf(ApiError);expect(calls).toBe(1);
  if(mode==='network failure'){expect(error).toBe(network);expect(analyticsRequest).toHaveBeenCalledExactlyOnceWith('/api/v2/me/profile','PUT',0,'network_error');}
  else{expect(error).toBeInstanceOf(mode==='wrong success shape'?z.ZodError:mode.startsWith('unreadable')?SyntaxError:HttpProtocolError);expect(analyticsRequest).toHaveBeenCalledExactlyOnceWith('/api/v2/me/profile','PUT',mode.includes('failure')?409:200,'parse_error');}
  if(mode.startsWith('unreadable'))expect(error).toBe(json);
  if (mode !== 'network failure') {
    const unreadable=mode.startsWith('unreadable'),wrongShape=mode==='wrong success shape';
    // Literal display pairs are injected by the Vite build. Browser cases
    // verify both languages; unbuilt unit source retains canonical text.
    vi.stubGlobal('document',{documentElement:{lang:'zh-Hant'}});
    expect(errorText(error)).toBe(unreadable?'伺服器回應無法讀取，請先核對結果後重試。':wrongShape?'回應資料格式不符，請先核對結果後重試。':'回應資料尚未核對，請先確認操作結果再重試。');
  }
});
it('rejects a changed request scope before fetch and reports no server outcome',async()=>{
  let current=scope,calls=0;
  const http=createWebHttpClient({context:()=>({scope:current}),fetch:async()=>{calls++;return new Response('{}');}});
  current='b'.repeat(64);
  const error=await http.request('PUT /api/v2/me/profile',input,AccountProfile).catch(error=>error);
  expect(error).toBeInstanceOf(ApiError);expect(error).toMatchObject({status:409,code:'ACCOUNT_CHANGED'});expect(calls).toBe(0);expect(analyticsRequest).not.toHaveBeenCalled();
});
it('keeps rejected request validation out of transport statistics',async()=>{
  let calls=0;const http=createWebHttpClient({fetch:async()=>{calls++;return new Response('{}');}});
  await expect(http.request('GET /api/v2/admin/bot/deliveries',{query:{before:'9223372036854775808'}},Ok)).rejects.toBeInstanceOf(z.ZodError);
  expect(calls).toBe(0);expect(analyticsRequest).not.toHaveBeenCalled();
});
it('keeps concurrent response observations separate, including out-of-order completion',async()=>{
  let release!:(response:Response)=>void;
  const first=new Promise<Response>(resolve=>{release=resolve;});let calls=0;
  const http=createWebHttpClient({context:()=>({scope}),fetch:async()=>++calls===1?first:new Response(JSON.stringify({code:'LIMITED',message:'請稍後'}),{status:429})});
  const pending=http.request('PUT /api/v2/me/profile',input,AccountProfile);
  await expect(http.request('POST /api/v2/me/devices/revoke-link',{body:{confirm:true}},Ok)).rejects.toBeInstanceOf(ApiError);
  release(new Response(JSON.stringify({nickname:'新的稱呼',revision:1})));await pending;
  expect(vi.mocked(analyticsRequest).mock.calls).toEqual([['/api/v2/me/devices/revoke-link','POST',429,'rejected'],['/api/v2/me/profile','PUT',200,'success']]);
});
it('queries a bot receipt independently of retry submission, keeping the saved UUID and original content',async()=>{
  const calls:{url:string;init:RequestInit}[]=[];
  const result={originalId:'1',queuedId:'7',entity:'activity',entityId:'listen'};
  const http=createWebHttpClient({context:()=>({scope,csrf:'csrf'}),fetch:async(url,init)=>{calls.push({url:String(url),init:init!});return new Response(JSON.stringify(String(url).includes('bot-delivery-results')?{state:'completed',result}:result));}});
  const body={reviewToken:'c'.repeat(64),confirm:true as const};
  await http.request('POST /api/v2/activities/:id/bot-deliveries/:deliveryId/retry',{params:{id:'listen',deliveryId:'1'},body,requestId:key,requestScope:scope},BotDeliveryResult);
  expect(await http.request('GET /api/v2/bot-delivery-results/:requestId',{params:{requestId:key},requestScope:scope},BotDeliveryReceipt)).toEqual({state:'completed',result});
  expect(calls.map(call=>call.url)).toEqual(['/api/v2/activities/listen/bot-deliveries/1/retry','/api/v2/bot-delivery-results/'+key]);
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual(body);expect(new Headers(calls[0]!.init.headers).get('idempotency-key')).toBe(key);
  expect(calls[1]!.init.method).toBe('GET');expect(calls[1]!.init.body).toBeUndefined();expect(new Headers(calls[1]!.init.headers).has('idempotency-key')).toBe(false);
});
it('preserves the caller abort signal and binary response stream',async()=>{
  const controller=new AbortController(),bytes=new Uint8Array([137,80,78,71]);let captured:RequestInit|undefined;
  const http=createWebHttpClient({fetch:async(_url,init)=>{captured=init;return new Response(bytes,{headers:{'Content-Type':'image/png'}});}});
  const response=await http.requestRaw('GET /api/v2/appearance/walls/:id/image',{params:{id:'synthetic'},signal:controller.signal});
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);expect(captured!.signal).toBe(controller.signal);
});
