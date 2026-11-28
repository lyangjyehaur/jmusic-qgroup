import { afterEach, expect, test } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { fixture } from '../testsupport/fixture';
import { createApp } from './app';
const cleanup:(()=>Promise<unknown>)[]=[];afterEach(async()=>{for(const close of cleanup.splice(0))await close();});
async function setup(clock=()=>new Date('2026-11-17T08:00:00Z')){const db=openDatabase(':memory:');fixture(db);const app=createApp({db,origin:'http://localhost:5080',now:clock});await app.ready();cleanup.push(async()=>{await app.close();db.close();});const cookie='kanban_session=fixture-alice',viewer=(await app.inject({url:'/api/v2/session',headers:{cookie}})).json();return{app,db,headers:{cookie,'x-account-scope':viewer.scope}};}
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

test.each(['scheduled','ongoing','ended'])('classifies under-minimum historical %s activities separately without changing actual lifecycle',async lifecycle=>{
 const {app,db,headers}=await setup();
 db.prepare("UPDATE events SET lifecycle=?,starts_at='2026-11-16T12:00:00+08:00',duration_hours=3,minimum_participants=2,formation_state='pending' WHERE id='listen'").run(lifecycle);
 db.exec("INSERT INTO attendees(id,event_id,manager_id,user_id,name,payer_kind,status,created_at,updated_at) VALUES('under-self','listen','alice','alice','本人','self','confirmed','before','before')");
 const tables=['events','attendees','settlements','finance_entries','event_audit','bot_outbox'];
 const snapshot=()=>Object.fromEntries(tables.map(table=>[table,db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()])),before=snapshot();
 const failed=(await app.inject('/api/v2/activities?period=history&status=unformed')).json();
 expect(failed.events.map((e:{id:string})=>e.id)).toEqual(['listen']);expect(failed.total).toBe(1);
 expect(failed.events[0]).toMatchObject({lifecycle,minimumParticipants:2,confirmed:1});
 expect((await app.inject('/api/v2/activities?period=history&status=ended')).json().events.map((e:{id:string})=>e.id)).not.toContain('listen');
 expect((await app.inject({url:'/api/v2/me/activities?status=unformed',headers})).json().events.map((e:{id:string})=>e.id)).toEqual(['listen']);
 expect(snapshot()).toEqual(before);
 db.exec("UPDATE events SET archived_at='before' WHERE id='listen'");
 for(const status of ['unformed','archived'])expect((await app.inject('/api/v2/activities?period=history&status='+status)).json().events.map((e:{id:string})=>e.id)).toContain('listen');
 db.exec("UPDATE events SET archived_at=NULL,lifecycle='cancelled' WHERE id='listen'");
 expect((await app.inject('/api/v2/activities?period=history&status=unformed')).json().events).toEqual([]);
 expect((await app.inject('/api/v2/activities?period=history&status=cancelled')).json().events.map((e:{id:string})=>e.id)).toContain('listen');
});

test('does not classify active or zero-minimum activities as unformed and uses only the confirmed roster at the end boundary',async()=>{
 let time=new Date('2026-11-17T07:59:59.999Z');const {app,db}=await setup(()=>time);
 db.exec("UPDATE events SET starts_at='2026-11-17T13:00:00+08:00',duration_hours=3,minimum_participants=2 WHERE id='listen'");
 for(const [id,status] of [['self','confirmed'],['guest','waiting'],['pending','tentative'],['left','withdrawn']])db.prepare("INSERT INTO attendees(id,event_id,manager_id,name,payer_kind,status,created_at,updated_at) VALUES(?,'listen','alice','','manager',?,'before','before')").run(id,status);
 expect((await app.inject('/api/v2/activities?status=unformed')).json().events).toEqual([]);
 time=new Date('2026-11-17T08:00:00Z');
 expect((await app.inject('/api/v2/activities?period=history&status=unformed')).json().events.map((e:{id:string})=>e.id)).toEqual(['listen']);
 db.exec("UPDATE attendees SET status='confirmed' WHERE id='guest'");
 expect((await app.inject('/api/v2/activities?period=history&status=unformed')).json().events).toEqual([]);
 expect((await app.inject('/api/v2/activities?period=history&status=ended')).json().events.map((e:{id:string})=>e.id)).toContain('listen');
 db.exec("UPDATE events SET minimum_participants=0 WHERE id='listen'; UPDATE attendees SET status='waiting' WHERE id='guest'");
 expect((await app.inject('/api/v2/activities?period=history&status=unformed')).json().events).toEqual([]);
});

test.each(["formation_state='confirmed'", "formation_state='formed'", "actual_started_at='2026-11-16T04:00:00Z'"])('retains a saved or manual formation decision after withdrawals: %s',async patch=>{
 const {app,db}=await setup();
 db.exec("UPDATE events SET starts_at='2026-11-16T04:00:00Z',duration_hours=3,minimum_participants=2,"+patch+" WHERE id='listen'");
 expect((await app.inject('/api/v2/activities?period=history&status=unformed')).json().events).toEqual([]);
 expect((await app.inject('/api/v2/activities?period=history&status=ended')).json().events.map((e:{id:string})=>e.id)).toContain('listen');
});

test.each(['scheduled','ongoing'])('moves an unsettled %s activity to history exactly at its planned end without mutating business records',async lifecycle=>{
 let time=new Date('2026-11-17T07:59:59.999Z');const {app,db,headers}=await setup(()=>time);
 db.prepare("UPDATE events SET lifecycle=?,starts_at='2026-11-17T13:00:00+08:00',duration_hours=3 WHERE id='listen'").run(lifecycle);
 const tables=['events','attendees','settlements','finance_entries','event_audit','bot_outbox'];
 const snapshot=()=>Object.fromEntries(tables.map(table=>[table,db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]));const before=snapshot();
 const ids=(result:{events:{id:string}[]})=>result.events.map(event=>event.id);
 expect(ids((await app.inject('/api/v2/activities')).json())).toContain('listen');
 expect(ids((await app.inject('/api/v2/activities?period=history')).json())).not.toContain('listen');
 time=new Date('2026-11-17T08:00:00Z');
 const upcoming=(await app.inject('/api/v2/activities')).json();expect(ids(upcoming)).toEqual(['karaoke']);expect(upcoming.summary.upcoming).toBe(1);
 const history=(await app.inject('/api/v2/activities?period=history&status=ended')).json();expect(ids(history)).toContain('listen');expect(history.events.find((event:{id:string})=>event.id==='listen')).toMatchObject({estimatedOver:true,phase:'ongoing',lifecycle});
 expect(ids((await app.inject('/api/v2/activities?status=ongoing')).json())).not.toContain('listen');
 const mine=(await app.inject({url:'/api/v2/me/activities?status=ended',headers})).json();expect(ids(mine)).toContain('listen');expect(mine.summary.upcoming).toBe(1);
 expect(snapshot()).toEqual(before);
 // Extending the arrangement moves it back without an explicit finish/settlement.
 db.exec("UPDATE events SET duration_hours=4 WHERE id='listen'");
 expect(ids((await app.inject('/api/v2/activities')).json())).toContain('listen');
 expect(ids((await app.inject('/api/v2/activities?period=history')).json())).not.toContain('listen');
});

test('uses planned end across midnight and explicit offsets whether a bill exists, before filtering and pagination',async()=>{
 const {app,db}=await setup();
 for(let i=0;i<25;i++)db.prepare("INSERT INTO events(id,owner_id,title,category,location,starts_at,deadline,capacity,description,created_at,duration_hours,timezone) SELECT ?,owner_id,?,'其他',location,'2026-11-17T00:00:00-05:00',deadline,capacity,description,created_at,3,'America/New_York' FROM events WHERE id='listen'").run('elapsed-'+String(i).padStart(2,'0'),'往期 '+i);
 db.prepare("INSERT INTO settlements(event_id,total_cents,headcount,note,updated_at) VALUES('elapsed-00',100,1,'已有帳單','before')").run();
 const history=(await app.inject('/api/v2/activities?period=history')).json();expect(history.total).toBe(26);expect(history.events).toHaveLength(20);expect(history.hasMore).toBe(true);expect(history.summary.upcoming).toBe(2);
 const second=(await app.inject('/api/v2/activities?period=history&page=2')).json();expect(second.events).toHaveLength(6);expect(second.hasMore).toBe(false);
 const result=(await app.inject('/api/v2/activities?period=history&q='+encodeURIComponent('往期 0'))).json();expect(result.events.map((event:{id:string})=>event.id)).toEqual(['elapsed-00']);
 expect((await app.inject('/api/v2/activities?q='+encodeURIComponent('往期'))).json().total).toBe(0);
 // The same instant represented as a cross-midnight UTC+8 activity is historical too.
 db.exec("UPDATE events SET starts_at='2026-11-16T23:00:00+08:00',duration_hours=5 WHERE id='listen'");
 expect((await app.inject('/api/v2/activities?period=history')).json().total).toBe(27);
 expect(db.prepare("SELECT lifecycle,actual_ended_at FROM events WHERE id='elapsed-00'").get()).toEqual({lifecycle:'scheduled',actual_ended_at:null});
});
