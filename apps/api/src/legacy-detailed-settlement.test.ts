import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { SettlementInput } from '@qgroup/contracts';
import { fixture } from '../testsupport/fixture';
import { createApp } from './app';
import { eventRow } from './activity-arrangements';
import { accountKey } from './finance-context';
import { calculateSettlement, settlementToken } from './settlement-calculation';
import { originalRequestSignature } from './legacy-local';
import { decodeLegacyDetailedSettlement } from '@qgroup/contracts';
import { settlementDetail } from './settlement-context';
import { testPNG } from '../testsupport/payment-fixture';
const origin = 'https://rebuild.example',
  stamp = '2026-11-17T00:00:00+00:00',
  a = accountKey('listen', 'alice'),
  b = accountKey('listen', 'bob'),
  p1 = 'aaaaaaaaaaaaaaaa',
  p2 = 'bbbbbbbbbbbbbbbb',
  p3 = 'cccccccccccccccc',
  i1 = '1111111111111111';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'qgroup-native-settlement-')),
    db = openDatabase(join(root, 'state.db'));
  fixture(db);
  db.exec(
    `UPDATE events SET lifecycle='ended',bot_enabled=1 WHERE id='listen'; INSERT INTO event_roles VALUES('helper','listen','bob','["settlement"]','before'); INSERT INTO attendees(id,event_id,manager_id,user_id,name,payer_kind,status,confirmation_state,accepted_conditions_version,created_at,updated_at) VALUES('${p1}','listen','alice','alice','','self','confirmed','accepted',1,'before','before'),('${p2}','listen','bob','bob','','self','confirmed','accepted',1,'before','before'),('${p3}','listen','alice',NULL,'同行','self','confirmed','accepted',1,'before','before')`,
  );
  db.prepare('UPDATE bot_settings SET config_json=?').run(
    JSON.stringify({
      enabled: true,
      groups: [{ id: 'synthetic-group', name: '測試', replies: true, broadcast: true }],
    }),
  );
  const app = createApp({
    db,
    origin,
    now: () => new Date(stamp),
    activityBot: { enabled: true, baseURL: origin, keyboard: true, personalQueue: true },
  });
  await app.ready();
  cleanup.push(async () => {
    await app.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  async function headers(id: string) {
    const cookie = 'kanban_session=fixture-' + id,
      s = (await app.inject({ url: '/api/v2/session', headers: { cookie } })).json();
    return { cookie, origin, 'x-account-scope': s.scope, 'x-csrf-token': s.csrf };
  }
  const alice = await headers('alice'),
    bob = await headers('bob');
  const input = (patch: object = {}) =>
    SettlementInput.parse({
      revision: eventRow(db, 'listen')!.revision,
      base_version: (
        db.prepare("SELECT COALESCE(MAX(version),0) AS n FROM settlement_history WHERE event_id='listen'").get() as {
          n: number;
        }
      ).n,
      reviewed_roster: true,
      people: [{ id: p1 }, { id: p2 }, { id: p3 }],
      items: [{ id: i1, name: '消費', amount: '10.00' }],
      ...patch,
    });
  const preview = (data = input(), h = alice) =>
    app.inject({ method: 'POST', url: '/api/v2/activities/listen/settlement/preview', headers: h, payload: data });
  const send = (data: object, h = alice, key = randomUUID()) =>
    app.inject({
      method: 'POST',
      url: '/api/v2/activities/listen/settlement',
      headers: { ...h, 'idempotency-key': key },
      payload: data,
    });
  const save = async (data = input(), h = alice) => {
    const p = await preview(data, h);
    expect(p.statusCode, p.body).toBe(200);
    const value = await send({ ...data, preview_token: p.json().preview_token, confirm: true }, h);
    expect(value.statusCode, value.body).toBe(200);
    return value;
  };
  return { db, root, app, alice, bob, input, preview, send, save };
}
type Setup = Awaited<ReturnType<typeof setup>>;
async function python(
  s: Setup,
  data: object,
  extra = 'print(json.dumps(settlements.calculate(db,event,user,data)[0]))',
) {
  const folder = mkdtempSync(join(tmpdir(), 'qgroup-settlement-')),
    path = join(folder, 'synthetic.sqlite3'),
    input = join(folder, 'input.json');
  try {
    await s.db.backup(path);
    if (existsSync(join(s.root, 'images'))) cpSync(join(s.root, 'images'), join(folder, 'images'), { recursive: true });
    writeFileSync(input, JSON.stringify(data));
    return JSON.parse(
      execFileSync(
        'python3',
        [
          '-c',
          `import datetime,json,sqlite3,sys
from qgroup_core import settlements,finance,bot_outbox,bot_settings,audit,rooms
class Frozen(datetime.datetime):
 @classmethod
 def now(cls,tz=None):return datetime.datetime.fromisoformat('${stamp}').astimezone(tz)
finance.datetime=Frozen;bot_outbox.datetime=Frozen
for module in (settlements,finance,bot_outbox,bot_settings,audit,rooms):module.now=lambda:'${stamp}'
db=sqlite3.connect(sys.argv[1]);db.row_factory=sqlite3.Row
event=db.execute("SELECT * FROM events WHERE id='listen'").fetchone();user=db.execute("SELECT * FROM users WHERE id='alice'").fetchone();data=json.load(open(sys.argv[2]))
${extra}`,
          path,
          input,
        ],
        {
          encoding: 'utf8',
          timeout: 15000,
          env: { ...process.env, QQ_APP_ID: '', QQ_SECRET: '', KANBAN_BOT_BASE_URL: origin, KANBAN_BOT_KEYBOARD: '1' },
        },
      ),
    );
  } finally {
    rmSync(folder, { force: true, recursive: true });
  }
}

async function original(s:Setup,patch:object={}){
 const {revision,...data}=s.input(patch),body={...data,base_revision:revision},p=await python(s,body,"print(json.dumps(settlements.preview(db,event,user,data)))");
 return {requestKey:randomUUID(),method:'PUT' as const,path:'/api/events/listen/settlement/detailed',data:{...body,preview_token:p.preview_token}};
}
const send=(s:Setup,body:object,mode='inspect',headers=s.alice)=>s.app.inject({method:'POST',url:'/api/v2/me/legacy-requests/settlement/'+mode,headers,payload:body});
const state=(s:Setup)=>s.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>{const name=(row as {name:string}).name;return [name,s.db.prepare('SELECT * FROM "'+name+'"').all()];});
async function prepared(s:Setup,o:object){const before=state(s),r=await send(s,o);expect(r.statusCode,r.body).toBe(200);expect(r.json().state).toBe('retryable');expect(state(s)).toEqual(before);return {...o,confirm:true,recovery_token:r.json().recovery_token};}
describe('original detailed settlement request recovery',()=>{
 for(const mode of ['shares','equal','weights','fixed','duration'])it('validates the original Python proof and publishes '+mode+' allocations through the same immutable command',async()=>{
  const s=await setup(),allocations=[p1,p2,p3].map((person_id,i)=>({person_id,...(mode==='weights'?{weight:['1','2','0'][i]}:mode==='fixed'?{amount:['0.01','0.02','0.02'][i]}:mode==='duration'?{minutes:[20,40,0][i]}:{})})),o=await original(s,{items:[{id:i1,name:'原費用',amount:'0.05',mode,reason:'原分攤依據',allocations}],group_notice:true}),expected=await python(s,o.data,"s=settlements.preview(db,event,user,data);settlements.save(db,event,user,data);db.commit();print(json.dumps(dict(preview=s,detail=settlements.details(db,'listen',1),finance=[dict(r) for r in db.execute('SELECT * FROM finance_entries')],notifications=[dict(r) for r in db.execute('SELECT * FROM notifications')],outbox=[dict(r) for r in db.execute('SELECT * FROM bot_outbox')],revision=db.execute(\"SELECT revision FROM events WHERE id='listen'\").fetchone()[0])))"),body=await prepared(s,o),inspection=(await send(s,o)).json();
  expect(inspection.preview.preview_token).toBe(expected.preview.preview_token);expect(inspection.preview.snapshot).toEqual({...expected.preview.snapshot,journal_seq:String(expected.preview.snapshot.journal_seq)});
  expect((await send(s,body,'retry')).statusCode).toBe(200);expect(settlementDetail(s.db,'listen')).toEqual({...expected.detail,journal_seq:String(expected.detail.journal_seq)});expect(s.db.prepare('SELECT * FROM finance_entries').all()).toEqual(expected.finance);const notifications=(rows:unknown[])=>rows.map(row=>{const {id,...rest}=row as {id:number;user_id:string};void id;return rest;}).sort((a,b)=>a.user_id.localeCompare(b.user_id));expect(notifications(s.db.prepare('SELECT * FROM notifications').all())).toEqual(notifications(expected.notifications));const outbox=(rows:unknown[])=>rows.map(row=>{const r=row as {payload_json:string};return {...r,payload_json:JSON.parse(r.payload_json)};});expect(outbox(s.db.prepare('SELECT * FROM bot_outbox').all())).toEqual(outbox(expected.outbox));expect(eventRow(s.db,'listen')!.revision).toBe(expected.revision);
  const row=s.db.prepare('SELECT signature,response_json FROM request_results WHERE request_key=?').get(o.requestKey) as {signature:string;response_json:string};expect(row.signature).toBe(originalRequestSignature(o.method,o.path,o.data));expect(JSON.parse(row.response_json)).toEqual({id:'listen',starts_at:eventRow(s.db,'listen')!.starts_at});
 });
 it('preserves known cloned display fields and ignores only original inactive operands',async()=>{
  const s=await setup(),o=await original(s),data={...o.data,people:o.data.people.map(p=>({...p,payments:[{payer_id:p.id===p2?b:p.id===p3?'person:'+p3:a,share:'1',amount:'',amount_cents:999,name:'原顯示',label:'原標籤'}]})),items:o.data.items.map(i=>({...i,amount_cents:999,has_receipt:false,breakdown:[],receipt_digest:null,allocations:[{person_id:p1,amount:'',minutes:null,weight:''}]}))},raw={...o,data},p=await python(s,data,"print(json.dumps(settlements.preview(db,event,user,data)))");expect(p.preview_token).toBe(o.data.preview_token);expect((await send(s,await prepared(s,raw),'retry')).statusCode).toBe(200);expect(()=>decodeLegacyDetailedSettlement({...raw,data:{...data,unknown:true}})).toThrow();
 });
 it('reproduces Python float syntax in stored conditions and exact integer journal sequences above 2^53',async()=>{
  const s=await setup();s.db.exec(`INSERT INTO event_conditions(event_id,version,snapshot_json,created_at,summary,actor_name) VALUES('listen',1,'{"location":"台北","starts_at":"2026-11-17T00:00:00+00:00","duration_hours":2.0,"category":"其他","timezone":"Asia/Taipei","withdrawal_deadline":"2026-11-16T00:00:00+00:00","fee_policy":"核對費用","description":""}','before','','小青'); INSERT INTO finance_entries(seq,id,event_id,kind,payload_json,occurred_at,actor_id,actor_name,created_at) VALUES(9007199254740993,'9999999999999999','listen','expense','{"amount_cents":1,"funding":"payer","payer_id":"${a}","merchant":"店家","parties":[{"id":"${a}","name":"小青","label":"小青"}]}','before','alice','小青','before')`);
  const o=await original(s),body=await prepared(s,o),p=(await send(s,o)).json();expect(p.preview.snapshot.journal_seq).toBe('9007199254740993');expect((await send(s,body,'retry')).statusCode).toBe(200);expect(settlementDetail(s.db,'listen')!.journal_seq).toBe('9007199254740993');
 });
 it('handles original inline receipt and QR, omitted-code inheritance and another publisher clearing inherited codes',async()=>{
  const s=await setup(),png=testPNG().toString('base64'),o=await original(s,{items:[{id:i1,name:'附憑證',amount:'10',receipt:png}],payment_codes:[{kind:'other',name:'原收款',image:png}]});expect((await send(s,await prepared(s,o),'retry')).statusCode).toBe(200);
  const next=await original(s,{reason:'核對下一版'});const {payment_codes,...omitted}=next.data;void payment_codes;const p=await python(s,omitted,"print(json.dumps(settlements.preview(db,event,user,data)))"),inherited={...next,data:{...omitted,preview_token:p.preview_token}};expect((await send(s,inherited)).json().assets.payment_codes).toEqual([{kind:'other',version:1}]);
  const bob=await python(s,omitted,"user=db.execute(\"SELECT * FROM users WHERE id='bob'\").fetchone();print(json.dumps(settlements.preview(db,event,user,data)))");const other={...inherited,data:{...omitted,preview_token:bob.preview_token}};expect((await send(s,other,'inspect',s.bob)).json().assets.payment_codes).toEqual([]);
  const qr={...omitted,qr_image:png},qp=await python(s,qr,"print(json.dumps(settlements.preview(db,event,user,data)))");expect((await send(s,{...next,data:{...qr,preview_token:qp.preview_token}})).json().assets.payment_codes).toEqual([{kind:'other',name:'',image:png}]);
  for(const invalid of [false,'', 'data:image/png;base64,'+png])expect((await send(s,{...next,data:{...omitted,qr_image:invalid}})).statusCode).toBeGreaterThanOrEqual(400);
 });
 it('publishes original paid-room previews once with deterministic finance IDs and original unpaid empty fields',async()=>{
  const s=await setup(),o=await original(s,{rooms:[{id:i1,name:'原包間',payer_id:a,person_ids:[p1,p2,p3],amount:'10',merchant_mode:'paid',paid_amount:'8'}],room_payment_details:{occurred_at:'2026-11-17T00:00:00Z',method:'cash'}}),body=await prepared(s,o);expect((await send(s,o)).json().preview.snapshot.merchant_payments).toHaveLength(1);expect((await Promise.all([send(s,body,'retry'),send(s,body,'retry')])).map(r=>r.statusCode)).toEqual([200,200]);expect(s.db.prepare('SELECT * FROM finance_entries').all()).toHaveLength(1);
  const other=await setup(),unpaid=await original(other,{rooms:[{id:i1,name:'未付包間',payer_id:a,person_ids:[p1,p2,p3],amount:'10',merchant_mode:'unpaid'}]}),raw={...unpaid,data:{...unpaid.data,rooms:unpaid.data.rooms!.map(r=>({...r,paid_amount:''}))}};expect((await send(other,await prepared(other,raw),'retry')).statusCode).toBe(200);
 });
 it('does not repeat history, merchant expense, notification or bot work after a matching original receipt',async()=>{
  const s=await setup(),o=await original(s,{merchant_payment:{mode:'paid',amount:'8',payer_id:a,occurred_at:'2026-11-17T00:00:00Z',merchant:'店家'}}),body=await prepared(s,o);expect((await send(s,body,'retry')).statusCode).toBe(200);s.db.exec("UPDATE events SET revision=revision+1,lifecycle='scheduled' WHERE id='listen'");const before=state(s);for(const mode of ['inspect','retry']){const r=await send(s,mode==='inspect'?o:body,mode);expect(r.statusCode,r.body).toBe(200);expect(r.body).not.toContain('snapshot');}expect(state(s)).toEqual(before);expect(s.db.prepare('SELECT * FROM finance_entries').all()).toHaveLength(1);
 });
 it('records no-op originals without adding business versions',async()=>{const s=await setup(),o=await original(s);expect((await send(s,await prepared(s,o),'retry')).statusCode).toBe(200);const next=await original(s,{reason:'再次核對'});expect((await send(s,await prepared(s,next),'retry')).statusCode).toBe(200);expect(s.db.prepare('SELECT * FROM settlement_history').all()).toHaveLength(1);expect(s.db.prepare('SELECT * FROM request_results').all()).toHaveLength(2);});
 it('refuses native preview proofs, changed original previews and changed current review without replacing the original body',async()=>{
  const s=await setup(),o=await original(s),body=await prepared(s,o),input=decodeLegacyDetailedSettlement(o).input,snapshot=calculateSettlement(s.db,eventRow(s.db,'listen')!,{id:'alice',nickname:'小青'},input,new Date(stamp)).snapshot,before=state(s);for(const preview_token of ['0'.repeat(64),settlementToken(eventRow(s.db,'listen')!,snapshot,input.base_version)])expect((await send(s,{...o,data:{...o.data,preview_token}})).statusCode).toBe(409);expect(state(s)).toEqual(before);s.db.exec("UPDATE events SET title='新活動名稱' WHERE id='listen'");const changed=state(s);expect((await send(s,body,'retry')).statusCode).toBe(409);expect(state(s)).toEqual(changed);expect((await send(s,await prepared(s,o),'retry')).statusCode).toBe(200);
 });
 it('rejects stale revision/version, missing consent and receipt conflict, and rolls back every write on receipt failure',async()=>{
  const s=await setup(),o=await original(s),body=await prepared(s,o);for(const raw of [o,{...body,confirm:false},{...body,recovery_token:'0'.repeat(64)},{...body,data:{...o.data,base_revision:999}},{...body,data:{...o.data,base_version:999}}])expect((await send(s,raw,'retry')).statusCode).toBeGreaterThanOrEqual(400);
  s.db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON request_results BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");const before=state(s);expect((await send(s,body,'retry')).statusCode).toBe(500);expect(state(s)).toEqual(before);s.db.exec('DROP TRIGGER reject_receipt');expect((await send(s,body,'retry')).statusCode).toBe(200);const saved=state(s);expect((await send(s,{...body,data:{...o.data,note:'other'}},'retry')).statusCode).toBe(409);expect(state(s)).toEqual(saved);
 });
 it('requires current access, settlement authority, account scope, origin and CSRF even for cached original receipts',async()=>{
  const s=await setup(),o=await original(s),body=await prepared(s,o);for(const h of [{...s.alice,cookie:''},{...s.alice,origin:'https://elsewhere.example'},{...s.alice,'x-csrf-token':'invalid'},{...s.alice,'x-account-scope':s.bob['x-account-scope']}])for(const mode of ['inspect','retry'])expect((await send(s,mode==='inspect'?o:body,mode,h)).statusCode).toBeGreaterThanOrEqual(400);
  expect((await send(s,body,'retry')).statusCode).toBe(200);s.db.exec("UPDATE events SET owner_id='bob',visibility='invitation' WHERE id='listen'; DELETE FROM event_access WHERE event_id='listen' AND user_id='alice'");const before=state(s);for(const mode of ['inspect','retry'])expect((await send(s,mode==='inspect'?o:body,mode)).statusCode).toBe(404);expect(state(s)).toEqual(before);
 });
 it('keeps matching private receipts private and blocks corrupt or wrong-activity results',async()=>{
  const s=await setup(),o=await original(s),body=await prepared(s,o);s.db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run('alice',o.requestKey,originalRequestSignature(o.method,o.path,o.data),JSON.stringify({id:'listen',starts_at:'before',private_note:'PRIVATE'}),200,'before');for(const mode of ['inspect','retry'])expect((await send(s,mode==='inspect'?o:body,mode)).body).not.toContain('PRIVATE');for(const raw of ['{','null','[]','{"id":"karaoke"}']){s.db.prepare('UPDATE request_results SET response_json=? WHERE request_key=?').run(raw,o.requestKey);for(const mode of ['inspect','retry'])expect((await send(s,mode==='inspect'?o:body,mode)).statusCode).toBe(409);}
 });
 it('retains the original image-name default and code-library precedence without dropping the raw signature fields',async()=>{
  const s=await setup(),png=testPNG().toString('base64'),o=await original(s,{payment_codes:[{kind:'other',image:png,name:''}]}),raw={...o,data:{...o.data,payment_codes:[{kind:'other',image:png}]}};expect((await send(s,await prepared(s,raw),'retry')).statusCode).toBe(200);
  const library=await s.app.inject({method:'POST',url:'/api/v2/me/payment-codes',headers:{...s.alice,'idempotency-key':randomUUID()},payload:{kind:'other',image:png,name:'原碼庫',confirm:true}});expect(library.statusCode,library.body).toBe(200);
  const next=await original(s,{reason:'核對碼庫',payment_codes:[{kind:'other',code_id:library.json().id}]}),combined={...next,data:{...next.data,payment_codes:[{kind:'other',code_id:library.json().id,image:'invalid but inactive',name:'inactive',version:999}]}};
  const expected=await python(s,combined.data,"print(json.dumps(settlements.preview(db,event,user,data)))");expect(expected.preview_token).toBe(next.data.preview_token);expect((await send(s,await prepared(s,combined),'retry')).statusCode).toBe(200);expect(s.db.prepare('SELECT signature FROM request_results WHERE request_key=?').get(next.requestKey)).toEqual({signature:originalRequestSignature(combined.method,combined.path,combined.data)});
 });

});
