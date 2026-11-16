import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { botPlainText, botRosterName, botContentProblem, botTimeChange, renderBotBroadcast, withBotRoster } from './bot-markdown';
import { renderBotTemplate, validateBotTemplate } from './bot-templates';
function python<T>(script:string,input:unknown):T{return JSON.parse(execFileSync('python3',['-c',script],{input:JSON.stringify(input),encoding:'utf8',env:{...process.env,QQ_APP_ID:'',QQ_APP_KEY:''}}));}
const strings=['@all中文 @everyone甲 @all𠀀 @all١','普通文字','## *活動* ~~變更~~ [地點](https://evil.example)','<qqbot-at-everyone /> @everyone <@!123>','![圖](https://evil.example/a) <https://evil.example>','\u0000\u000b換\n行\t和\u200b空白','- 巢狀清單','+ 項目','12. 編號','１２）保留','１２. 項目','١. 項目','1) 項目','11-13 和 -2','\\轉義_|<>[]!#~*`','🧑‍🎤𠀀'.repeat(30),'\ufeff前後\ufeff','\u001c前後\u0085','< QQBOT-AT-user id="1" / >','[連結](https://evil.example/a(b))','@all ＠Everyone https://evil.example/x','[名](x) [名二](y)','\u2003  -  項目 \u2003'];
describe('QQ text and template compatibility',()=>{
  it('matches Python plain sanitization and public roster name boundaries for unsafe syntax, mentions, controls and Unicode',()=>{
    const expected=python<{plain:string[];names:string[]}>(`import json,re,sys
from qgroup_core import bot_markdown as md
values=json.load(sys.stdin)
def name(raw):
 value=md.plain_text(re.sub(r'<@!?[^>]*>','',raw))
 value=re.sub(r'https?://\\S+','',value,flags=re.IGNORECASE)
 value=re.sub(r'@(?:everyone|all)\\b','',value,flags=re.IGNORECASE)
 return value.replace('@','').replace('＠','').strip()[:24] or '未填写称呼'
print(json.dumps(dict(plain=[md.plain_text(v) for v in values],names=[name(v) for v in values])))`,strings);
    expect(strings.map(botPlainText)).toEqual(expected.plain);expect(strings.map(botRosterName)).toEqual(expected.names);
  });
  it('preserves default rich cards, system time changes, roster placement and bounded fallback exactly',()=>{
    const inputs=[
      {label:'活动发起',title:strings[1]!,details:['时间：2099-01-01 18:00',strings[2]!,strings[3]!,''],url:'https://kanban.example/?event=abc&action=join',roster:['正式报名（1 人）：小青','候补（0 人）：暂无'],systemFacts:['- **距开始：1 天**'],notice:[]},
      {label:'结算发布',title:'🧑‍🎤',details:['甲 3.00 元',''],url:'https://kanban.example/?event=abc',roster:[],systemFacts:[],notice:['甲 → 乙：3.00 元']},
    ];
    const expected=python<{rich:string[];rosters:string[];changes:(string|null)[] }>(`import json,sys
from qgroup_core import bot_markdown as md,bot_views
rows=json.load(sys.stdin)
rich=[md.render_broadcast(r['label'],r['title'],r['details'],r['url'],system_facts=r['systemFacts'],notice=r['notice']) for r in rows]
print(json.dumps(dict(rich=rich,rosters=[bot_views.with_roster(text,r['roster'],markdown=True) for text,r in zip(rich,rows)],changes=[md.system_time_change('2026-11-17 19:00','2026-11-18 19:00'),md.system_time_change('x','x'),md.system_time_change(None,'x')])))`,inputs);
    const rich=inputs.map(r=>renderBotBroadcast(r.label,r.title,r.details,r.url,{systemFacts:r.systemFacts,notice:r.notice}));expect(rich).toEqual(expected.rich);expect(rich.map((r,i)=>withBotRoster(r,inputs[i]!.roster,true))).toEqual(expected.rosters);
    expect([botTimeChange('2026-11-17 19:00','2026-11-18 19:00'),botTimeChange('x','x'),botTimeChange(null,'x')]).toEqual(expected.changes);
    const cases=[{text:'短文\n\nhttps://kanban.example',lines:['正式：小青'],md:false},{text:'x'.repeat(3930)+'\nhttps://kanban.example',lines:['過長'.repeat(150)],md:false},{text:'🧑'.repeat(3980),lines:['過長'.repeat(150)],md:true},{text:'plain without URL',lines:['甲'],md:true},{text:'head\n[活動](https://kanban.example)\n> footnote',lines:['乙'],md:true}];
    expect(cases.map(r=>withBotRoster(r.text,r.lines,r.md))).toEqual(python(`import json,sys
from qgroup_core import bot_views
print(json.dumps([bot_views.with_roster(r['text'],r['lines'],markdown=r['md']) for r in json.load(sys.stdin)]))`,cases));
  });
  it('matches Python template grammar, escaped braces, bounds and plain versus rich substitution without evaluating expressions',()=>{
    const templates=['{heading}\n{details}\n{url}','{{literal}} {title} {url}','{title:} {url}','{url!s}','{title.upper} {url}','{title[0]} {url}','{} {url}','{url:>10}','{title:{title}} {url}','{','}','{{url}}','{title}','{url}'+ 'x'.repeat(1995),'{details}{details}{url}','{url}{url}{url}{url}{url}{url}{url}{url}','{{{url}}}','🧑'.repeat(1800)+'{url}'];
    const expected=python<{valid:boolean;plain:string|null;rich:string|null}[]>(`import json,sys
from qgroup_core import bot_settings
values=json.load(sys.stdin)
context=dict.fromkeys(bot_settings.VARIABLES,'')
context.update(heading='## 私人標題 <qqbot-at-everyone />',details='時間：2099-01-01\\n*新地點* <https://evil.example>',title='[*甲*](https://evil.example)',url='https://kanban.example/?event=abc')
result=[]
for value in values:
 try:
  bot_settings.validate_template(value)
  config=dict(templates={'activity_published':value,'activity_published@md':value})
  result.append(dict(valid=True,plain=bot_settings.render(config,'activity_published',context),rich=bot_settings.render(config,'activity_published',context,markdown=True)))
 except Exception:result.append(dict(valid=False,plain=None,rich=None))
print(json.dumps(result))`,templates);
    const context={heading:'## 私人標題 <qqbot-at-everyone />',details:'時間：2099-01-01\n*新地點* <https://evil.example>',title:'[*甲*](https://evil.example)',url:'https://kanban.example/?event=abc'};
    const actual=templates.map(value=>{try{validateBotTemplate(value);const map={activity_published:value,'activity_published@md':value};return {valid:true,plain:renderBotTemplate(map,'activity_published',context),rich:renderBotTemplate(map,'activity_published',context,true)};}catch{return {valid:false,plain:null,rich:null};}});
    expect(actual).toEqual(expected);expect(renderBotTemplate({},'activity_published',context,true)).toBeNull();
    expect(()=>renderBotTemplate({activity_published:'{heading}\n{url}'},'activity_published',{heading:'🧑'.repeat(4000),url:context.url})).toThrow();
  });
  it('preserves content limits by Unicode codepoint and enforces the URL host allowlist in plain and rich bodies',()=>{
    const values=['','  ','\u0000bad','𠀀'.repeat(4000),'𠀀'.repeat(4001),'[活動](https://kanban.example)','https://kanban.example.evil/path','https://user:pw@evil.example/path','https://kanban.example:443/a','<https://evil.example>','https://[invalid','https://kanban.example\ufeffsuffix','https://kanban.example/\u0085https://evil.example'];
    const expected=python<(string|null)[]>(`import json,sys
from qgroup_core import bot_markdown as md
print(json.dumps([md.content_problem(value,['kanban.example']) for value in json.load(sys.stdin)]))`,values);
    expect(values.map(value=>botContentProblem(value,['kanban.example']))).toEqual(expected);
  });
});
