import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, statSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AbbreviationDelivery } from './abbreviation-delivery';
import { AbbreviationText, maskAbbreviationText } from './abbreviation-text';
import { BotWordMask } from './word-mask';
import { classifyAPIError } from './protocol';
import type { BotAPIResult, QQBotAPI } from './api';
vi.mock('node:fs',async original=>{const actual=await original<typeof import('node:fs')>();return {...actual,renameSync:vi.fn(actual.renameSync)};});
const cleanups:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();vi.mocked(renameSync).mockRestore();});
const token='abcdef0123456789abcdef01',empty=new BotWordMask([]),clock=()=>1000;
function result(ok=true,code:number|null=0,data:Record<string,unknown>={}):BotAPIResult{return {ok,code,data,status:200,kind:ok?'ok':classifyAPIError(code,200,data),platformTrace:null};}
function setup(pageBytes=200){const dir=mkdtempSync(join(tmpdir(),'native-abbrev-delivery-')),root=join(dir,'results');let mask=empty;const loadMask=()=>mask;const delivery=new AbbreviationDelivery(root,{pageBytes,loadMask,token:()=>token,clock});cleanups.push(()=>rmSync(dir,{recursive:true,force:true}));return {dir,root,delivery,loadMask,setMask:(value:BotWordMask)=>{mask=value;},next:()=>new AbbreviationDelivery(root,{pageBytes,loadMask,clock}),meta:()=>JSON.parse(readFileSync(join(root,token+'.json'),'utf8'))};}
function normalized(calls:{group:string;text:string;seq:number;msg_id:string|null;event_id:string|null}[]){return calls.map(c=>({...c,text:c.text.replace(/[0-9a-f]{24}$/,'TOKEN')}));}
describe('native complete abbreviation delivery',()=>{
  it('matches the retained Python calls, cursors, bodies, boundaries and outcomes for success, length rejection, uncertain and failed sends',()=>{
    return (async()=>{
      const scenarios=[{name:'success',text:'完整结果'.repeat(3000),responses:[result()]},{name:'length',text:'长'.repeat(500)+'🙂',responses:[result(false,40054007)]},
        {name:'adaptive',text:'长'.repeat(900),pageBytes:1000,responses:[result(false,40054007),result(false,40054007),result(false,40054007)]},
        {name:'uncertain',text:'正常释义',responses:[result(false,null,{_unconfirmed_http:202}),result()]},
        {name:'code zero uncertain',text:'正常释义',responses:[result(false,0,{_unconfirmed_http:202}),result()]},
        {name:'middle failed',text:'长'.repeat(400),responses:[result(false,40054007),result(),result(false,304061),result()]},
        {name:'interaction',text:'长'.repeat(500),event:true,responses:[result(false,40054007),result()]},
        {name:'complete split',text:'🙂'.repeat(100),pageBytes:200,responses:[result(false,40054007)]},
        {name:'exception',text:'正常释义',throws:true,responses:[result(),result()]}];
      for(const scenario of scenarios){
        const s=setup(scenario.pageBytes),calls:Parameters<typeof normalized>[0]=[],responses=[...scenario.responses];
        const api={replyGroup:vi.fn(async(group:string,text:string,opts:Parameters<QQBotAPI['replyGroup']>[2]={})=>{calls.push({group,text,seq:opts.seq??1,msg_id:opts.msgId??null,event_id:opts.eventId??null});if(scenario.throws&&calls.length===1)throw Error('private exception');return responses.shift()??result();})};
        const expected=JSON.parse(execFileSync('python3',['-c',`import json,sys
from pathlib import Path
from unittest import mock
from qgroup_bot.abbreviation_delivery import AbbreviationDelivery,Page
from qgroup_bot.sensitive_words import WordMask
values=json.load(sys.stdin);calls=[];responses=iter(values['responses'])
class API:
 def reply_group(self,group,text,**kw):
  calls.append(dict(group=group,text=text,seq=kw['seq'],msg_id=kw.get('msg_id'),event_id=kw.get('event_id')))
  if values.get('throws') and len(calls)==1:raise RuntimeError('private')
  r=next(responses,dict(ok=True,code=0,data={}))
  return r['ok'],r['code'],r['data']
root=Path(sys.argv[1]);delivery=AbbreviationDelivery(root,values.get('pageBytes',200))
with mock.patch('qgroup_bot.abbreviation_delivery.load_mask',return_value=WordMask([])),mock.patch('qgroup_bot.abbreviation_delivery.time.time',return_value=1000),mock.patch('qgroup_bot.abbreviation_delivery.secrets.token_hex',side_effect=lambda n:'${token}' if n==12 else '123456789abc'):
 r=delivery.send(API(),'group',Page(values['text']),**({'event_id':'event'} if values.get('event') else {'msg_id':'message'}))
meta=json.loads(next(root.glob('*.json')).read_text()) if root.exists() and list(root.glob('*.json')) else None
body=next(root.glob('*.txt')).read_text() if root.exists() and list(root.glob('*.txt')) else None
print(json.dumps(dict(calls=calls,result=dict(ok=r[0],code=r[1],data=r[2]),meta=meta,body=body)))`,join(s.dir,'python')],{input:JSON.stringify(scenario),encoding:'utf8',env:{PATH:process.env.PATH,PYTHONPATH:process.cwd()},timeout:10000}));
        const actual=await s.delivery.send(api,'group',{text:scenario.text},scenario.event?{eventId:'event'}:{msgId:'message'});
        expect(normalized(calls),scenario.name).toEqual(normalized(expected.calls));expect({ok:actual.ok,code:actual.code,data:actual.data},scenario.name).toEqual(expected.result);
        const names=readdirSync(s.dir).includes('results')?readdirSync(s.root):[];const meta=names.some(name=>name.endsWith('.json'))?s.meta():null;
        expect(meta,scenario.name).toEqual(expected.meta);expect(names.some(n=>n.endsWith('.txt'))?readFileSync(join(s.root,token+'.txt'),'utf8'):null,scenario.name).toEqual(expected.body);
      }
    })();
  });
  it('delivers every scalar and duplicate over multiple passive windows and restarts, without an upstream query or repeating acknowledged text',async()=>{
    const s=setup(),accepted:string[]=[],calls:{seq:number;message:string}[]=[];let current='first';
    const api={replyGroup:async(_group:string,text:string,options:Parameters<QQBotAPI['replyGroup']>[2]={})=>{calls.push({seq:options.seq??1,message:current});if(Buffer.byteLength(text)>220)return result(false,40054007);if(!text.includes('/缩写 继续 '))accepted.push(text);return result();}};
    const original=new AbbreviationText(['【缩写查询】\n','aa','：','释义甲、释义乙、释义甲。'.repeat(80)+'🙂末尾']);
    await s.delivery.send(api,'group',{text:original},{msgId:current});expect(calls.map(c=>c.seq)).toEqual([1,2,3,4,5]);
    for(let round=0;round<30&&readdirSync(s.root).some(n=>n.endsWith('.txt'));round++){
      current='next-'+round;const delivery=s.next(),page=await delivery.continuation('group','继续 '+token);expect(page?.token).toBe(token);await delivery.send(api,'group',page!,{msgId:current});expect(calls.filter(c=>c.message===current).length).toBeLessThanOrEqual(5);
    }
    expect(accepted.join('')).toBe(String(original));expect(readdirSync(s.root)).toEqual([]);
  });
  it('adapts rejected byte budgets while retaining complete emoji and reports event-based continuations without repeating event IDs for chunks',async()=>{
    const s=setup(1000),accepted:string[]=[],notices:string[]=[];
    const api={replyGroup:vi.fn(async(_group:string,text:string)=>{if(Buffer.byteLength(text)>220)return result(false,40054007);(text.includes('/缩写 继续 ')?notices:accepted).push(text);return result();})};
    const text='长'.repeat(500)+'🙂'.repeat(50);await s.delivery.send(api,'group',{text},{eventId:'interaction'});expect(api.replyGroup).toHaveBeenCalledTimes(2);expect(s.meta().budget).toBeLessThanOrEqual(1000);
    for(let round=0;round<30&&readdirSync(s.root).some(n=>n.endsWith('.txt'));round++)await s.next().send(api,'group',(await s.next().continuation('group','继续 '+token))!,{msgId:'next-'+round});
    expect(accepted.join('')).toBe(text);expect(accepted.join('')).not.toContain('\ufffd');expect(notices.length).toBeGreaterThan(0);
  });
  it('reloads and masks pending results after rule edits, retaining trusted boundaries and cursor positions',async()=>{
    const s=setup(),accepted:string[]=[],api={replyGroup:async(_group:string,text:string)=>{if(Buffer.byteLength(text)>220)return result(false,40054007);if(!text.includes('/缩写 继续 '))accepted.push(text);return result();}};
    const text=new AbbreviationText(['长'.repeat(500)+'\n','slg','：','水灵根、正常释义、'.repeat(80)]);await s.delivery.send(api,'group',{text},{msgId:'first'});
    s.setMask(new BotWordMask(['g水','正常释义']));
    for(let round=0;round<40&&readdirSync(s.root).some(n=>n.endsWith('.txt'));round++){const delivery=s.next();const page=await delivery.continuation('group','继续 '+token);expect(page?.token).toBe(token);await delivery.send(api,'group',page!,{msgId:'next-'+round});}
    expect(readdirSync(s.root)).toEqual([]);expect(accepted.join('')).toBe(String(maskAbbreviationText(text,s.loadMask())));expect(accepted.join('')).toContain('slg：水灵根');
  });
  it('protects group, TTL, token, private files and stale snapshots; rejects malformed boundaries and traversals',async()=>{
    const s=setup(),api={replyGroup:vi.fn(async(_group:string,text:string)=>Buffer.byteLength(text)>220?result(false,40054007):result())};
    await s.delivery.send(api,'group',{text:'长'.repeat(1500)},{msgId:'first'});
    expect((await s.delivery.continuation('other','继续 '+token))?.token).toBeUndefined();expect(await s.delivery.continuation('group','yyds')).toBeNull();expect((await s.delivery.continuation('group','继续 ../../etc/passwd'))?.token).toBeUndefined();expect((await s.delivery.continuation('group','继续'))?.text).toContain('完整续读');
    expect(statSync(s.root).mode&0o777).toBe(0o700);for(const name of readdirSync(s.root))expect(statSync(join(s.root,name)).mode&0o777).toBe(0o600);
    const expired=new AbbreviationDelivery(s.root,{clock:()=>4601,loadMask:s.loadMask});expect((await expired.continuation('group','继续 '+token))?.token).toBeUndefined();
    const stale=await s.delivery.continuation('group','继续 '+token);await s.delivery.send(api,'group',stale!,{msgId:'second'});const offset=s.meta().offset;await s.next().send(api,'group',stale!,{msgId:'third'});expect(s.meta().offset).toBeGreaterThan(offset);
    const before=s.meta();for(const ends of [[],[1],[3,2,4500],['bad',4500]]){writeFileSync(join(s.root,token+'.json'),JSON.stringify({...before,section_ends:ends}),{mode:0o600});expect((await s.delivery.continuation('group','继续 '+token))?.token).toBeUndefined();}
    writeFileSync(join(s.root,token+'.json'),JSON.stringify({...before,body:'../outside.txt'}),{mode:0o600});expect((await s.delivery.continuation('group','继续 '+token))?.token).toBeUndefined();
  });
  it('rejects symlinked state and rule failures without exposing pending output or following links',async()=>{
    const s=setup(),outside=join(s.dir,'outside.txt');writeFileSync(outside,'private untouched');const api={replyGroup:vi.fn(async(_group:string,text:string)=>Buffer.byteLength(text)>220?result(false,40054007):result())};
    await s.delivery.send(api,'group',{text:'长'.repeat(500)},{msgId:'first'});const path=join(s.root,token+'.txt');rmSync(path);symlinkSync(outside,path);
    expect((await s.delivery.continuation('group','继续 '+token))?.token).toBeUndefined();expect(readFileSync(outside,'utf8')).toBe('private untouched');
    const fresh=setup(),rejected=new AbbreviationDelivery(fresh.root,{loadMask:()=>{throw Error('private filter failure');}});await rejected.send(api,'group',{text:'must never send'},{});expect(api.replyGroup.mock.calls.at(-1)?.[1]).toContain('无法保存完整');expect(api.replyGroup.mock.calls.flat().join(' ')).not.toContain('must never send');
    chmodSync(join(s.root,token+'.json'),0o644);expect((await s.delivery.continuation('group','继续 '+token))?.token).toBeUndefined();
  });
  it('serializes stale continuations across instances in one process and permits cancellation without a second network send',async()=>{
    const s=setup(),accepted:string[]=[],api={replyGroup:async(_group:string,text:string)=>{if(Buffer.byteLength(text)>220)return result(false,40054007);if(!text.includes('/缩写 继续 '))accepted.push(text);return result();}},text='长'.repeat(2000);
    await s.delivery.send(api,'group',{text},{msgId:'first'});const first=s.next(),second=s.next(),page=await first.continuation('group','继续 '+token);await Promise.all([first.send(api,'group',page!,{msgId:'second'}),second.send(api,'group',page!,{msgId:'third'})]);
    expect(accepted.join('')+String((await s.delivery.continuation('group','继续 '+token))!.text)).toBe(text);
    const interrupted=setup(),stop=new AbortController();let started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});
    const hanging={replyGroup:vi.fn(async()=>{started();return new Promise<BotAPIResult>(()=>{});})};const pending=interrupted.delivery.send(hanging,'group',{text:'完整結果'},{msgId:'first',signal:stop.signal});await ready;stop.abort();await expect(pending).rejects.toThrow();await new Promise(resolve=>setTimeout(resolve,10));expect(hanging.replyGroup).toHaveBeenCalledTimes(1);expect(interrupted.meta().uncertain).toBe(true);expect(interrupted.meta().offset).toBe(0);
  });
  it('rechecks rules before sending a fresh result and supports legacy pending files lacking boundaries',async()=>{
    const s=setup(),api={replyGroup:vi.fn(async(_group:string,_text:string)=>result())};s.setMask(new BotWordMask(['新规则词','g水']));await s.delivery.send(api,'group',{text:new AbbreviationText(['slg','：','水灵根、g水'])},{msgId:'first'});expect(api.replyGroup.mock.calls[0]![1]).toBe('slg：水灵根、[已遮蔽]');
    const other=setup(),rejected={replyGroup:async()=>result(false,304061)};await other.delivery.send(rejected,'group',{text:'新规则词'},{msgId:'first'});const meta=other.meta();delete meta.section_ends;writeFileSync(join(other.root,token+'.json'),JSON.stringify(meta),{mode:0o600});other.setMask(new BotWordMask(['新规则词']));expect(String((await other.next().continuation('group','继续 '+token))?.text)).toBe('[已遮蔽]');
    const bytes=Buffer.from('slg：水灵根、g水'),ends=[3,6,bytes.length];expect(String(AbbreviationText.remaining(bytes.subarray(2),2,ends))).toBe('g：水灵根、g水');expect(()=>AbbreviationText.remaining(Buffer.from([0xff]),0)).toThrow();
  });
  it('preserves an uncertain old cursor when a confirmed segment cannot be persisted, and publishes rule updates atomically',async()=>{
    const s=setup(),api={replyGroup:vi.fn(async(_group:string,_text:string)=>{if(api.replyGroup.mock.calls.length===1)return result(false,40054007);if(api.replyGroup.mock.calls.length===2)vi.mocked(renameSync).mockImplementationOnce(()=>{throw Error('synthetic disk failure');});return result();})};
    const outcome=await s.delivery.send(api,'group',{text:'长'.repeat(500)+'新规则词'},{msgId:'first'});expect(outcome.ok).toBe(false);expect(outcome.data.storage_error).toBe(true);expect(s.meta().offset).toBe(0);expect(s.meta().uncertain).toBe(true);expect(api.replyGroup.mock.calls.at(-1)?.[1]).toContain('续读可能重复');
    const before=readFileSync(join(s.root,token+'.json')),body=readFileSync(join(s.root,token+'.txt'));s.setMask(new BotWordMask(['新规则词']));
    const original=vi.mocked(renameSync).getMockImplementation()!;let writes=0;vi.mocked(renameSync).mockImplementation((a,b)=>{if(++writes===2)throw Error('synthetic metadata publication failure');return original(a,b);});
    expect((await s.delivery.continuation('group','继续 '+token))?.token).toBeUndefined();expect(readFileSync(join(s.root,token+'.json'))).toEqual(before);expect(readFileSync(join(s.root,token+'.txt'))).toEqual(body);vi.mocked(renameSync).mockImplementation(original);
    expect(String((await s.next().continuation('group','继续 '+token))?.text)).toContain('[已遮蔽]');
  });
  it('reads retained Python pending files and lets Python continue a native result with the same boundaries and byte cursor',async()=>{
    const s=setup();
    execFileSync('python3',['-c',`from pathlib import Path
from unittest import mock
import sys
from qgroup_bot.abbreviation_delivery import AbbreviationDelivery
from qgroup_bot.abbreviation_text import AbbreviationText
with mock.patch('qgroup_bot.abbreviation_delivery.time.time',return_value=1000),mock.patch('qgroup_bot.abbreviation_delivery.secrets.token_hex',side_effect=lambda n:'${token}' if n==12 else '123456789abc'):
 delivery=AbbreviationDelivery(Path(sys.argv[1]),200)
 token,meta=delivery._create('group',AbbreviationText(['slg','：','水灵根、g水']))
 meta['offset']=2;delivery._save_meta(token,meta)`,s.root],{env:{PATH:process.env.PATH,PYTHONPATH:process.cwd()}});
    s.setMask(new BotWordMask(['g水']));expect(String((await s.next().continuation('group','继续 '+token))?.text)).toBe('g：水灵根、[已遮蔽]');
    const other=setup(),api={replyGroup:async()=>result(false,304061)};await other.delivery.send(api,'group',{text:new AbbreviationText(['slg','：','水灵根、g水'])},{msgId:'first'});
    const expected=JSON.parse(execFileSync('python3',['-c',`import json,sys
from pathlib import Path
from unittest import mock
from qgroup_bot.abbreviation_delivery import AbbreviationDelivery
from qgroup_bot.sensitive_words import WordMask
with mock.patch('qgroup_bot.abbreviation_delivery.time.time',return_value=1000),mock.patch('qgroup_bot.abbreviation_delivery.load_mask',return_value=WordMask(['g水'])):
 page=AbbreviationDelivery(Path(sys.argv[1])).continuation('group','继续 ${token}')
 print(json.dumps(dict(text=str(page.text),token=page.token)))`,other.root],{encoding:'utf8',env:{PATH:process.env.PATH,PYTHONPATH:process.cwd()}}));
    other.setMask(new BotWordMask(['g水']));const page=await other.next().continuation('group','继续 '+token);expect({text:String(page?.text),token:page?.token}).toEqual(expected);
  });
  it('preserves BOM scalars at field and byte-segment boundaries without advancing the cursor incorrectly',async()=>{
    const s=setup(8),accepted:string[]=[],api={replyGroup:async(_group:string,text:string)=>{if(text.includes('/缩写 继续 '))return result();if(Buffer.byteLength(text)>10)return result(false,40054007);accepted.push(text);return result();}};
    const full=new AbbreviationText(['\ufeffabc','🙂','\ufeff水灵根 xyz']);await s.delivery.send(api,'group',{text:full},{msgId:'first'});
    for(let i=0;i<10&&readdirSync(s.root).some(n=>n.endsWith('.txt'));i++){const service=s.next();await service.send(api,'group',(await service.continuation('group','继续 '+token))!,{msgId:'next-'+i});}
    expect(accepted.join('')).toBe(String(full));expect(readdirSync(s.root)).toEqual([]);
  });
  it('does not send when a caller-provided current policy check refuses delivery',async()=>{
    const s=setup(),api={replyGroup:vi.fn(async()=>result())};await expect(s.delivery.send(api,'group',{text:'private result'},{msgId:'message',beforeSend:()=>{throw Error('Current policy refused');}})).rejects.toThrow('Current policy refused');expect(api.replyGroup).not.toHaveBeenCalled();
  });
});
