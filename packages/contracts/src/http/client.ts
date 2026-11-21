import { z } from 'zod';
import { ApiFailure } from '../index';
import { HttpOperations } from './operations.generated';
export { HttpOperations } from './operations.generated';

type Operation=typeof HttpOperations[keyof typeof HttpOperations];
type ParamNames<Path extends string>=Path extends `${string}:${infer Rest}`?Rest extends `${infer Name}/${infer Tail}`?Name|ParamNames<`/${Tail}`>:Rest:never;
type Params<D extends Operation>=ParamNames<D['path']> extends never?{params?:never}:{params:Record<ParamNames<D['path']>,string>};
type Body<D extends Operation>=D extends {body:infer S extends z.ZodType}?{body:z.input<S>}:{body?:never};
type RequestIdentity={requestId?:never;requestScope?:string}|{requestId:string;requestScope:string};
export type HttpInput<Key extends keyof typeof HttpOperations>=Params<typeof HttpOperations[Key]>&Body<typeof HttpOperations[Key]>&RequestIdentity&{
 query?:Readonly<Record<string,string|number|boolean|undefined>>;
 signal?:AbortSignal;
};
// Receipt namespaces can differ from the current device/account header scope.
export interface HttpContext {scope?:string;csrf?:string;adminCsrf?:string;receiptScope?:string}
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
 constructor(readonly status:number){super('回應資料尚未核對，請先確認操作結果再重試。');}
}
const object=(value:unknown)=>{
 if(value===null||typeof value!=='object'||Array.isArray(value))throw new TypeError('Invalid HTTP request input');
 return value as Record<string,unknown>;
};
function requestPath(path:string,input:Record<string,unknown>){
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
 return pathname+(query.size?'?'+query.toString():'');
}

/** Fixed same-origin routes and shared request-body schemas. The caller keeps
 * durable request IDs and pending outcomes; this transport never retries.
 * Query semantics, membership and authorization remain server-authoritative. */
export function createHttpClient(options:{fetch?:typeof fetch;context?:()=>HttpContext}={}){
 const send=options.fetch??globalThis.fetch;
 async function response<Key extends keyof typeof HttpOperations>(key:Key,input:HttpInput<Key>):Promise<Response>{
  if(!Object.hasOwn(HttpOperations,key))throw new TypeError('Unknown HTTP operation');
  const operation=HttpOperations[key],values=object(input);
  if(Object.keys(values).some(name=>!['params','query','body','requestId','requestScope','signal'].includes(name)))throw new TypeError('Unexpected HTTP request option');
  const url=requestPath(operation.path,values),headers=new Headers({Accept:'application/json'}),context=options.context?.()??{};
  if(values.requestId!==undefined||values.requestScope!==undefined){
   if(typeof values.requestScope!=='string'||!values.requestScope||values.requestScope!==(context.receiptScope??context.scope))throw new HttpScopeChangedError();
  }
  if(context.scope!==undefined)headers.set('x-account-scope',context.scope);
  if(context.csrf!==undefined)headers.set('x-csrf-token',context.csrf);
  if(context.adminCsrf!==undefined)headers.set('x-admin-csrf',context.adminCsrf);
  if(values.requestId!==undefined)headers.set('x-request-id',z.string().uuid().parse(values.requestId));
  let body:string|undefined;
  if('body' in operation){body=JSON.stringify(operation.body.parse(values.body));headers.set('Content-Type','application/json');}
  else if(Object.hasOwn(values,'body'))throw new TypeError('This HTTP operation has no request body');
  const result=await send(url,{method:operation.method,headers,body,signal:input.signal,credentials:'same-origin',redirect:'error'});
  if(!result.ok){
   let value:unknown;try{value=await result.json();}catch{throw new HttpProtocolError(result.status);}
   const failure=ApiFailure.safeParse(value);if(!failure.success)throw new HttpProtocolError(result.status);
   throw new HttpApiError(result.status,failure.data.code,failure.data.message,failure.data.messageDisplay);
  }
  return result;
 }
 return {
  async request<Key extends keyof typeof HttpOperations,T>(key:Key,input:HttpInput<Key>,schema:z.ZodType<T>):Promise<T>{
   const result=await response(key,input);let value:unknown;
   try{value=await result.json();}catch{throw new HttpProtocolError(result.status);}
   return schema.parse(value);
  },
  // Assets and attachment downloads keep their response stream; no JSON guess.
  requestRaw:response,
 };
}
