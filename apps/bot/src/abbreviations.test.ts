import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotMaskLoader, BotWordMask } from './word-mask';
import { AbbreviationText, maskAbbreviationText } from './abbreviation-text';
import { abbreviationTerms, AbbreviationLookup, ABBREVIATION_UNAVAILABLE, ABBREVIATION_USAGE, fetchAbbreviations, renderAbbreviations } from './abbreviations';
import { extractAbbreviationArgument, groupBotCommand, quotedBotTexts } from './abbreviation-input';
const cleanup:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();vi.restoreAllMocks();});
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value));
const empty=new BotWordMask([]);
function python(source:string,input:unknown){return JSON.parse(execFileSync('python3',['-c',`import json,sys\nvalues=json.load(sys.stdin)\n${source}`],{encoding:'utf8',input:JSON.stringify(input),timeout:15000,env:{PATH:process.env.PATH,PYTHONPATH:process.cwd()}}));}
function temp(){const dir=mkdtempSync(join(tmpdir(),'native-abbreviation-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
describe('native abbreviation extraction, rules and upstream lookup',()=>{
  it('matches legacy sentence and selected-quote extraction without forwarding links, identities or quote commands',()=>{
    const texts=['这个YYDS啊，真的awsl！YYDS，3q，2026，a，user_name，'+'z'.repeat(33),'yyds https://example.test/awsl www.example.org/abc foo@example.com example.net/xyz <@BOT1> <qqbot-at-user id="BOT2" /> @alice 12345 nbnhhsh','aa bb cc dd ee ff','ftp://example.test/yyds @awsl slg','https://example.test/aa\u0085bb',null,42];
    const payloads=[{}, {content:'<@BOT1>'},{message_type:103,msg_elements:[{content:'今天YYDS',msg_elements:[{content:'真的awsl'},null,{attachments:[{url:'https://private.test'}]}]}]},
      {message_scene:{ext:['ref_msg_idx=chosen']},msg_elements:[{msg_idx:'other',content:'privateword'},{msg_idx:'chosen',content:'YYDS'}]},
      {message_scene:{ext:['ref_msg_idx=missing']},msg_elements:[{msg_idx:'other',content:'privateword'}]},
      ...[null,'yyds',[null,42,{content:42,msg_idx:{}}]].map(msg_elements=>({message_type:103,msg_elements})),
      ...['/帮助','/縮寫 这个YYDS\n真的awsl','/缩写 继续 '+'a'.repeat(24),'/缩写','/unknown','<qqbot-at-user id="BOT1" />'].map(content=>({content,message_type:103,msg_elements:[{content:'/退出 yyds'}]}))];
    const expected=python(`from qgroup_bot.abbreviation_input import extract_argument,quoted_texts\nfrom qgroup_bot.main import group_command\nprint(json.dumps(dict(extracted=extract_argument(values['texts']),quotes=[quoted_texts(p) for p in values['payloads']],commands=[group_command(p) for p in values['payloads']])))`,{texts,payloads});
    expect(extractAbbreviationArgument(texts)).toEqual(expected.extracted);expect(payloads.map(quotedBotTexts)).toEqual(expected.quotes);expect(payloads.map(groupBotCommand)).toEqual(expected.commands);
    const cycle:Record<string,unknown>={content:'yyds'};cycle.msg_elements=[cycle];expect(quotedBotTexts({message_type:103,msg_elements:[cycle]})).toEqual(['yyds']);
  });
  it('matches whole-term coverage, mixed scripts, casefold expansion, allowed expressions and trusted boundaries against Python',()=>{
    const cases=[{words:['测试词','fuck','s','ff'],allowed:[],parts:['前測*試\u200b詞后','、','ＦｕＣＫ','\n','前ß后ﬃ🙂']},
      {words:['甲乙','乙丙','乙丙丁'],allowed:[],parts:['前甲乙丙丁后甲乙']},{words:['测试','大测试词'],allowed:['测试词'],parts:['测试词，测试，大测试词']},
      {words:['abcde'],allowed:['abc','cde'],parts:['abcde']},{words:['测试词'],allowed:[],parts:['前测试','、','词后','\n','测试词']},
      {words:['g水','结尾bb','正文来源'],allowed:[],parts:['slg：水灵根、g\n水、g','、','水']}];
    let state=17;const next=()=>{state=(state*1664525+1013904223)>>>0;return state;};
    for(let n=0;n<120;n++){const word=(max:number)=>Array.from({length:1+next()%max},()=>String.fromCharCode(97+next()%4)).join('');cases.push({words:Array.from({length:15},()=>word(7)),allowed:Array.from({length:3},()=>word(8)),parts:Array.from({length:8},()=>word(9))});}
    const expected=python(`from qgroup_bot.sensitive_words import WordMask\nprint(json.dumps([dict(plain=WordMask(c['words'],c['allowed']).mask(''.join(c['parts'])),parts=WordMask(c['words'],c['allowed']).mask_parts(c['parts'])) for c in values]))`,cases);
    expect(cases.map(c=>{const mask=new BotWordMask(c.words,c.allowed);return {plain:mask.mask(c.parts.join('')),parts:mask.maskParts(c.parts)};})).toEqual(expected);
    const sections=new AbbreviationText(['slg','：','水灵根、g水','\n','aa','：','结尾']);
    expect(String(maskAbbreviationText(sections,new BotWordMask(['g水','结尾aa'])))).toBe('slg：水灵根、[已遮蔽]\naa：结尾');
    for(const invalid of ['test',[42],[''],['***']])expect(()=>new BotWordMask(invalid)).toThrow();expect(()=>new BotWordMask([],['***'])).toThrow();
  });
  it('keeps all 64,578 bundled rules, conversion data and exceptions identical to the legacy source and fails closed on rule edits',()=>{
    for(const file of ['sensitive_words.json','wordlists/traditional_to_simplified.json','wordlists/sources.json','wordlists/local.json','wordlists/houbb-LICENSE.txt','wordlists/konsheng-LICENSE.txt','wordlists/opencc-LICENSE.txt']){
      const digest=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');expect(digest('apps/bot/assets/'+file),file).toBe(digest('qgroup_bot/'+file));}
    const mask=new BotMaskLoader().load();expect(mask.mask('脑残、腦殘、傻逼、雞巴')).toBe('[已遮蔽]、[已遮蔽]、[已遮蔽]、[已遮蔽]');expect(mask.mask('QQ，柑橘，曹操生日快乐，永远的神，音乐大师。')).toBe('QQ，柑橘，曹操生日快乐，永远的神，音乐大师。');
    const dir=temp(),path=join(dir,'rules.json'),base=join(dir,'bundled.json');writeFileSync(path,encode(['测试词']));writeFileSync(base,encode({words:[],allow_words:[]}));const loader=new BotMaskLoader({extraFile:path,bundledFile:base});const first=loader.load();expect(loader.load()).toBe(first);expect(first.mask('测试词 新规则词')).toBe('[已遮蔽] 新规则词');
    writeFileSync(path,encode(['测试词','新规则词']));expect(loader.load().mask('测试词 新规则词')).toBe('[已遮蔽] [已遮蔽]');
    for(const raw of ['{bad','{"wrong":[]}','[42]']){writeFileSync(path,raw);expect(()=>loader.load()).toThrow();}rmSync(path);expect(()=>loader.load()).toThrow();
    for(const value of [[],{words:null},{words:['测试'],allow_words:'bad'}]){writeFileSync(base,encode(value));expect(()=>new BotMaskLoader({bundledFile:base}).load()).toThrow();}
  });
  it('matches all input validation and rendering variants, preserving full candidates, order, duplicate definitions and programming symbols',()=>{
    const terms=['','这是 yyds 吗','https://example.test','<@BOT> yyds','a','x'.repeat(33),'aa bb cc dd ee ff','yyds,','a'.repeat(165),'YYDS，nbnhhsh yyds','aa\u0085bb','aa 、 bb',0,false];
    const expected=python(`from qgroup_bot.abbreviations import _terms\nprint(json.dumps([_terms(t) for t in values]))`,terms);expect(terms.map(abbreviationTerms)).toEqual(expected);
    const candidates=['C#','F#','a_b','a < b','a > b','2 * 3','[原文]','**文字**','a  +  b','https://bad.test','www.bad.test','@all','＠全体','<qqbot-at-everyone />','**正常**\n释义',...Array.from({length:300},(_,i)=>'释义'+i+'长'.repeat(100))];candidates.push(candidates[0]!);
    const cases=[{terms:['aa','bb','cc','dd'],data:[{name:'aa',trans:null,inputting:['不能显示']},{name:'bb',inputting:['候选']},{name:'cc',trans:[]}]},{terms:['aa'],data:[{name:'aa',trans:candidates}]},{terms:['aa'],data:[{name:'aa',inputting:candidates}]},{terms:['slg'],data:[{name:'slg',trans:['水灵根','g：水','g\n水','g','水']}]},{terms:['aa'],data:[{name:'aa',trans:['旧']},{name:'AA',trans:['新']}]}];
    const wanted=python(`from qgroup_bot.abbreviations import _render\nfrom qgroup_bot.sensitive_words import WordMask\nfrom unittest import mock\nwith mock.patch('qgroup_bot.abbreviations.load_mask',return_value=WordMask(['g水'])):\n print(json.dumps([dict(text=str(_render(c['data'],c['terms'])),ends=_render(c['data'],c['terms']).section_ends()) for c in values]))`,cases);
    expect(cases.map(c=>{const text=renderAbbreviations(c.data,c.terms,new BotWordMask(['g水']));return {text:String(text),ends:text.sectionEnds()};})).toEqual(wanted);
    for(const data of [{},[null],[{name:'aa',trans:'bad'}],[{name:'aa',trans:[42]}]])expect(()=>renderAbbreviations(data,['aa'],empty)).toThrow();
  });
  it('only posts normalized terms, returns full oversized results, caches with TTL/byte/LRU limits and rechecks current rules',async()=>{
    let clock=100000,mask=empty;const request=vi.fn(async(_term:string)=>encode([{name:'yyds',trans:['旧释义','测试词']}]));
    const lookup=new AbbreviationLookup({request,loadMask:()=>mask,clock:()=>clock});cleanup.push(()=>lookup.close());
    expect(String(await lookup.answer('YYDS'))).toContain('旧释义、测试词');mask=new BotWordMask(['测试词']);expect(String(await lookup.answer('yyds'))).toContain('旧释义、[已遮蔽]');expect(request).toHaveBeenCalledTimes(1);expect(request.mock.calls[0]![0]).toBe('yyds');
    expect(String(await lookup.answer('aa'))).toContain('过于频繁');clock+=3600001;request.mockResolvedValue(encode([{name:'yyds',trans:['新释义']}]));expect(String(await lookup.answer('yyds'))).toContain('新释义');expect(request).toHaveBeenCalledTimes(2);
    const raw=encode([{name:'aa',trans:['完整释义'.repeat(10000)]}]);const oversized=new AbbreviationLookup({request:async()=>raw,loadMask:()=>empty,cacheBytes:100});cleanup.push(()=>oversized.close());expect(String(await oversized.answer('aa'))).toContain('完整释义'.repeat(10000));expect(oversized.cacheState().bytes).toBe(0);
    const lru=new AbbreviationLookup({request:async term=>encode([{name:term,trans:['正常释义']}]),loadMask:()=>empty,cacheBytes:90,clock:()=>clock});cleanup.push(()=>lru.close());for(const term of ['aa','bb','cc']){clock+=2000;await lru.answer(term);}expect(lru.cacheState().bytes).toBeLessThanOrEqual(90);expect(lru.cacheState().keys).not.toContain('aa');expect(lru.cacheState().keys).toContain('cc');
  });
  it('enforces the 256-entry LRU cap and keeps valid cache hits available during upstream failure cooldown',async()=>{
    let clock=100000;const service=new AbbreviationLookup({request:async term=>{if(term==='error')throw Error('private upstream failure');return encode([{name:term,trans:['释义']}]);},loadMask:()=>empty,clock:()=>clock});cleanup.push(()=>service.close());
    for(let index=0;index<257;index++){clock+=2000;await service.answer('t'+index);}expect(service.cacheState().keys).toHaveLength(256);expect(service.cacheState().keys).not.toContain('t0');
    clock+=2000;expect(await service.answer('error')).toBe(ABBREVIATION_UNAVAILABLE);expect(String(await service.answer('t256'))).toContain('释义');expect(String(await service.answer('unseen'))).toContain('过于频繁');
  });
  it('never sends invalid input; reports malformed responses and missing filters without leaking content, including cached responses',async()=>{
    const request=vi.fn(async()=>encode([{name:'aa',trans:['private explanation']}]));let broken=false;
    const lookup=new AbbreviationLookup({request,loadMask:()=>{if(broken)throw Error('private rule error');return empty;}});cleanup.push(()=>lookup.close());
    for(const input of ['','这是 yyds 吗','aa bb cc dd ee ff','https://private.test'])expect(await lookup.answer(input)).toBe(ABBREVIATION_USAGE);expect(request).not.toHaveBeenCalled();
    expect(String(await lookup.answer('aa'))).toContain('private explanation');broken=true;expect(await lookup.answer('aa')).toBe(ABBREVIATION_UNAVAILABLE);expect(request).toHaveBeenCalledTimes(1);
    for(const raw of ['bad','{}','[null]','[{"name":"aa","trans":[42]}]']){const service=new AbbreviationLookup({request:async()=>Buffer.from(raw),loadMask:()=>empty});cleanup.push(()=>service.close());expect(await service.answer('aa')).toBe(ABBREVIATION_UNAVAILABLE);}
  });
  it('bounds wall time, single flight and abandoned work, ignores late results, preserves cancellation and permits cache hits during cooldown',async()=>{
    let release!:(value:Uint8Array)=>void,clock=100000;const request=vi.fn(()=>new Promise<Uint8Array>(resolve=>{release=resolve;}));
    const lookup=new AbbreviationLookup({request,loadMask:()=>empty,timeoutMs:30,clock:()=>clock});cleanup.push(()=>lookup.close());
    const work=lookup.answer('aa');await new Promise(resolve=>setTimeout(resolve,5));expect(String(await lookup.answer('bb'))).toContain('忙碌');expect(await work).toBe(ABBREVIATION_UNAVAILABLE);
    clock+=11000;expect(await lookup.answer('bb')).toBe(ABBREVIATION_UNAVAILABLE);expect(request).toHaveBeenCalledTimes(1);expect(lookup.cacheState().fetchBusy).toBe(true);
    release(encode([{name:'aa',trans:['late private result']}]));await new Promise(resolve=>setTimeout(resolve,0));expect(lookup.cacheState().bytes).toBe(0);expect(lookup.cacheState().fetchBusy).toBe(false);
    const stop=new AbortController();clock+=11000;const cancelled=lookup.answer('aa',stop.signal);stop.abort();await expect(cancelled).rejects.toThrow();release(encode([]));
  });
  it('uses a real local streaming response with an overall deadline and sends no QQ credentials or chat context',async()=>{
    const originalFetch=globalThis.fetch;let observed:Record<string,unknown>={};const server=createServer((req,res)=>{let body='';req.on('data',chunk=>{body+=String(chunk);});req.on('end',()=>{observed={headers:req.headers,body:JSON.parse(body)};res.writeHead(200,{'Content-Type':'application/json'});let sent=0;const timer=setInterval(()=>{res.write(sent++===0?'[':' ');},5);res.on('close',()=>clearInterval(timer));});});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address() as {port:number};
    vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,options)=>originalFetch('http://127.0.0.1:'+address.port,options));
    const lookup=new AbbreviationLookup({request:fetchAbbreviations,loadMask:()=>empty,timeoutMs:60});
    try{const start=performance.now();expect(await lookup.answer('YYDS')).toBe(ABBREVIATION_UNAVAILABLE);expect(performance.now()-start).toBeLessThan(1000);expect(observed.body).toEqual({text:'yyds'});expect((observed.headers as Record<string,string>).authorization).toBeUndefined();expect((observed.headers as Record<string,string>).cookie).toBeUndefined();}
    finally{lookup.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
});
