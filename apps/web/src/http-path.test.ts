import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { HttpOperations } from '@qgroup/contracts/http';
import { AccountProfile, AdminMusicErasureResult, Ok, OperationReceipt } from '@qgroup/contracts';
import { resolveApiRequest, resolveHttpPath } from './http-path';
import { api, apiRaw, ApiError } from './api';
import { ApiError as BoundaryError } from './api-errors';
afterEach(() => vi.unstubAllGlobals());
const scope='a'.repeat(64), key='11111111-1111-4111-8111-111111111111';

it('resolves all current operations without confusing encoded parameters with another segment',()=>{
  const seen=new Set<string>();
  for(const [key,operation] of Object.entries(HttpOperations)){
    const params:Record<string,string>={};
    const path=operation.path.replace(/:([^/]+)/g,(_match,name:string)=>{
      const value=name+'-𠮷 /?=#';params[name]=value;return encodeURIComponent(value);
    });
    const resolved=resolveHttpPath(path,operation.method);
    expect(resolved).toEqual({key,params,query:{}});seen.add(resolved.key);
  }
  expect(seen.size).toBe(218);
});
it('resolves fixed routes and retains omitted defaults and BigInt query strings',()=>{
  expect(resolveHttpPath('/api/v2/me/activities').key).toBe('GET /api/v2/me/activities');
  expect(resolveHttpPath('/api/v2/activities').query).toEqual({});
  expect(resolveHttpPath('/api/v2/activities/listen/finance?before=9007199254740993&before_report=999999999999999999').query).toEqual({before:'9007199254740993',before_report:'999999999999999999'});
});
it.each(['absolute origin','protocol-relative origin','unknown operation','unknown method','fragment','backslash','control','empty parameter','dot segment','encoded parent segment','malformed encoding','repeated validated query'])('rejects %s before a transport route can be used',mode=>{
  let path='/api/v2/activities/listen',method='GET';
  if(mode==='absolute origin')path='https://outside.invalid/api/v2/session';
  if(mode==='protocol-relative origin')path='//outside.invalid/api/v2/session';
  if(mode==='unknown operation')path='/api/v2/unrecognized';
  if(mode==='unknown method')method='TRACE';
  if(mode==='fragment')path+='#private';
  if(mode==='backslash')path='/api/v2/activities/a\\b';
  if(mode==='control')path='/api/v2/activities/a\nb';
  if(mode==='empty parameter')path='/api/v2/activities/';
  if(mode==='dot segment')path='/api/v2/activities/.';
  if(mode==='encoded parent segment')path='/api/v2/activities/%2e%2e';
  if(mode==='malformed encoding')path='/api/v2/activities/%';
  if(mode==='repeated validated query')path='/api/v2/activities?page=1&page=2';
  expect(()=>resolveHttpPath(path,method)).toThrow(TypeError);
});
it('keeps ignored query fields ignored, including repeated fields',()=>{
  expect(resolveHttpPath('/api/v2/activities/listen?unused=one&unused=two')).toEqual({key:'GET /api/v2/activities/:id',params:{id:'listen'},query:{unused:'two'}});
});
it.each(['credentials override','redirect override','unexpected header','non-JSON body','wrong media type','wrong Accept','invalid JSON','forced cache'])('rejects %s at the existing caller boundary without fetch',async mode=>{
  let calls=0;vi.stubGlobal('fetch',async()=>{calls++;return new Response('{}');});
  const init:RequestInit={method:'PUT',headers:{'X-Account-Scope':scope,'Content-Type':'application/json'},body:JSON.stringify({nickname:'稱呼',revision:0})};
  if(mode==='credentials override')init.credentials='include';
  if(mode==='redirect override')init.redirect='follow';
  if(mode==='unexpected header')init.headers={'Authorization':'private'};
  if(mode==='non-JSON body')init.body=new URLSearchParams({nickname:'稱呼'});
  if(mode==='wrong media type')init.headers={'Content-Type':'text/plain'};
  if(mode==='wrong Accept')init.headers={'Accept':'text/html'};
  if(mode==='invalid JSON')init.body='{';
  if(mode==='forced cache')init.cache='force-cache';
  await expect(api('/me/profile',AccountProfile,init)).rejects.toBeInstanceOf(Error);expect(calls).toBe(0);
});
it('keeps all header forms, the original request identity and caller-owned body through the common transport',async()=>{
  const controller=new AbortController();let captured:RequestInit|undefined,called='';
  vi.stubGlobal('fetch',async(url:RequestInfo|URL,init?:RequestInit)=>{called=String(url);captured=init;return new Response(JSON.stringify({nickname:'原稱呼',revision:1}));});
  const body=JSON.stringify({nickname:'原稱呼',revision:0});
  await api('/me/profile',AccountProfile,{method:'PUT',headers:new Headers([['X-Account-Scope',scope],['X-CSRF-Token','csrf'],['Idempotency-Key',key],['Content-Type','application/json']]),body,signal:controller.signal});
  expect(called).toBe('/api/v2/me/profile');expect(captured!.body).toBe(body);expect(captured!.signal).toBe(controller.signal);
  const headers=new Headers(captured!.headers);expect(headers.get('idempotency-key')).toBe(key);expect(headers.get('x-account-scope')).toBe(scope);expect(headers.get('x-csrf-token')).toBe('csrf');
  expect(captured!.credentials).toBe('same-origin');expect(captured!.redirect).toBe('error');
});
it('preserves the original admin receipt namespace without adding write authority or a new request ID',async()=>{
  let captured:RequestInit|undefined;
  vi.stubGlobal('fetch',async(_url:RequestInfo|URL,init?:RequestInit)=>{captured=init;return new Response('{"committed":true}');});
  expect(await api('/admin/operations/'+key,OperationReceipt,{headers:[['X-Account-Scope',scope],['X-Admin-Scope','original-admin-scope']]})).toEqual({committed:true});
  const headers=new Headers(captured!.headers);expect(headers.get('x-admin-scope')).toBe('original-admin-scope');expect(headers.get('x-account-scope')).toBe(scope);expect(headers.has('x-admin-csrf')).toBe(false);expect(headers.has('idempotency-key')).toBe(false);
});
it('leaves erasure IDs and receipt secrets in the domain body, without manufacturing an idempotency header',async()=>{
  let captured:RequestInit|undefined;const body={requestId:key,secret:'b'.repeat(64)};
  vi.stubGlobal('fetch',async(_url:RequestInfo|URL,init?:RequestInit)=>{captured=init;return new Response('{}');});
  await expect(api('/admin/music-erasure/receipt',AdminMusicErasureResult,{method:'POST',headers:{'X-Account-Scope':scope,'X-CSRF-Token':'csrf','X-Admin-CSRF':'admin-csrf'},body:JSON.stringify(body)})).rejects.toBeInstanceOf(z.ZodError);
  expect(JSON.parse(String(captured!.body))).toEqual(body);expect(new Headers(captured!.headers).has('idempotency-key')).toBe(false);
});
it('shares the exact ApiError class with typed callers and keeps unreadable rejection responses uncertain',async()=>{
  expect(ApiError).toBe(BoundaryError);let calls=0;
  vi.stubGlobal('fetch',async()=>{calls++;return new Response(calls===1?JSON.stringify({code:'DENIED',message:'請核對'}):'{}',{status:403});});
  await expect(api('/admin/session',Ok,{headers:{'X-Account-Scope':scope}})).rejects.toBeInstanceOf(ApiError);
  const failure=await api('/admin/session',Ok,{headers:{'X-Account-Scope':scope}}).catch(error=>error);
  expect(failure).toBeInstanceOf(Error);expect(failure).not.toBeInstanceOf(ApiError);expect(calls).toBe(2);
});
it('uses actual shared query validation before fetch and preserves caller-owned replay data',async()=>{
  let calls=0;vi.stubGlobal('fetch',async()=>{calls++;return new Response('{}');});
  await expect(api('/admin/users?offset=-1',Ok)).rejects.toBeInstanceOf(z.ZodError);
  const original={method:'POST',headers:{'X-Account-Scope':scope,'Idempotency-Key':key},body:JSON.stringify({confirm:true})};
  const first=resolveApiRequest('/me/devices/revoke-link',original),second=resolveApiRequest('/me/devices/revoke-link',original);
  expect(second).toEqual(first);expect(first.input).toMatchObject({requestId:key,requestScope:scope,body:{confirm:true}});expect(calls).toBe(0);
});
it('retains successful binary streams, no-store and abort cancellation through the same transport',async()=>{
  const bytes=new Uint8Array([137,80,78,71]),controller=new AbortController();let captured:RequestInit|undefined;
  vi.stubGlobal('fetch',async(_url:RequestInfo|URL,init?:RequestInit)=>{captured=init;return new Response(bytes,{headers:{'Content-Type':'image/png'}});});
  const response=await apiRaw('/appearance/walls/w_'+'a'.repeat(24)+'/image',{signal:controller.signal,cache:'no-store'});
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);expect(captured!.signal).toBe(controller.signal);expect(captured!.cache).toBe('no-store');
});
