import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { openDatabase } from '@qgroup/database';
import { createHttpClient, HttpOperations } from '@qgroup/contracts/http';
import { checkHttpOperations, readHttpOperationSources, sharedSchemaCatalog } from '../../../tools/rebuild/build-http-contracts';
import { assertHttpOpenAPI, httpOpenAPI } from '../../../tools/rebuild/http-openapi';
import { createApp } from '../src/app';
import { hash } from '../src/security';
import { fixture } from './fixture';

const root=fileURLToPath(new URL('../../..',import.meta.url));
const cleanups:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});
function inventory(source:string){
 const directory=mkdtempSync(join(tmpdir(),'qgroup-path-source-'));cleanups.push(()=>rmSync(directory,{recursive:true,force:true}));
 mkdirSync(join(directory,'apps/api/src'),{recursive:true});writeFileSync(join(directory,'apps/api/src/routes.ts'),source);
 return readHttpOperationSources(directory);
}
it('binds all 104 parameterized operations and 131 decoded path values to their actual shared validators',async()=>{
 const rows=checkHttpOperations(root),catalog=sharedSchemaCatalog(),spec=httpOpenAPI(rows,catalog);
 expect(rows.filter(row=>row.params.length)).toHaveLength(104);
 expect(rows.reduce((count,row)=>count+(row.path.match(/:[^/]+/g)?.length??0),0)).toBe(131);
 expect(new Set(rows.flatMap(row=>row.params)).size).toBe(19);
 expect(spec['x-qgroup-path-validation-bound']).toBe(true);expect(spec['x-qgroup-permission-bindings-complete']).toBe(false);
 expect(Object.values(HttpOperations).every(row=>Object.isFrozen(row.params))).toBe(true);
 await expect(assertHttpOpenAPI(spec)).resolves.toBeUndefined();
 const version=catalog.schemas.PaymentHistoryPath as {properties:{version:Record<string,unknown>}};
 expect(version.properties.version).toMatchObject({type:'string','x-qgroup-number-coercion':'Number','x-qgroup-parsed-schema':{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER}});
});
it('keeps every validator reached through lexical helpers and generated history routes',()=>{
 const rows=inventory(`import { ActivityPath,PaymentHistoryPath } from '@qgroup/contracts/http-paths';
 function register(app){
  function access(request){return ActivityPath.parse(request.params).id;}
  for(const prefix of ['/api/v2/activities/:id','/api/events/:id'])app.get(prefix+'/settlement/history/:version/payment-code',request=>{access(request);return PaymentHistoryPath.parse(request.params);});
 }`);
 expect(rows).toHaveLength(1);expect(rows[0]!.params).toEqual(['ActivityPath','PaymentHistoryPath']);
});
it.each(['raw path read','inline path schema','missing validator','missing field','unattached helper','non-object schema'])('rejects %s instead of emitting a permissive path contract',mode=>{
 let source="import { ActivityPath,PaymentLibraryPath } from '@qgroup/contracts/http-paths';import { PaymentCodeId } from '@qgroup/contracts';";
 if(mode==='raw path read')source+="app.get('/api/v2/activities/:id',request=>request.params);";
 if(mode==='inline path schema')source+="app.get('/api/v2/activities/:id',request=>z.object({id:z.string()}).parse(request.params));";
 if(mode==='missing validator')source+="app.get('/api/v2/activities/:id',()=>({}));";
 if(mode==='missing field')source+="app.get('/api/v2/activities/:id',request=>PaymentLibraryPath.parse(request.params));";
 if(mode==='unattached helper')source+="app.get('/api/v2/session',()=>({}));function unused(request){return ActivityPath.parse(request.params);}";
 if(mode==='non-object schema')source+="app.get('/api/v2/activities/:id',request=>PaymentCodeId.parse(request.params));";
 expect(()=>inventory(source)).toThrow(Error);
});
it('validates Number coercion while preserving accepted version strings and delivery IDs in the encoded URL',async()=>{
 const urls:string[]=[],client=createHttpClient({fetch:async url=>{urls.push(String(url));return new Response('{}');}});
 for(const version of [' 1e0 ','0x1','+01','9007199254740991'])await client.requestRaw('GET /api/v2/activities/:id/settlement/history/:version',{params:{id:'合成/a?b',version}});
 await client.requestRaw('GET /api/v2/admin/bot/deliveries/:deliveryId',{params:{deliveryId:'9223372036854775807'}});
 expect(urls).toEqual(['%201e0%20','0x1','%2B01','9007199254740991'].map(v=>'/api/v2/activities/%E5%90%88%E6%88%90%2Fa%3Fb/settlement/history/'+v).concat('/api/v2/admin/bot/deliveries/9223372036854775807'));
});
it.each(['zero version','fractional version','overflow version','overflow delivery','malformed token','malformed profile','overlong identifier'])('rejects %s before transport',async mode=>{
 let calls=0;const client=createHttpClient({fetch:async()=>{calls++;return new Response('{}');}});
 let key:keyof typeof HttpOperations='GET /api/v2/activities/:id/settlement/history/:version',params:Record<string,string>={id:'listen',version:'0'};
 if(mode==='fractional version')params.version='1.5';
 if(mode==='overflow version')params.version='9007199254740992';
 if(mode==='overflow delivery'){key='GET /api/v2/admin/bot/deliveries/:deliveryId';params={deliveryId:'9223372036854775808'};}
 if(mode==='malformed token'){key='GET /api/v2/activities/:id/access/:token';params={id:'listen',token:'x'.repeat(31)};}
 if(mode==='malformed profile'){key='GET /api/v2/music/profiles/:id';params={id:'m_'+'x'.repeat(24)};}
 if(mode==='overlong identifier'){key='GET /api/v2/activities/:id';params={id:'x'.repeat(81)};}
 await expect(client.requestRaw(key,{params} as never)).rejects.toBeInstanceOf(z.ZodError);expect(calls).toBe(0);
});
it('preserves server validation, administrator priority and exact string lookup for delivery IDs',async()=>{
 const db=openDatabase(':memory:');fixture(db);const origin='https://path.example',key='synthetic-path-rescue-'+ 'x'.repeat(32);
 const app=createApp({db,origin,musicTrendSampling:false,pairedBackupScheduling:false,adminCredentialHash:()=>hash(key)});
 cleanups.push(async()=>{await app.close();db.close();});await app.ready();
 const unauthorized=await app.inject({url:'/api/v2/admin/bot/deliveries/not-a-number'});expect(unauthorized.statusCode).toBe(401);
 const session=await app.inject({url:'/api/v2/session'}),viewer=session.json();
 let cookie=String(session.headers['set-cookie']).split(';')[0]!;
 const headers={cookie,origin,'x-account-scope':viewer.scope,'x-csrf-token':viewer.csrf};
 const login=await app.inject({method:'POST',url:'/api/v2/admin/login',headers,payload:{key,confirm:true}});expect(login.statusCode).toBe(200);
 cookie+='; '+String(login.headers['set-cookie']).split(';')[0];headers.cookie=cookie;
 const invalid=await app.inject({url:'/api/v2/admin/bot/deliveries/9223372036854775808',headers});expect(invalid.statusCode).toBe(400);expect(invalid.json().code).toBe('INVALID_INPUT');
 const missing=await app.inject({url:'/api/v2/admin/bot/deliveries/9223372036854775807',headers});expect(missing.statusCode).toBe(404);expect(missing.json().code).toBe('BOT_DELIVERY_NOT_FOUND');
 for(const version of ['0','1.5','9007199254740992']){
  const invalid=await app.inject({url:'/api/v2/activities/listen/rooms/history/'+version});expect(invalid.statusCode).toBe(400);expect(invalid.json().code).toBe('INVALID_INPUT');
 }
 expect((await app.inject({url:'/api/v2/activities/listen/rooms/history/0x1'})).json().code).toBe('ROOM_PLAN_NOT_FOUND');
});
