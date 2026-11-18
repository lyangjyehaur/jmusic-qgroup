import { afterEach, it, expect, vi } from 'vitest';
import ts from 'typescript';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderToStaticMarkup } from 'react-dom/server';
import { displayLanguage } from '@qgroup/contracts';
import { openDatabase } from '@qgroup/database';
import { createApp } from '../src/app';
import { displayText, uiText } from '../../web/src/language';
import { offlinePage } from '../../web/src/pwa/offline';
import { transformUILanguage } from '../../web/ui-language';
const require = createRequire(import.meta.url);
afterEach(() => vi.unstubAllGlobals());
function render(source: string, language: string, original = false) {
  vi.stubGlobal('document', { documentElement: { lang: language } });
  const code = ts.transpileModule(original ? source : transformUILanguage(source, '/src/example.tsx'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const output = { Sample: undefined as unknown as () => React.ReactNode };
  new Function('require', 'exports', code)((name: string) => name === './language' ? { displayText, uiText } : require(name), output);
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
it('serves language-specific public shells including HEAD without accounts or cookies and keeps APIs canonical', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qgroup-language-')), db = openDatabase(':memory:');
  writeFileSync(join(directory, 'index.html'), '<!doctype html><html lang="zh-Hant"><div id="root"></div></html>');
  writeFileSync(join(directory, 'static.js'), 'const value="wire";');
  const app = createApp({ db, origin: 'http://localhost:5080', staticRoot: directory });
  try {
    for (const header of ['zh-CN', 'zh-Hant-CN', 'en-US,zh-CN;q=0.9']) for (const path of ['/', '/index.html', '/activities', '/privacy', '/music/index.html']) for (const method of ['GET', 'HEAD'] as const) {
      const response = await app.inject({ method, url: path, headers: { 'accept-language': header } });
      expect(response.statusCode).toBe(200);expect(response.headers['content-language']).toBe(displayLanguage(header));expect(response.headers.vary).toBe('Accept-Language');expect(response.headers['cache-control']).toBe('no-store');expect(response.headers['set-cookie']).toBeUndefined();expect(response.body).toBe(method === 'HEAD' ? '' : `<!doctype html><html lang="${displayLanguage(header)}"><div id="root"></div></html>`);
    }
    const js = await app.inject({ url: '/static.js', headers: { 'accept-language': 'zh-CN' } });expect(js.body).toBe('const value="wire";');expect(js.headers['content-language']).toBeUndefined();
    const api = await app.inject({ url: '/api/v2/activities/PRIVATE', headers: { 'accept-language': 'zh-CN' } });expect(api.statusCode).toBe(404);expect(api.json().message).toBe('找不到活動或尚未公開');expect(api.headers.vary).toBe('Cookie');
    expect(db.prepare('SELECT count(*) AS n FROM users').get()).toEqual({ n: 0 });expect(db.prepare('SELECT count(*) AS n FROM visitor_sessions').get()).toEqual({ n: 0 });
  } finally { await app.close();db.close();rmSync(directory, { recursive: true, force: true }); }
});
it('renders offline instructions in the selected language without including any account, activity or cached data', () => {
  expect(offlinePage('zh-Hans')).toContain('<html lang="zh-Hans">');expect(offlinePage('zh-Hans')).toContain('此页不提供离线账号或活动资料');expect(offlinePage('zh-Hant')).toContain('此頁不提供離線帳號或活動資料');
});
