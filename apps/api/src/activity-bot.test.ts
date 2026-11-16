import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { botLocalTime, botMoment, botStartCountdown } from '@qgroup/domain';
import { fixture } from '../testsupport/fixture';
import { nicknameFixture } from '../testsupport/nickname-fixture';
import { activityBotPolicy, buildActivityBotMessage, createActivityBot } from './activity-bot';
import { eventRow } from './activity-arrangements';
const at=new Date('2026-11-17T00:00:00Z');const stamp='2026-11-17T00:00:00+00:00';
const cleanups:(()=>void)[]=[];afterEach(()=>{for(const close of cleanups.splice(0).reverse())close();});
function setup(){const db=openDatabase(':memory:');fixture(db);nicknameFixture(db);db.exec(`UPDATE events SET starts_at='2026-11-20T10:00:00+00:00',deadline='2026-11-19T10:00:00+00:00',revision=7,conditions_version=2,change_summary='時間與地點已變更',minimum_participants=4,fee_policy='原費用 <qqbot-at-everyone />',cancellation_reason='取消原因',title='活動 **標題** 𠀀' WHERE id='listen'; UPDATE users SET nickname='<@123> [稱呼](https://evil.example) @everyone'; INSERT INTO event_conditions VALUES('listen',1,'{"starts_at":"2026-11-19T10:00:00+00:00"}','初始安排','原發起者','before'); DELETE FROM bot_outbox;`);cleanups.push(()=>db.close());return db;}
const kinds=['activity_published','formation_confirmed','conditions_changed','event_started','event_finished','event_cancelled','deadline_reminder','estimated_over_reminder','registration_paused','registration_resumed','registration_added','registration_changed'] as const;
const source=`import datetime,json,sqlite3,sys
from qgroup_core import bot_outbox as out,bot_views,bot_settings
db=sqlite3.connect(sys.argv[1]);db.row_factory=sqlite3.Row
class Frozen(datetime.datetime):
 @classmethod
 def now(cls,tz=None):return datetime.datetime.fromisoformat('${stamp}').astimezone(tz)
out.datetime=Frozen
out.now=lambda:'${stamp}'
bot_views.now=lambda:'${stamp}'
bot_settings.now=lambda:'${stamp}'
event=db.execute("SELECT * FROM events WHERE id='listen'").fetchone()
`;
describe('activity outbox compatibility with the retained Python bot',()=>{
  it('matches all activity card text, frozen context, rich template and button variants against original Python',async()=>{
    const db=setup();const folder=mkdtempSync(join(tmpdir(),'qgroup-card-diff-'));const path=join(folder,'synthetic.sqlite3');
    try{
      for(const templates of [{},{activity_published:'{{公開}} {heading}\n{details}\n{url}','activity_published@md':'## 自訂\n{title}\n{details}\n[活動]({url})',conditions_changed:'{previous_starts_at} → {starts_at}\n{url}','conditions_changed@md':'~~{previous_starts_at}~~ → **{starts_at}**\n[確認]({url})'}]){
        db.prepare('UPDATE bot_settings SET config_json=?').run(JSON.stringify({enabled:true,templates}));await db.backup(path);
        const expected=JSON.parse(execFileSync('python3',['-c',source+`result={}
for kind in json.loads(sys.argv[2]):
 text,buttons,context=out.build_message(db,event,kind,after={'attendee_ids':['self-listen','managed-listen']})
 rich=context.pop('_markdown',None)
 result[kind]=dict(text=text,markdown=rich,context=context,buttons=buttons)
print(json.dumps(result))`,path,JSON.stringify(kinds)],{encoding:'utf8',env:{...process.env,KANBAN_BOT_BASE_URL:'https://kanban.example',KANBAN_BOT_ENABLED:'1'}}));
        const config=activityBotPolicy(db).config;
        for(const kind of kinds){const actual=buildActivityBotMessage(db,eventRow(db,'listen')!,kind,config,at,{baseURL:'https://kanban.example'},['self-listen','managed-listen']);expect(actual,kind).toEqual(expected[kind]);}
      }
    }finally{rmSync(folder,{recursive:true,force:true});}
  });
  it('freezes exactly the same publication/reminder work, dedupe, recipient and callback activity IDs; original Python re-renders the new contexts',async()=>{
    const db=setup();db.prepare('UPDATE bot_settings SET config_json=?').run(JSON.stringify({enabled:true,groups:[{id:'configured-group',name:'測試',broadcast:true,replies:true}],templates:{'activity_published@md':'## 自訂\n{title}\n[報名]({url})'}}));
    const folder=mkdtempSync(join(tmpdir(),'qgroup-outbox-diff-'));const path=join(folder,'synthetic.sqlite3');
    const rows=()=>db.prepare('SELECT event_id,kind,dedupe_key,channel,target,payload_json,due_at,status,created_at,recipient_user_id,poll_id FROM bot_outbox ORDER BY id').all() as {payload_json:string}[];
    try{
      await db.backup(path);
      const expected=JSON.parse(execFileSync('python3',['-c',source+`out.on_append(db,event,None,'event_publish',{},dict(event=dict(event)))
out.on_append(db,event,None,'event_publish',{},dict(event=dict(event)))
print(json.dumps([dict(r) for r in db.execute('SELECT event_id,kind,dedupe_key,channel,target,payload_json,due_at,status,created_at,recipient_user_id,poll_id FROM bot_outbox ORDER BY id')]))`,path],{encoding:'utf8',env:{...process.env,KANBAN_BOT_BASE_URL:'https://kanban.example',KANBAN_BOT_ENABLED:'1',KANBAN_BOT_KEYBOARD:'1'}}));
      const bot=createActivityBot(db,()=>at,{enabled:true,baseURL:'https://kanban.example',keyboard:true});db.transaction(()=>{bot.publication('listen');bot.publication('listen');}) .immediate();
      const decode=(values:{payload_json:string}[])=>values.map(({payload_json,...rest})=>({...rest,payload:JSON.parse(payload_json)}));expect(decode(rows())).toEqual(decode(expected));expect(rows()).toHaveLength(3);
      await db.backup(path);const rendered=JSON.parse(execFileSync('python3',['-c',source+`config=bot_settings.read(db)['config']
result=[]
for row in db.execute('SELECT kind,payload_json FROM bot_outbox ORDER BY id'):
 payload=json.loads(row['payload_json']);context=payload['_template_context']
 result.append(dict(text=out.render_message(config,row['kind'],context),markdown=out.render_message(config,row['kind'],context,markdown=True)))
print(json.dumps(result))`,path],{encoding:'utf8'}));
      expect(rendered).toEqual(rows().map(r=>{const p=JSON.parse(r.payload_json);return {text:p.text,markdown:p.markdown_text};}));
    }finally{rmSync(folder,{recursive:true,force:true});}
  });
  it('reconciles schedule edits and policy routing without replaying sent, uncertain, simulated or failed matching work',()=>{
    const db=setup(),bot=createActivityBot(db,()=>at);db.transaction(()=>bot.publication('listen')).immediate();const original=db.prepare('SELECT * FROM bot_outbox ORDER BY id').all() as {id:number;kind:string;payload_json:string}[];expect(original).toHaveLength(3);
    db.prepare("UPDATE bot_outbox SET status='skipped',last_error='dry-run',simulated_at='simulated' WHERE kind='deadline_reminder'").run();bot.schedule(eventRow(db,'listen')!);expect(db.prepare('SELECT count(*) AS n FROM bot_outbox').get()).toEqual({n:3});
    db.exec("UPDATE events SET deadline='2026-11-18T10:00:00+00:00',revision=8 WHERE id='listen'");bot.schedule(eventRow(db,'listen')!);expect(db.prepare('SELECT count(*) AS n FROM bot_outbox').get()).toEqual({n:4});
    db.prepare("UPDATE bot_outbox SET status='sending',last_error='uncertain' WHERE kind='estimated_over_reminder'").run();bot.schedule(eventRow(db,'listen')!);expect(db.prepare('SELECT count(*) AS n FROM bot_outbox').get()).toEqual({n:4});
    db.prepare("UPDATE events SET bot_enabled=0 WHERE id='listen'").run();bot.publication('listen');expect(db.prepare("SELECT 1 FROM bot_outbox WHERE status IN ('pending','sending')").get()).toBeUndefined();
    const saved=db.prepare('SELECT payload_json FROM bot_outbox WHERE id=?').get(original[0]!.id);expect(saved).toEqual({payload_json:original[0]!.payload_json});
    db.exec("UPDATE events SET bot_enabled=1,revision=9 WHERE id='listen'; UPDATE bot_settings SET config_json='{\"enabled\":true,\"groups\":[]}'");bot.publication('listen');expect(db.prepare('SELECT count(*) AS n FROM bot_outbox').get()).toEqual({n:4});
  });
  it('matches Python event-zone naive time, UTC display and countdown through DST gaps and folds',()=>{
    const rows=[{value:'2026-11-01T01:30:00',zone:'America/New_York'},{value:'2026-03-08T02:30:00',zone:'America/New_York'},{value:'2026-10-25T02:30:00',zone:'Europe/Berlin'},{value:'2026-03-29T02:30:00',zone:'Europe/Berlin'},{value:'2026-11-17T18:30:00',zone:'Asia/Taipei'},{value:'2026-11-17T00:00:00+00:00',zone:'Asia/Tokyo'},{value:'invalid time',zone:'invalid zone'},{value:'2026-11-17T00:00:30Z',zone:''},{value:'2026-11-17T00:01:00Z',zone:''},{value:'2026-11-18T01:01:00Z',zone:''}];
    const expected=JSON.parse(execFileSync('python3',['-c',`import datetime,json,sys
from qgroup_core import bot_outbox as out
values=json.load(sys.stdin)
result=[]
for row in values:
 try:
  moment=datetime.datetime.fromisoformat(row['value'].replace('Z','+00:00'))
  if moment.tzinfo is None:moment=moment.replace(tzinfo=out._zone(row['zone']))
  timestamp=moment.timestamp()*1000
 except Exception:timestamp=None
 result.append(dict(local=out.local_time(row['value'],row['zone']),timestamp=timestamp,countdown=out.start_countdown(dict(starts_at=row['value'],timezone=row['zone'],lifecycle='scheduled'),at=datetime.datetime.fromisoformat('${stamp}'))))
print(json.dumps(result))`],{input:JSON.stringify(rows),encoding:'utf8'}));
    expect(rows.map(row=>{const timestamp=botMoment(row.value,row.zone);return {local:botLocalTime(row.value,row.zone),timestamp:Number.isFinite(timestamp)?timestamp:null,countdown:botStartCountdown({starts_at:row.value,timezone:row.zone,lifecycle:'scheduled'},at)};})).toEqual(expected);
  });
});
