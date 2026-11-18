import { afterEach,describe,it,expect,vi } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { createApp } from './app';
import { clientAddress } from './client-address';
const closers:(()=>Promise<void>)[]=[];afterEach(async()=>{for(const close of closers.splice(0))await close();vi.restoreAllMocks();});
async function setup(){const db=openDatabase(':memory:'),source={service:'web' as const,runtime:'typescript' as const,version:1 as const,commit:'a'.repeat(40),tree:'b'.repeat(40),source:'rehearsal' as const},app=createApp({db,origin:'https://fixture.example',runtimeInfo:source});await app.ready();closers.push(async()=>{await app.close();db.close();});return {app,db,source};}
describe('runtime health, version and loopback proxy',()=>{
 it('reads the actual database without creating identities, separates source from health, and fails closed on failed SQL',async()=>{
  const s=await setup(),before=s.db.prepare('SELECT * FROM users').all();for(const path of ['/api/health','/api/v2/health']){const r=await s.app.inject(path);expect(r.statusCode).toBe(200);expect(r.json()).toMatchObject({ok:true});expect(r.body).not.toContain(s.source.commit);expect(r.headers['set-cookie']).toBeUndefined();}
  expect((await s.app.inject('/api/v2/version')).json()).toEqual(s.source);expect(s.db.prepare('SELECT * FROM users').all()).toEqual(before);expect(s.db.prepare('SELECT * FROM browser_sessions').all()).toEqual([]);
  const prepare=s.db.prepare.bind(s.db);vi.spyOn(s.db,'prepare').mockImplementation(sql=>{if(sql==='SELECT 1 AS alive')throw Error('synthetic SQL read failure');return prepare(sql);});expect((await s.app.inject('/api/v2/health')).statusCode).toBe(503);
 });
 it('only accepts a single valid X-Real-IP from loopback, including mapped IPv4; forwarded chains and external peers cannot forge clients',()=>{
  const address=(peer:string,headers:Record<string,string|undefined>)=>clientAddress({raw:{socket:{remoteAddress:peer}},headers,ip:peer} as Parameters<typeof clientAddress>[0]);
  expect(address('127.0.0.1',{'x-real-ip':'192.0.2.1'})).toBe('192.0.2.1');expect(address('::ffff:127.0.0.1',{'x-real-ip':'2001:db8::1'})).toBe('2001:db8::1');
  for(const headers of [{'x-forwarded-for':'192.0.2.1'},{'x-real-ip':'192.0.2.1, 192.0.2.2'},{'x-real-ip':'192.0.2.1:99'},{'x-real-ip':'invalid'}])expect(address('::1',headers)).toBe('::1');expect(address('192.0.2.99',{'x-real-ip':'192.0.2.1','x-forwarded-for':'192.0.2.2'})).toBe('192.0.2.99');
 });
 it('keeps per-client rate limits through the loopback proxy and refuses rotating forged headers from external peers',async()=>{
  const s=await setup();for(let i=0;i<180;i++)expect((await s.app.inject({url:'/api/v2/health',remoteAddress:'127.0.0.1',headers:{'x-real-ip':'192.0.2.1'}})).statusCode).toBe(200);
  expect((await s.app.inject({url:'/api/v2/health',remoteAddress:'127.0.0.1',headers:{'x-real-ip':'192.0.2.1'}})).statusCode).toBe(429);expect((await s.app.inject({url:'/api/v2/health',remoteAddress:'127.0.0.1',headers:{'x-real-ip':'192.0.2.2'}})).statusCode).toBe(200);
  for(let i=0;i<180;i++)expect((await s.app.inject({url:'/api/v2/health',remoteAddress:'192.0.2.99',headers:{'x-real-ip':'198.51.100.'+(i%254+1)}})).statusCode).toBe(200);expect((await s.app.inject({url:'/api/v2/health',remoteAddress:'192.0.2.99',headers:{'x-real-ip':'192.0.2.100'}})).statusCode).toBe(429);
 });
});
