import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '@qgroup/database';
import { botContentProblem } from '@qgroup/domain';
import { fixture } from '../../api/testsupport/fixture';
import { eventRow, type EventRow } from '../../api/src/activity-arrangements';
import { BOT_ALIASES, BOT_COMMANDS, parseBotCommand, type PublicBotCommand } from './commands';
import { botCandidates, botEstimatedOver, botPublicTasks, currentBotEvent } from './public-queries';
import { answerPublicBotCommand, readPublicBotReply } from './replies';
const stamp='2026-11-17T10:00:00+00:00',now=new Date(stamp),options={now,baseURL:'https://example.test'};
const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
const ids={listen:'aaaaaaaa11111111',karaoke:'bbbbbbbb22222222',past:'cccccccc33333333',invite:'dddddddd44444444',draft:'eeeeeeee55555555',deleted:'ffffffff66666666'};
function setup(){
  const dir=mkdtempSync(join(tmpdir(),'native-public-replies-')),path=join(dir,'space ? state.sqlite3'),db=openDatabase(path);fixture(db);
  for(const [old,id] of Object.entries(ids))db.prepare('UPDATE events SET id=? WHERE id=?').run(id,old);
  db.exec("UPDATE events SET starts_at='2026-11-19T10:00:00+00:00',deadline='2026-11-18T10:00:00+00:00',bot_enabled=0; UPDATE events SET starts_at='2026-11-01T10:00:00+00:00' WHERE lifecycle='ended'");
  cleanup.push(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  const answer=(command:PublicBotCommand|null,argument='')=>answerPublicBotCommand(db,command,argument,options);
  return {db,dir,path,answer};
}
function python(path:string,program:string,input:unknown={}) {
  return JSON.parse(execFileSync('python3',['-c',`import datetime,json,sqlite3,sys
from qgroup_bot import replies
from qgroup_core import bot_views,bot_outbox
stamp='${stamp}'
class Frozen(datetime.datetime):
 @classmethod
 def now(cls,tz=None):return datetime.datetime.fromisoformat(stamp).astimezone(tz)
bot_views.datetime=Frozen;bot_outbox.datetime=Frozen
bot_views.now=lambda:stamp;bot_outbox.now=lambda:stamp
class FrozenDB(sqlite3.Connection):
 def execute(self,sql,*args):return super().execute(sql.replace("'now'","'"+stamp+"'"),*args)
db=sqlite3.connect(sys.argv[1],factory=FrozenDB);db.row_factory=sqlite3.Row
values=json.load(sys.stdin)
${program}`,path],{input:JSON.stringify(input),encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH,PYTHONPATH:process.cwd(),KANBAN_BOT_BASE_URL:'https://example.test'}}));
}
function roster(db:DB){
  for(const [i,status] of ['confirmed','waiting','tentative','withdrawn','invited','confirmed'].entries()){
    const party='party-'+i;
    db.prepare("INSERT INTO roster_parties(id,event_id,manager_id,queue_mode,created_at) VALUES(?,?,'alice','together','before')").run(party,ids.listen);
    db.prepare(`INSERT INTO attendees(id,event_id,manager_id,user_id,party_id,name,note,payer_kind,status,confirmation_state,withdrawal_requested,attendance,created_at,updated_at)
      VALUES(?,?,'alice',?,?,?,?,?,?,?,?,?,'before','before')`).run('person-'+i,ids.listen,i===0?'alice':null,party,'同行 **'+i+'** <@123> @everyone https://bad.test','private note','manager',status,i===0||i===3?'pending':i===1?'declined':'accepted',i===2||i===3?1:0,['present','late','unknown','left','unknown','absent'][i]);
  }
  db.exec("UPDATE users SET nickname='[名字](https://evil.test) @all <qqbot-at-everyone />'; UPDATE events SET minimum_participants=2,fee_policy='按原約定',title='活動 **標題** 𠀀',location='地點 <qqbot-at-everyone />' WHERE id='"+ids.listen+"'");
}
function bill(db:DB,closed=false,version=1){
  db.prepare("INSERT INTO settlements(event_id,total_cents,headcount,updated_at,note) VALUES(?,12345,3,'before','private bill note')").run(ids.listen);
  db.prepare("INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,updated_at,actor_id,actor_name,kind,changed_fields) VALUES(?,?,12345,3,'private bill note','before','alice','private actor','published','[]')").run(ids.listen,version);
  if(closed)db.prepare("INSERT INTO finance_entries(id,event_id,kind,payload_json,occurred_at,actor_id,actor_name,created_at) VALUES('closed',?,'close',?,'before','alice','private actor','before')").run(ids.listen,JSON.stringify({bill_version:version}));
}
const commands=[...new Set(Object.values(BOT_ALIASES))].filter((c):c is PublicBotCommand=>c!=='缩写');
describe('native public bot commands',()=>{
  it('matches every legacy alias, panel label, mention and Unicode parsing variant',()=>{
    const s=setup(),values=[...Object.keys(BOT_ALIASES).flatMap(alias=>[alias,'<@!BOT_12> ／'+alias+'  abcdef12','＠@  /'+alias.toUpperCase()+'\u0085 2']),null,'','  ','<@BOT>','<@!BOT>','随便聊天','/unknown arg','///活动 2','／ / 活动','/ 帮助','\ufeff/help','/help\ufeff x','\u001c/名额\u001f 2','/活动\n 2','@\u200b','/活动\u2028二'];
    const expected=python(s.path,"print(json.dumps(dict(commands=replies.COMMANDS,parsed=[replies.parse(v) for v in values])))",values);
    expect(BOT_COMMANDS).toEqual(expected.commands);expect(values.map(parseBotCommand)).toEqual(expected.parsed);
    for(const command of BOT_COMMANDS){expect(Array.from(command.name).length).toBeLessThanOrEqual(14);expect(Array.from(command.desc).length).toBeLessThanOrEqual(30);}
  });
  it('matches all 25 public commands in plain and Markdown, including invalid selections and public rosters',()=>{
    const s=setup();roster(s.db);bill(s.db);
    const values=commands.flatMap(command=>['','1','2',ids.listen.slice(0,8),ids.past,'bad','9','8',ids.invite,ids.draft,ids.deleted].map(argument=>({command,argument})));
    values.push({command:null as unknown as PublicBotCommand,argument:''});
    // Legacy Markdown /发起 with an argument can contradict its own plain
    // answer. Test no-argument command here; explicit consistency is below.
    const requests=values.filter(v=>v.command!=='发起'||!v.argument);
    const expected=python(s.path,`print(json.dumps([dict(text=replies.answer(db,v['command'],v['argument'])[0],markdown=replies.answer_markdown(db,v['command'],v['argument']),keyboard=None) for v in values]))`,requests);
    for(const [i,request] of requests.entries())expect(s.answer(request.command,request.argument),JSON.stringify(request)).toEqual(expected[i]);
  });
  it('matches a sole public activity for every command without requiring broadcast opt-in',()=>{
    const s=setup();roster(s.db);s.db.prepare("UPDATE events SET visibility='invitation' WHERE id!=?").run(ids.listen);
    const expected=python(s.path,"print(json.dumps([dict(text=replies.answer(db,c)[0],markdown=replies.answer_markdown(db,c),keyboard=None) for c in values]))",commands);
    for(const [index,command] of commands.entries())expect(s.answer(command),command).toEqual(expected[index]);
    s.db.prepare("UPDATE events SET lifecycle='ended' WHERE id=?").run(ids.listen);
    expect(botPublicTasks(s.db,eventRow(s.db,ids.listen)!,now)).toContain('请发起者核对出席、原约定并发布结算');
  });
  it('keeps large integer cent totals exact and applies the same zone-aware deadline rules as activity notifications',()=>{
    const s=setup();bill(s.db);s.db.prepare('UPDATE settlements SET total_cents=?').run(Number.MAX_SAFE_INTEGER);
    const expected=python(s.path,"print(json.dumps(dict(text=replies.answer(db,'结算',values)[0],markdown=replies.answer_markdown(db,'结算',values),keyboard=None)))",ids.listen);
    expect(s.answer('结算',ids.listen)).toEqual(expected);expect(s.answer('结算',ids.listen).text).toContain('90071992547409.91 元');
    s.db.prepare("UPDATE events SET starts_at='2026-11-17T18:30:00',deadline='2026-11-17T17:00:00',timezone='Asia/Taipei',minimum_participants=5 WHERE id=?").run(ids.listen);
    expect(s.answer('名额',ids.listen).text).toContain('已截止，补报名请联系发起者');
    expect(botPublicTasks(s.db,eventRow(s.db,ids.listen)!,now)).toContain('请发起者决定是否成团；达到人数不代表已确认成团');
  });
  it('matches menus with more than eight candidates and filters overdue rows before limiting or numbering',()=>{
    const s=setup(),base=eventRow(s.db,ids.listen)!;
    for(let i=0;i<17;i++){
      const row={...base,id:(0x1234567800000000n+BigInt(i)).toString(16),starts_at:i<8?'2026-11-17T15:00:00':'2026-11-18T10:00:00',duration_hours:1,title:'候選 '+i};
      s.db.prepare('INSERT INTO events('+Object.keys(row).join(',')+') VALUES('+Object.keys(row).map(()=>'?').join(',')+')').run(...Object.values(row));
    }
    const expected=python(s.path,`print(json.dumps([dict(command=c,ids=[r['id'] for r in replies.candidates(db,c)],text=replies.answer(db,c)[0],markdown=replies.answer_markdown(db,c)) for c in values]))`,commands.filter(c=>!['帮助','我的','发起'].includes(c)));
    for(const row of expected){expect(botCandidates(s.db,row.command,now).map(e=>e.id),row.command).toEqual(row.ids);const answer=s.answer(row.command);expect(answer.text,row.command).toEqual(row.text);expect(answer.markdown,row.command).toEqual(row.markdown);}
    const list=botCandidates(s.db,'活动',now);expect(list).toHaveLength(9);expect(list.some(e=>e.title==='候選 0')).toBe(false);
    expect(currentBotEvent(s.db,'2','名额',now)?.id).toBe(list[1]!.id);
    expect(()=>currentBotEvent(s.db,'9','活动',now)).toThrow('1–8');
  });
  it('matches empty lists, terminal and archived selections without exposing private or unpublished activity',()=>{
    const s=setup();s.db.exec("UPDATE events SET lifecycle='ended',archived_at='before' WHERE visibility='public' AND lifecycle!='draft' AND status!='deleted'");
    const selected=commands.filter(c=>!['帮助','我的','发起'].includes(c));
    const expected=python(s.path,"print(json.dumps([dict(text=replies.answer(db,c)[0],markdown=replies.answer_markdown(db,c),keyboard=None) for c in values]))",selected);
    for(const [index,command] of selected.entries())expect(s.answer(command),command).toEqual(expected[index]);
    expect(s.answer('活动',ids.listen.slice(0,8)).text).toContain('已结束报名');
    for(const id of [ids.invite,ids.draft,ids.deleted])expect(s.answer('活动',id).text).toContain('找不到');
  });
  it('never falls back for invalid, missing or ambiguous event prefixes',()=>{
    const s=setup(),base=eventRow(s.db,ids.listen)!,row={...base,id:'aaaaaaaa22222222'};
    s.db.prepare('INSERT INTO events('+Object.keys(row).join(',')+') VALUES('+Object.keys(row).map(()=>'?').join(',')+')').run(...Object.values(row));
    for(const argument of ['aaaaaaaa','deadbeef','0','02','-1','1.0','1x','1 OR 1=1',ids.listen+'0']){
      const expected=python(s.path,"print(json.dumps(dict(text=replies.answer(db,'名额',values)[0],markdown=replies.answer_markdown(db,'名额',values),keyboard=None)))",argument);
      expect(s.answer('名额',argument),argument).toEqual(expected);
    }
    expect(s.answer('名额','AAAAAAAA11111111').text).toContain('上限 12');
  });
  it('reports only settlement totals, version and current closure state, including pending reports and stale closure',()=>{
    for(const state of ['unpublished','published','closed','pending','stale']){
      const s=setup();roster(s.db);
      if(state!=='unpublished')bill(s.db,['closed','pending','stale'].includes(state),state==='stale'?2:1);
      if(state==='stale'){
        // A closure for a previous bill must not mark a new version closed.
        const payload=JSON.stringify({bill_version:1});
        s.db.prepare("INSERT INTO finance_entries(id,event_id,kind,payload_json,occurred_at,actor_id,actor_name,created_at) VALUES('stale',?,'close',?,'before','alice','private actor','before')").run(ids.listen,payload);
      }
      if(state==='pending')s.db.prepare("INSERT INTO finance_reports(id,event_id,reporter_id,reporter_name,payload_json,created_at) VALUES('report',?,'alice','private actor','{\"kind\":\"collection\",\"amount_cents\":77}','before')").run(ids.listen);
      const expected=python(s.path,"print(json.dumps(dict(reply=dict(text=replies.answer(db,'结算',values)[0],markdown=replies.answer_markdown(db,'结算',values),keyboard=None),tasks=bot_views.public_tasks(db,db.execute('SELECT * FROM events WHERE id=?',(values,)).fetchone()))))",ids.listen);
      const actual=s.answer('结算',ids.listen);expect(actual,state).toEqual(expected.reply);expect(botPublicTasks(s.db,eventRow(s.db,ids.listen)!,now),state).toEqual(expected.tasks);
      expect(actual.text).not.toMatch(/private|名字|同行|77/);expect(actual.markdown).not.toMatch(/private|名字|同行/);
    }
  });
  it('retains bounded, sanitized roster names without identifying personal tasks, finance or payment ownership',()=>{
    const s=setup();roster(s.db);
    for(let i=0;i<13;i++)s.db.prepare("INSERT INTO attendees(id,event_id,manager_id,name,payer_kind,status,created_at,updated_at) VALUES(?,?,'alice',?,'manager','confirmed','before','before')").run('extra-'+i,ids.listen,'稱呼'+i+'😀'.repeat(30));
    for(const command of ['活动','名额','报名'] as const){const reply=s.answer(command,ids.listen);expect(reply.text).not.toMatch(/@|evil.test|bad.test/);expect(reply.text).toContain('其余');expect(botContentProblem(reply.markdown,['example.test'])).toBeNull();}
    for(const command of ['待办','出席','结算','我的'] as const){const reply=s.answer(command,ids.listen);expect(reply.text).not.toMatch(/稱呼|同行|private|名字/);}
    expect(s.answer('出席',ids.listen).text).toContain('到场 1 人，迟到 1 人，早退 1 人，缺席 1 人，未核对 13 人');
    expect(s.answer('报名',ids.listen).text).toContain('目前尚未替你占位');
    expect(s.answer('已付款',ids.listen).text).toContain('目前尚未登记');
    expect(s.answer('我的').text).toContain('尚未绑定你的站内身份');
  });
  it('uses a read-only path safely and keeps every table, queued work and asset byte unchanged',()=>{
    const s=setup();roster(s.db);bill(s.db);s.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const before=readFileSync(s.path),files=readdirSync(s.dir);
    for(const command of commands){const reply=readPublicBotReply(s.path,command,ids.listen,options);expect(reply.text.length).toBeGreaterThan(0);}
    const readonly=new Database(s.path,{readonly:true,fileMustExist:true});
    try{expect(()=>readonly.exec("UPDATE events SET title='mutated'")).toThrow(/readonly/);}finally{readonly.close();}
    s.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');expect(readFileSync(s.path)).toEqual(before);expect(readdirSync(s.dir)).toEqual(files);
    expect(()=>readPublicBotReply(join(s.dir,'missing.sqlite3'),'活动','',options)).toThrow();expect(readdirSync(s.dir)).toEqual(files);
  });
  it('refuses recovery candidates, never treats abbreviations as a public data command, and keeps create replies coherent',()=>{
    const s=setup();expect(()=>s.answer('缩写' as PublicBotCommand)).toThrow('asynchronous');
    expect(s.answer('发起','bad')).toEqual(s.answer('发起'));expect(s.answer('发起','1').text).toContain('尚未创建');
    s.db.exec('UPDATE rebuild_storage SET recovery_required=1');expect(()=>s.answer('帮助')).toThrow('Recovery candidate');expect(()=>readPublicBotReply(s.path,'活动','',options)).toThrow('Recovery candidate');
  });
  it('matches estimated end cutoffs in event zones through DST gaps, folds and explicit offsets',()=>{
    const s=setup(),base=eventRow(s.db,ids.listen)!;
    const values=[['2026-11-01T00:30:00','America/New_York',2,'2026-11-01T07:00:00Z'],['2026-03-08T01:30:00','America/New_York',1,'2026-03-08T07:20:00Z'],['2026-03-29T01:30:00','Europe/Berlin',2,'2026-03-29T02:00:00Z'],['2026-11-17T15:00:00','Asia/Taipei',1,stamp],['2026-11-17T09:00:00Z','Asia/Taipei',1,stamp],['invalid','invalid',3,stamp],['2026-02-30T08:00:00','UTC',1,stamp],['2026-02-30T08:00:00Z','UTC',1,stamp],['2026-11-17T08:00:00',null,1,stamp]];
    const expected=python(s.path,`result=[]
for start,zone,duration,at in values:
 bot_views.datetime=type('At',(datetime.datetime,),{'now':classmethod(lambda cls,tz=None:datetime.datetime.fromisoformat(at.replace('Z','+00:00')).astimezone(tz))})
 result.append(bot_views.estimated_over(dict(starts_at=start,timezone=zone,duration_hours=duration,lifecycle='scheduled')))
print(json.dumps(result))`,values);
    expect(values.map(([start,zone,duration,at])=>botEstimatedOver({...base,starts_at:start,timezone:zone,duration_hours:duration} as EventRow,new Date(String(at))))).toEqual(expected);
  });
});
