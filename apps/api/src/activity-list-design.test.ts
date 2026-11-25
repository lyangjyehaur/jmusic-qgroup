import { afterEach, expect, test } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { fixture } from '../testsupport/fixture';
import { createApp } from './app';
const cleanup:(()=>Promise<unknown>)[]=[];afterEach(async()=>{for(const close of cleanup.splice(0))await close();});
async function setup(){const db=openDatabase(':memory:');fixture(db);const app=createApp({db,origin:'http://localhost:5080',now:()=>new Date('2026-11-17T08:00:00Z')});await app.ready();cleanup.push(async()=>{await app.close();db.close();});const cookie='kanban_session=fixture-alice',viewer=(await app.inject({url:'/api/v2/session',headers:{cookie}})).json();return{app,db,headers:{cookie,'x-account-scope':viewer.scope}};}
test('searches all authorized rows before pagination and returns global rather than current-page counts',async()=>{
 const {app,db,headers}=await setup();for(let i=0;i<25;i++)db.prepare("INSERT INTO events(id,owner_id,title,category,location,starts_at,deadline,capacity,description,created_at) SELECT ?,owner_id,?,'其他',?,starts_at,deadline,capacity,description,created_at FROM events WHERE id='listen'").run('listed-'+i,'可搜尋 '+i,'台南 '+i);
 const first=(await app.inject('/api/v2/activities')).json();expect(first.events).toHaveLength(20);expect(first.summary.upcoming).toBe(27);expect(first.total).toBe(27);expect(first.summary.mine).toBeNull();
 const search=(await app.inject('/api/v2/activities?q='+encodeURIComponent('台南 24'))).json();expect(search.events.map((e:{id:string})=>e.id)).toEqual(['listed-24']);expect(search.total).toBe(1);expect(search.summary.upcoming).toBe(27);
 const mine=(await app.inject({url:'/api/v2/me/activities?q='+encodeURIComponent('可搜尋'),headers})).json();expect(mine.events).toHaveLength(20);expect(mine.total).toBe(25);expect(mine.summary.mine).toBeGreaterThan(25);
});
test('keeps private, draft and deleted data out of public filters and isolates private counts to the scoped member',async()=>{
 const {app,db,headers}=await setup();const before=db.prepare('SELECT count(*) n FROM attendees').get();
 for(const q of ['私人活動','未發布活動','已刪活動']){const result=(await app.inject('/api/v2/activities?q='+encodeURIComponent(q))).json();expect(result.events).toEqual([]);expect(result.total).toBe(0);}
 const publicResult=(await app.inject('/api/v2/activities?status=draft')).json();expect(publicResult.events).toEqual([]);
 const privateResult=(await app.inject({url:'/api/v2/me/activities?status=draft',headers})).json();expect(privateResult.events.map((e:{id:string})=>e.id)).toContain('draft');
 expect((await app.inject({url:'/api/v2/me/activities',headers:{...headers,'x-account-scope':'wrong'}})).statusCode).toBe(409);
 expect((await app.inject('/api/v2/activities?status=bogus')).statusCode).toBe(400);expect((await app.inject('/api/v2/activities?q='+('x'.repeat(101)))).statusCode).toBe(400);expect(db.prepare('SELECT count(*) n FROM attendees').get()).toEqual(before);
});
test('distinguishes capacity, registration pause and actual lifecycle without changing candidates or state',async()=>{
 const {app,db}=await setup();db.exec("UPDATE events SET capacity=1 WHERE id='listen';INSERT INTO attendees(id,event_id,manager_id,user_id,name,payer_kind,status,created_at,updated_at) VALUES('full-self','listen','alice','alice','小青','self','confirmed','before','before')");
 expect((await app.inject('/api/v2/activities?status=full')).json().events.map((e:{id:string})=>e.id)).toEqual(['listen']);
 db.exec("UPDATE events SET registration_open=0 WHERE id='listen'");expect((await app.inject('/api/v2/activities?status=paused')).json().events.map((e:{id:string})=>e.id)).toContain('listen');
 expect((await app.inject('/api/v2/activities?status=full')).json().events).toEqual([]);
 expect((await app.inject('/api/v2/activities?period=history&status=ended')).json().events.map((e:{id:string})=>e.id)).toEqual(['past']);
 expect(db.prepare("SELECT status FROM attendees WHERE id='full-self'").get()).toEqual({status:'confirmed'});
});
