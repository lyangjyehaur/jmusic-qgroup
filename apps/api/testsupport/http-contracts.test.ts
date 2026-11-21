import { it,expect,vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app';
import { openDatabase } from '@qgroup/database';
import { AuthResult,BotDeliveriesQuery,DeviceList,FinanceHistoryQuery,IssuedDeviceLink,Ok,PRIVACY_VERSION,Profile,SaveProfile,Session } from '@qgroup/contracts';
import { createHttpClient,HttpOperations,HttpResponses,type HttpContext } from '@qgroup/contracts/http';
import { checkHttpOperations,sharedSchemaCatalog } from '../../../tools/rebuild/build-http-contracts';

const observed=vi.hoisted(()=>new Set<string>());
vi.mock('fastify',async load=>{
 const original=await load<typeof import('fastify')>();
 return {...original,default:(options:import('fastify').FastifyServerOptions)=>{
  const app=original.default(options);app.addHook('onRoute',route=>{
   if(!route.url.startsWith('/api/v2/'))return;
   for(const method of Array.isArray(route.method)?route.method:[route.method])if(method!=='HEAD')observed.add(method+' '+route.url);
  });return app;
 }};
});
const root=fileURLToPath(new URL('../../..',import.meta.url));
it('matches every real v2 runtime operation and shared body to the generated contract index',async()=>{
 observed.clear();const db=openDatabase(':memory:'),app=createApp({db,origin:'https://fixture.invalid',musicTrendSampling:false,pairedBackupScheduling:false,adminCredentialHash:()=>'',publicAPIKeys:()=>''});
 try{
  await app.ready();const source=checkHttpOperations(root);
  expect([...observed].sort()).toEqual(Object.keys(HttpOperations).sort());expect(source).toHaveLength(195);
  expect(source.filter(row=>row.body)).toHaveLength(85);expect(source.map(row=>row.id).sort()).toEqual([...observed].sort());
  expect(source.filter(row=>row.query)).toHaveLength(48);expect(source.every(row=>row.query===null||typeof row.query==='string')).toBe(true);
  expect(Object.keys(HttpResponses).sort()).toEqual([...observed].sort());
  expect(source.filter(row=>row.response.kind==='json')).toHaveLength(188);
  expect(source.filter(row=>row.response.kind==='image')).toHaveLength(6);
  expect(source.filter(row=>row.response.kind==='download')).toHaveLength(1);
  expect(HttpResponses['GET /api/v2/me/music'].schema).toBe(Profile);
  expect(HttpOperations['GET /api/v2/admin/bot/deliveries'].query).toBe(BotDeliveriesQuery);
  expect(HttpOperations['GET /api/v2/activities/:id/finance'].query).toBe(FinanceHistoryQuery);
  expect(HttpOperations['PUT /api/v2/me/music'].body).toBe(SaveProfile);
 }finally{await app.close();db.close();}
});
it('exports all named schemas with wire semantics while retaining Zod refinement and server policy requirements',()=>{
 const catalog=sharedSchemaCatalog();expect(Object.keys(catalog.schemas)).toHaveLength(317);
 const profile=catalog.schemas.SaveProfile as {properties:{selections:{maxItems:number;uniqueItems?:boolean}},additionalProperties:boolean};
 expect(profile.additionalProperties).toBe(false);expect(profile.properties.selections.maxItems).toBe(20);expect(profile.properties.selections.uniqueItems).not.toBe(true);
 expect(SaveProfile.safeParse({profileId:null,musicEpoch:0,revision:0,selections:[{entryId:'e',level:1},{entryId:'e',level:2}]}).success).toBe(false);
 expect(catalog.zodRuntimeValidationRequired&&catalog.serverDomainValidationRequired).toBe(true);expect(catalog.openapiComplete).toBe(false);
 expect(catalog.successResponsesBound).toBe(true);expect(catalog.structuredDownloadSchemaBound).toBe(true);
 expect(catalog.responseSchemas).toHaveProperty('HttpMusicExport');
 expect(Object.keys(catalog.responseSchemas)).toHaveLength(128);
 const download=checkHttpOperations(root).find(row=>row.id==='GET /api/v2/admin/music-export');
 expect(download?.response).toMatchObject({kind:'download',schema:'HttpMusicExport'});
 expect(catalog.responseSchemas).toHaveProperty('HttpWebVersion');
});
it('uses the generated client with the real HTTP application through registration, session change, devices and stale-scope rejection',async()=>{
 const db=openDatabase(':memory:'),origin='https://fixture.invalid',app=createApp({db,origin,musicTrendSampling:false,pairedBackupScheduling:false,adminCredentialHash:()=>'',publicAPIKeys:()=>''});
 db.prepare('UPDATE site_settings SET allow_name_registration=1 WHERE id=1').run();
 let cookie='',context:HttpContext={},calls=0;
 const browserFetch:typeof fetch=async(url,init)=>{
  calls++;expect(init?.credentials).toBe('same-origin');expect(init?.redirect).toBe('error');
  const headers=new Headers(init?.headers);if(cookie)headers.set('cookie',cookie);if(init?.method!=='GET')headers.set('origin',origin);
  const r=await app.inject({url:String(url),method:init?.method as 'GET'|'POST',headers:Object.fromEntries(headers),payload:init?.body as string|undefined});
  const set=r.headers['set-cookie'];if(set)cookie=(Array.isArray(set)?set[0]!:String(set)).split(';')[0]!;
  return new Response(new Uint8Array(r.rawPayload),{status:r.statusCode,headers:{'content-type':String(r.headers['content-type']??'application/json')}});
 };
 const client=createHttpClient({fetch:browserFetch,context:()=>context});
 try{
  await app.ready();const initial=await client.request('GET /api/v2/session',{},Session);expect(initial.authenticated).toBe(false);context={scope:initial.scope,csrf:initial.csrf};
  const result=await client.request('POST /api/v2/auth/register-name',{body:{nickname:'合成測試帳號',confirm:true,acceptPrivacy:true,privacyVersion:PRIVACY_VERSION}},AuthResult);expect(result.newAccount).toBe(true);
  const member=await client.request('GET /api/v2/session',{},Session);expect(member.authenticated).toBe(true);expect(member.scope).not.toBe(initial.scope);context={scope:member.scope,csrf:member.csrf};
  const link=await client.request('POST /api/v2/me/devices/link',{body:{confirm:true,authorizeOwnDevice:true}},IssuedDeviceLink);expect(link.token).toHaveLength(32);
  const devices=await client.request('GET /api/v2/me/devices',{},DeviceList);expect(devices.devices).toHaveLength(1);expect(devices.devices[0]!.current).toBe(true);
  const history=await client.requestRaw('GET /api/v2/me/account-history',{query:{before:1}});expect(await history.json()).toEqual({history:[],nextCursor:null});
  const priorCalls=calls;await expect(client.requestRaw('GET /api/v2/me/account-history',{query:{before:0}})).rejects.toBeInstanceOf(Error);expect(calls).toBe(priorCalls);
  const invalid=await app.inject({url:'/api/v2/me/account-history?before=0',headers:{cookie,'x-account-scope':member.scope}});expect(invalid.statusCode).toBe(400);
  // Exercise the actual durable header protocol, including a lost-response retry.
  db.prepare("INSERT INTO music_entries(id,name,kind) VALUES('fixture-song','合成詞條','main')").run();
  const save={body:{profileId:null,musicEpoch:0,revision:0,selections:[{entryId:'fixture-song',level:1}]},requestId:'33333333-3333-4333-8333-333333333333',requestScope:member.scope};
  const saved=await client.request('PUT /api/v2/me/music',save,Profile);expect(saved).toMatchObject({revision:1});
  expect(await client.request('PUT /api/v2/me/music',save,Profile)).toEqual(saved);
  await expect(client.request('PUT /api/v2/me/music',{...save,body:{...save.body,selections:[{entryId:'fixture-song',level:2}]}},Profile)).rejects.toMatchObject({status:409,code:'REQUEST_CONFLICT'});
  expect(db.prepare('SELECT count(*) n FROM music_profile_audit').get()).toEqual({n:1});expect(db.prepare('SELECT count(*) n FROM request_results').get()).toEqual({n:1});
  await client.request('POST /api/v2/me/devices/revoke-link',{body:{confirm:true}},Ok);
  const before=calls;context={scope:'f'.repeat(64),csrf:member.csrf};
  await expect(client.request('GET /api/v2/me/devices',{},DeviceList)).rejects.toMatchObject({status:409,code:'ACCOUNT_CHANGED'});expect(calls).toBe(before+1);
  expect(db.prepare('SELECT count(*) n FROM users').get()).toEqual({n:1});
 }finally{await app.close();db.close();}
});
