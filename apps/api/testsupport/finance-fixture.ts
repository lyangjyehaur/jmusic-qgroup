import type { DB } from '@qgroup/database';
import { accountKey } from '../src/finance-context';
/** Synthetic ledger examples only, never bundled in the runtime. */
export function financeFixture(db:DB){for(const event of ['listen','karaoke']){
 const a=accountKey(event,'alice'),b=accountKey(event,'bob');
 for(const [id,user] of [['aaaaaaaaaaaaaaaa','alice'],['bbbbbbbbbbbbbbbb','bob']])db.prepare("INSERT INTO attendees(id,event_id,manager_id,user_id,name,payer_kind,status,created_at,updated_at) VALUES(?,?,?,?,?,'self','confirmed','before','before')").run(event==='listen'?id:'1'+id!.slice(1),event,user,user,user);
 const one='1111111111111111',two='2222222222222222',rooms=event==='karaoke'?[{id:one,name:'一房',payer_id:a,payer_name:'小青',payer_label:'小青'},{id:two,name:'二房',payer_id:a,payer_name:'小青',payer_label:'小青'}]:[];
 const ids=event==='listen'?['aaaaaaaaaaaaaaaa','bbbbbbbbbbbbbbbb']:['1aaaaaaaaaaaaaaa','1bbbbbbbbbbbbbbb'];
 const detail={input:{custom_payers:[]},collector:{id:a,name:'小青'},total_cents:1000,payers:[{id:a,name:'小青',label:'小青',amount_cents:500},{id:b,name:'小白',label:'小白',amount_cents:500}],people:[{id:ids[0],payments:[{payer_id:a,amount_cents:500}]},{id:ids[1],payments:[{payer_id:b,amount_cents:500}]}],rooms,items:rooms.map((room,i)=>({id:room.id,amount_cents:500,breakdown:[{person_id:ids[i]}]}))};
 db.prepare("INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,updated_at,actor_id,actor_name,kind,changed_fields) VALUES(?,1,1000,2,'','before','alice','小青','published','[]')").run(event);db.prepare('INSERT INTO settlement_details VALUES(?,1,?)').run(event,JSON.stringify(detail));
}}
export function financeHistoryFixture(db:DB){const payer=accountKey('past','alice'),payload=JSON.stringify({kind:'expense',amount_cents:1,payer_id:payer,funding:'payer',parties:[{id:payer,name:'小青',label:'小青'}],note:'歷史款項'});
 for(let i=1;i<=103;i++){db.prepare("INSERT INTO finance_entries(id,event_id,kind,payload_json,occurred_at,actor_id,actor_name,created_at) VALUES(?,'past','expense',?,'before','alice','小青','before')").run('e'+i.toString(16).padStart(15,'0'),payload);const id='f'+i.toString(16).padStart(15,'0');db.prepare("INSERT INTO finance_reports(id,event_id,reporter_id,reporter_name,payload_json,created_at) VALUES(?,'past','bob','小白',?,'before')").run(id,payload);db.prepare("INSERT INTO finance_report_actions(event_id,report_id,decision,actor_id,actor_name,reason,created_at) VALUES('past',?,'rejected','alice','小青','補原始單據','before')").run(id);}
 db.prepare("INSERT INTO finance_reports(id,event_id,reporter_id,reporter_name,payload_json,created_at) VALUES('ffffffffffffffff','past','bob','小白',?,'before')").run(payload);
}
