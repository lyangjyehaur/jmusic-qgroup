import { z } from 'zod';
import { ApiFailure } from '../index';
import { HttpOperations } from './operations.generated';
export { HttpOperations } from './operations.generated';
import { HttpResponses, type HttpJsonKey, type HttpResult } from './responses';
export { HttpResponses } from './responses';
export type { HttpJsonKey, HttpResult } from './responses';

type Operation=typeof HttpOperations[keyof typeof HttpOperations];
type ParamNames<Path extends string>=Path extends `${string}:${infer Rest}`?Rest extends `${infer Name}/${infer Tail}`?Name|ParamNames<`/${Tail}`>:Rest:never;
type Params<D extends Operation>=ParamNames<D['path']> extends never?{params?:never}:{params:Record<ParamNames<D['path']>,string>};
type Body<D extends Operation>=D extends {body:infer S extends z.ZodType}?{body:z.input<S>}:{body?:never};
type QueryValue=string|number|boolean|undefined;
type WireQuery<S extends z.ZodType>={[K in keyof z.input<S>]:unknown extends z.input<S>[K]?QueryValue:z.input<S>[K]};
type Query<D extends Operation>=D extends {query:infer S extends z.ZodType}?{query?:WireQuery<S>}:{query?:Readonly<Record<string,QueryValue>>};
type RequestIdentity={requestId?:never;requestScope?:string}|{requestId:string;requestScope:string};
export type HttpInput<Key extends keyof typeof HttpOperations>=Params<typeof HttpOperations[Key]>&Body<typeof HttpOperations[Key]>&Query<typeof HttpOperations[Key]>&RequestIdentity&{
 signal?:AbortSignal;
 cache?:'no-store';
};
// Receipt namespaces can differ from the current device/account header scope.
export interface HttpContext {scope?:string;csrf?:string;adminCsrf?:string;adminScope?:string;receiptScope?:string}
export class HttpScopeChangedError extends Error {
 readonly code='ACCOUNT_CHANGED';
 constructor(){super('操作身分已變更，請核對原操作結果再繼續。');}
}
export class HttpApiError extends Error {
 readonly name='HttpApiError';
 constructor(readonly status:number,readonly code:string,message:string,readonly messageDisplay?:{hans:string;hant:string}){super(message);}
}
export class HttpProtocolError extends Error {
 readonly name='HttpProtocolError';
 constructor(readonly status:number,readonly reason:'unreadable-json'|'unverified'='unverified',options?:ErrorOptions){super('回應資料尚未核對，請先確認操作結果再重試。',options);}
}
const object=(value:unknown)=>{
 if(value===null||typeof value!=='object'||Array.isArray(value))throw new TypeError('Invalid HTTP request input');
 return value as Record<string,unknown>;
};
function requestPath(path:string,input:Record<string,unknown>,schema:z.ZodType|null){
 const names=[...path.matchAll(/:([^/]+)/g)].map(match=>match[1]!),params=object(input.params??{});
 if(Object.keys(params).sort().join(',')!==[...names].sort().join(','))throw new TypeError('HTTP route parameters differ');
 // Fetch normalizes whole dot segments, even when the dots are percent-encoded.
 for(const name of names)if(typeof params[name]!=='string'||params[name]===''||params[name]==='.'||params[name]==='..')throw new TypeError('Invalid HTTP route parameter');
 const pathname=path.replace(/:([^/]+)/g,(_,name:string)=>encodeURIComponent(params[name] as string)),query=new URLSearchParams();
 for(const [key,value] of Object.entries(object(input.query??{}))){
  if(value===undefined)continue;
  if(!['string','boolean','number'].includes(typeof value)||typeof value==='number'&&!Number.isFinite(value))throw new TypeError('Invalid HTTP query parameter');
  query.set(key,String(value));
 }
 // Validate the actual wire strings. Keep the caller's URL intact: server
 // defaults and transforms (including BigInt cursors) are not URL values.
 schema?.parse(Object.fromEntries(query));
 return pathname+(query.size?'?'+query.toString():'');
}

/** Fixed same-origin routes and shared request-body schemas. The caller keeps
 * durable request IDs and pending outcomes; this transport never retries.
 * Shared queries validate the wire; membership and authorization remain server-authoritative. */
export function createHttpClient(options:{fetch?:typeof fetch;context?:()=>HttpContext}={}){
 const send=options.fetch??globalThis.fetch;
 async function response<Key extends keyof typeof HttpOperations>(key:Key,input:HttpInput<Key>):Promise<Response>{
  if(!Object.hasOwn(HttpOperations,key))throw new TypeError('Unknown HTTP operation');
  const operation=HttpOperations[key],values=object(input);
  if(Object.keys(values).some(name=>!['params','query','body','requestId','requestScope','signal','cache'].includes(name)))throw new TypeError('Unexpected HTTP request option');
  if(values.cache!==undefined&&values.cache!=='no-store')throw new TypeError('Invalid HTTP cache option');
  const url=requestPath(operation.path,values,operation.query),headers=new Headers({Accept:'application/json'}),context=options.context?.()??{};
  if(values.requestId!==undefined||values.requestScope!==undefined){
   if(typeof values.requestScope!=='string'||!values.requestScope||values.requestScope!==(context.receiptScope??context.scope))throw new HttpScopeChangedError();
  }
  if(context.scope!==undefined)headers.set('x-account-scope',context.scope);
  if(context.csrf!==undefined)headers.set('x-csrf-token',context.csrf);
  if(context.adminCsrf!==undefined)headers.set('x-admin-csrf',context.adminCsrf);
  if(context.adminScope!==undefined)headers.set('x-admin-scope',context.adminScope);
  if(values.requestId!==undefined)headers.set('idempotency-key',z.string().uuid().parse(values.requestId));
  let body:string|undefined;
  if('body' in operation){body=JSON.stringify(operation.body.parse(values.body));headers.set('Content-Type','application/json');}
  else if(Object.hasOwn(values,'body'))throw new TypeError('This HTTP operation has no request body');
  const result=await send(url,{method:operation.method,headers,body,signal:input.signal,credentials:'same-origin',redirect:'error',...input.cache?{cache:input.cache}:{}});
  if(!result.ok){
   let value:unknown;try{value=await result.json();}catch(error){throw new HttpProtocolError(result.status,'unreadable-json',{cause:error});}
   const failure=ApiFailure.safeParse(value);if(!failure.success)throw new HttpProtocolError(result.status);
   throw new HttpApiError(result.status,failure.data.code,failure.data.message,failure.data.messageDisplay);
  }
  return result;
 }
 return {
  async requestContract<Key extends HttpJsonKey>(key:Key,input:HttpInput<Key>):Promise<HttpResult<Key>>{
   const binding=HttpResponses[key];
   if(!binding||binding.kind!=='json')throw new TypeError('This HTTP operation has no structured JSON response');
   const result=await response(key,input);let value:unknown;
   try{value=await result.json();}catch(error){throw new HttpProtocolError(result.status,'unreadable-json',{cause:error});}
   return binding.schema.parse(value) as HttpResult<Key>;
  },
  async request<Key extends keyof typeof HttpOperations,T>(key:Key,input:HttpInput<Key>,schema:z.ZodType<T>):Promise<T>{
   const result=await response(key,input);let value:unknown;
   try{value=await result.json();}catch(error){throw new HttpProtocolError(result.status,'unreadable-json',{cause:error});}
   return schema.parse(value);
  },
  // Assets and attachment downloads keep their response stream; no JSON guess.
  requestRaw:response,
 };
}
