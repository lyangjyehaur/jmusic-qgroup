import { afterEach, it, expect, vi } from 'vitest';
import ts from 'typescript';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderToStaticMarkup } from 'react-dom/server';
import { displayLanguage, BOT_KINDS } from '@qgroup/contracts';
import { openDatabase } from '@qgroup/database';
import { createApp } from '../src/app';
import { displayText, uiText, withErrorText, errorText, displayError } from '../../web/src/language';
import { offlinePage } from '../../web/src/pwa/offline';
import { transformUILanguage } from '../../web/ui-language';
import { z } from 'zod';
import { ApiFailure } from '@qgroup/contracts';
const require = createRequire(import.meta.url);
afterEach(() => vi.unstubAllGlobals());
function render(source: string, language: string, original = false) {
  vi.stubGlobal('document', { documentElement: { lang: language } });
  const code = ts.transpileModule(original ? source : transformUILanguage(source, '/src/example.tsx'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const output = { Sample: undefined as unknown as () => React.ReactNode };
  new Function('require', 'exports', code)((name: string) => name === './language' ? { displayText, uiText, withErrorText, errorText, displayError } : require(name), output);
  return renderToStaticMarkup(output.Sample());
}
it('preserves the legacy highest-quality and first-header language strategy', () => {
  const cases: Record<string, string> = { 'zh-CN': 'zh-Hans', 'zh-SG': 'zh-Hans', 'zh-Hans': 'zh-Hans', 'zh-CHS': 'zh-Hans', 'zh-Hans-TW': 'zh-Hans', ZH_cn: 'zh-Hans', 'zh-TW': 'zh-Hant', 'zh-HK': 'zh-Hant', 'zh-MO': 'zh-Hant', 'zh-Hant-CN': 'zh-Hant', zh: 'zh-Hant', 'en-US,zh-CN;q=0.9': 'zh-Hant', ja: 'zh-Hant', '': 'zh-Hant', '*': 'zh-Hant', 'en;q=0.2,zh-CN;q=0.9': 'zh-Hans', 'zh-CN;q=0,en-US;q=1': 'zh-Hant', 'zh-CN;q=broken,en': 'zh-Hant', 'zh-CN;q=0x1,en': 'zh-Hant', 'zh-CN;q=broken;q=1,en': 'zh-Hant', 'zh-CN;q=.8,zh-TW;q=.8': 'zh-Hans', 'zh-TW;q=.8,zh-CN;q=.8': 'zh-Hant' };
  for (const [header, expected] of Object.entries(cases)) expect(displayLanguage(header), header).toBe(expected);
  expect(displayLanguage(undefined)).toBe('zh-Hant');
});
it('converts static JSX text and display attributes while preserving entity and whitespace semantics', () => {
  const source = 'export function Sample(){return <p title="帳號 &amp; 後臺">帳號 &amp; 後臺\n  資料\n</p>}';
  expect(render(source, 'zh-Hant')).toBe(render(source, 'zh-Hant', true));
  expect(render(source, 'zh-Hans')).toBe('<p title="帐号 &amp; 后台">帐号 &amp; 后台 资料</p>');
});
it('leaves user data, submitted values, comparisons, property keys and callbacks byte-for-byte original', () => {
  const raw = '后台發 · 帐号後臺';
  const source = `export function Sample(){const raw=${JSON.stringify(raw)},category='运动',data={'帳號':'後臺'};return <><p>{raw}</p><input value={raw} name="帳號" data-note="後臺"/><select><option value={category}>運動</option></select><p>{category==='运动'?'已選擇':'未選擇'}</p><p>{data['帳號']}</p><button onClick={()=>({category:'运动'})}>保存</button></>}`;
  for (const language of ['zh-Hans', 'zh-Hant']) {
    const html = render(source, language);expect(html).toContain(raw);expect(html).toContain('name="帳號"');expect(html).toContain('data-note="後臺"');expect(html).toContain('value="运动"');expect(html).toContain('<p>後臺</p>');expect(html).toContain(language === 'zh-Hans' ? '<p>已选择</p>' : '<p>已選擇</p>');
  }
});
it('preserves translate=no subtrees and the actual ICP registration number', () => {
  const source = 'export function Sample(){return <><p translate="no" title="後臺">后台發<span>帳號</span></p><p>渝ICP备16002872号-1</p></>}';
  expect(render(source, 'zh-Hans')).toBe(render(source, 'zh-Hant', true));
});
it('retains the existing geographic label while translating surrounding form instructions', () => {
  const source = 'export function Sample(){return <p>開始時間（台北）</p>}';
  expect(render(source, 'zh-Hant')).toBe('<p>開始時間（台北）</p>');expect(render(source, 'zh-Hans')).toBe('<p>开始时间（台北）</p>');
});
it('translates explicitly declared system chunks without converting interpolated user strings', () => {
  const source = 'import {uiText} from "./language";export function Sample(){const raw="后台發";return <p>{uiText("帳號：")+raw}</p>}';
  expect(render(source, 'zh-Hans')).toBe('<p>帐号：后台發</p>');
  expect(() => transformUILanguage('const raw="user";uiText(raw)', '/src/example.ts')).toThrow('static literal');
  expect(() => transformUILanguage('const x=<option>運動</option>', '/src/example.tsx')).toThrow('explicit value');
});
it('localizes explicit template chunks while preserving native content, coercion and evaluation order', () => {
  const source = "import {uiText} from './language';export function Sample(){const order:string[]=[],value={ [Symbol.toPrimitive](hint:string){order.push(hint);return '后台發 · 帐号後臺';} };const first=()=>{order.push('first');return value;},second=()=>{order.push('second');return 0;};const text=`${uiText('帳號：')}${first()} · ${second()}${uiText(' 人候補 · ')}${uiText('未確認')}\\n${null}/${undefined}`;if(order.join(',')!=='first,string,second')throw Error('evaluation changed');return <p>{text}</p>}";
  for (const original of [true, false]) expect(render(source, 'zh-Hant', original)).toBe('<p>帳號：后台發 · 帐号後臺 · 0 人候補 · 未確認\nnull/undefined</p>');
  expect(render(source, 'zh-Hans')).toBe('<p>帐号：后台發 · 帐号後臺 · 0 人候补 · 未确认\nnull/undefined</p>');
  const symbol = "import {uiText} from './language';export function Sample(){return <p>{`${uiText('帳號：')}${Symbol('original')}`}</p>}";
  expect(() => render(symbol, 'zh-Hans')).toThrow(TypeError);expect(() => render(symbol, 'zh-Hans', true)).toThrow(TypeError);
});
it('preserves unmarked templates and foreign tags alongside explicit nested display chunks', () => {
  const source="import {uiText} from './language';export function Sample(){const raw='后台發',tag=(v:TemplateStringsArray)=>v[0];return <><p>{`帳號：${raw}`}</p><p>{tag`後臺`}</p><p>{`${uiText('帳號：')}${`${uiText('後臺：')}${raw}`}`}</p></>}";
  expect(render(source, 'zh-Hans')).toBe('<p>帳號：后台發</p><p>後臺</p><p>帐号：后台：后台發</p>');
  const skipped="import {uiText} from './language';export function Sample(){const raw='后台發';return <p translate=\"no\">{`${uiText('帳號：')}${raw}`}</p>}";
  expect(render(skipped,'zh-Hans')).toBe(render(skipped,'zh-Hans',true));
});
it('localizes fixed local ApiError fallbacks while preserving server messages, codes and status', () => {
  const source=`import {errorText} from './language';class ApiError extends Error{constructor(public status:number,public code:string,message:string){super(message);}}
    export function Sample(){const error=new ApiError(503,'UNKNOWN_ERROR','暫時無法讀取資料');
    if(!(error instanceof ApiError)||error.status!==503||error.code!=='UNKNOWN_ERROR'||error.message!=='暫時無法讀取資料')throw Error('contract changed');
    const raw='后台發 · 帐号後臺',server=new ApiError(422,'VALIDATION',raw);return <p>{errorText(error)}／{errorText(server)}</p>}`;
  expect(render(source,'zh-Hans')).toBe('<p>暂时无法读取资料／后台發 · 帐号後臺</p>');
  expect(render(source,'zh-Hant')).toBe('<p>暫時無法讀取資料／后台發 · 帐号後臺</p>');
});
it('compiles local error displays while retaining exception identity, class, cause and canonical message comparisons', () => {
  const source = `import {errorText} from './language';
    class DraftExpired extends Error {}
    export function Sample(){const cause=new Error('original cause'),error=new DraftExpired('此原稿已因登出或資料刪除失效，請重新載入頁面。',{cause});
    if(!(error instanceof DraftExpired)||error.cause!==cause||error.message!=='此原稿已因登出或資料刪除失效，請重新載入頁面。')throw Error('contract changed');
    return <p>{errorText(error)}</p>}`;
  expect(render(source, 'zh-Hans')).toBe('<p>此原稿已因登出或资料删除失效，请重新载入页面。</p>');
  expect(render(source, 'zh-Hant')).toBe('<p>此原稿已因登出或資料刪除失效，請重新載入頁面。</p>');
  const error = new Error('canonical message'), stack = error.stack;
  expect(withErrorText(error, '帐号', '帳號')).toBe(error);expect(error.message).toBe('canonical message');expect(error.stack).toBe(stack);
  vi.stubGlobal('document', { documentElement: { lang: 'zh-Hans' } });expect(errorText(error)).toBe('帐号');
  vi.stubGlobal('document', { documentElement: { lang: 'zh-Hant' } });expect(errorText(error)).toBe('帳號');
});
it('leaves API, interpolated and untagged error messages original and rejects overlapping compile boundaries', () => {
  const raw='后台發 · 帐号後臺';
  const source=`import {errorText} from './language';export function Sample(){const raw=${JSON.stringify(raw)},error=new Error('帳號：'+raw);return <p>{errorText(error)}</p>}`;
  for(const language of ['zh-Hans','zh-Hant'])expect(render(source,language)).toBe('<p>帳號：'+raw+'</p>');
  expect(errorText(new Error(raw))).toBe(raw);expect(errorText({message:raw})).toBe(raw);
  expect(() => transformUILanguage("new Error('後臺',{cause:new Error('帳號')})", '/src/example.ts')).toThrow('overlapping language boundaries');
});
it('annotates fixed native Error subclass constructors after super while preserving fields, cause and dynamic subclasses', () => {
  const source = `import {errorText} from './language';
    class LinkExpired extends Error { readonly field='original field'; constructor(public token:string,cause:Error){super('裝置連結已失效，請重新產生。',{cause});this.name='LinkExpired';} }
    class DynamicError extends Error { constructor(message:string){super(message);} }
    class Foreign { constructor(public message:string){} }
    class ForeignChild extends Foreign { constructor(){super('帳號原文');} }
    export function Sample(){const cause=new Error('cause'),error=new LinkExpired('original token',cause),stack=error.stack;
      if(!(error instanceof LinkExpired)||error.cause!==cause||error.message!=='裝置連結已失效，請重新產生。'||error.token!=='original token'||error.field!=='original field'||error.name!=='LinkExpired')throw Error('native constructor changed');
      const text=errorText(error);if(error.stack!==stack)throw Error('stack changed');
      return <p>{text}／{errorText(new DynamicError('帳號原文'))}／{new ForeignChild().message}</p>}`;
  expect(render(source,'zh-Hans')).toBe('<p>装置连结已失效，请重新产生。／帳號原文／帳號原文</p>');
  expect(render(source,'zh-Hant')).toBe('<p>裝置連結已失效，請重新產生。／帳號原文／帳號原文</p>');
});
it('explicit displayError preserves the original ZodError and issue data and rejects variable displays', () => {
  const source = `import {displayError,errorText} from './language';import {z} from 'zod';
    export function Sample(){let error:z.ZodError;try{z.object({nickname:z.string()}).parse({nickname:7});throw Error('expected failure');}catch(failure){if(!(failure instanceof z.ZodError))throw failure;error=failure;}
      const issues=error.issues,message=error.message,stack=error.stack;const annotated=displayError(error,'回應資料格式不符，請先核對結果後重試。');
      if(annotated!==error||annotated.issues!==issues||error.message!==message||error.stack!==stack||issues[0]?.path[0]!=='nickname')throw Error('exception changed');return <p>{errorText(error)}</p>}`;
  expect(render(source,'zh-Hans')).toBe('<p>回应资料格式不符，请先核对结果后重试。</p>');
  expect(render(source,'zh-Hant')).toBe('<p>回應資料格式不符，請先核對結果後重試。</p>');
  for(const source of ["displayError(error,message)","displayError(error,'帳號：'+user)","displayError(error)","displayError(error,'帳號',extra)"])
    expect(()=>transformUILanguage(source,'/src/example.ts')).toThrow('one static display literal');
});
it('compiled API network, JSON and successful-response validation failures retain original exceptions and analytics outcomes', async () => {
  const source=readFileSync(new URL('../../web/src/api.ts',import.meta.url),'utf8');
  const code=ts.transpileModule(transformUILanguage(source,'/src/api.ts'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const events:unknown[][]=[],output={api:undefined as unknown as (path:string,schema:z.ZodType,init?:RequestInit)=>Promise<unknown>};
  new Function('require','exports',code)((name:string)=>name==='./language'?{displayText,withErrorText,displayError}:name==='./analytics'?{analyticsRequest:(...args:unknown[])=>events.push(args)}:name==='@qgroup/contracts'?{ApiFailure}:require(name),output);
  for(const language of ['zh-Hans','zh-Hant']){
    vi.stubGlobal('document',{documentElement:{lang:language}});
    const network=new TypeError('canonical network failure'),json=new SyntaxError('canonical JSON failure');
    for(const [failure,status,prompt,simplified] of [[network,0,'連線未完成，請先核對結果後重試。','连线未完成，请先核对结果后重试。'],[json,200,'伺服器回應無法讀取，請先核對結果後重試。','伺服器回应无法读取，请先核对结果后重试。']] as const){
      const stack=failure.stack,message=failure.message;
      vi.stubGlobal('fetch',status===0?async()=>{throw failure;}:async()=>({status,ok:true,json:async()=>{throw failure;}}));
      await expect(output.api('/me/profile',z.object({nickname:z.string()}),{method:'PUT'})).rejects.toBe(failure);
      expect(failure.message).toBe(message);expect(failure.stack).toBe(stack);
      expect(errorText(failure)).toBe(language==='zh-Hans'?simplified:prompt);
      expect(events.at(-1)).toEqual(['/api/v2/me/profile','PUT',status,status===0?'network_error':'parse_error']);
    }
    const issue=z.object({nickname:z.string()}).safeParse({nickname:7});if(issue.success)throw Error('expected schema error');
    const failure=issue.error,issues=failure.issues,message=failure.message;
    vi.stubGlobal('fetch',async()=>({status:200,ok:true,json:async()=>({nickname:7})}));
    const schema=z.object({nickname:z.string()});vi.spyOn(schema,'parse').mockImplementation(()=>{throw failure;});
    await expect(output.api('/me/profile',schema)).rejects.toBe(failure);expect(failure.issues).toBe(issues);expect(failure.message).toBe(message);
    expect(errorText(failure)).toBe(language==='zh-Hans'?'回应资料格式不符，请先核对结果后重试。':'回應資料格式不符，請先核對結果後重試。');
    expect(events.at(-1)).toEqual(['/api/v2/me/profile','GET',200,'parse_error']);
  }
});
it('localizes all frontend bot event labels while preserving the shared keys and canonical bot text', () => {
  const canonical=JSON.stringify(BOT_KINDS),source=readFileSync(new URL('../../web/src/bot-kind-labels.ts',import.meta.url),'utf8');
  for(const language of ['zh-Hans','zh-Hant']){
    vi.stubGlobal('document',{documentElement:{lang:language}});
    const code=ts.transpileModule(transformUILanguage(source,'/src/bot-kind-labels.ts'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    const output={botKindLabels:{} as Record<string,string>};
    new Function('require','exports',code)((name:string)=>name==='./language'?{displayText,uiText,withErrorText,errorText,displayError}:require(name),output);
    expect(Object.keys(output.botKindLabels)).toEqual(Object.keys(BOT_KINDS));
    expect(output.botKindLabels.activity_published).toBe(language==='zh-Hans'?'活动发起':'活動發起');
    expect(output.botKindLabels.finance_closed).toBe(language==='zh-Hans'?'账务已结清':'帳務已結清');
    expect(JSON.stringify(BOT_KINDS)).toBe(canonical);
  }
});
it('serves language-specific public shells including HEAD without accounts or cookies and keeps APIs canonical', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qgroup-language-')), db = openDatabase(':memory:');
  writeFileSync(join(directory, 'index.html'), '<!doctype html><html lang="zh-Hant"><div id="root"></div></html>');
  writeFileSync(join(directory, 'static.js'), 'const value="wire";');
  const app = createApp({ db, origin: 'http://localhost:5080', staticRoot: directory });
  try {
    for (const header of ['zh-CN', 'zh-Hant-CN', 'en-US,zh-CN;q=0.9']) for (const path of ['/', '/index.html', '/activities', '/privacy', '/music/index.html','/guide','/guide.html']) for (const method of ['GET', 'HEAD'] as const) {
      const response = await app.inject({ method, url: path, headers: { 'accept-language': header } });
      expect(response.statusCode).toBe(200);expect(response.headers['content-language']).toBe(displayLanguage(header));expect(response.headers.vary).toBe('Accept-Language');expect(response.headers['cache-control']).toBe('no-store');expect(response.headers['set-cookie']).toBeUndefined();expect(response.body).toBe(method === 'HEAD' ? '' : `<!doctype html><html lang="${displayLanguage(header)}"><div id="root"></div></html>`);
    }
    const js = await app.inject({ url: '/static.js', headers: { 'accept-language': 'zh-CN' } });expect(js.body).toBe('const value="wire";');expect(js.headers['content-language']).toBeUndefined();
    const api = await app.inject({ url: '/api/v2/activities/PRIVATE', headers: { 'accept-language': 'zh-CN' } });expect(api.statusCode).toBe(404);expect(api.json().message).toBe('找不到活動或尚未公開');expect(api.headers.vary).toBe('Cookie');
    expect((await app.inject({method:'POST',url:'/guide.html'})).statusCode).toBe(404);
    expect(db.prepare('SELECT count(*) AS n FROM users').get()).toEqual({ n: 0 });expect(db.prepare('SELECT count(*) AS n FROM visitor_sessions').get()).toEqual({ n: 0 });
  } finally { await app.close();db.close();rmSync(directory, { recursive: true, force: true }); }
});
it('renders offline instructions in the selected language without including any account, activity or cached data', () => {
  expect(offlinePage('zh-Hans')).toContain('<html lang="zh-Hans">');expect(offlinePage('zh-Hans')).toContain('此页不提供离线账号或活动资料');expect(offlinePage('zh-Hant')).toContain('此頁不提供離線帳號或活動資料');
});
