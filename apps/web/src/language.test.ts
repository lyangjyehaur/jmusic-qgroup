import { afterEach, it, expect, vi } from 'vitest';
import ts from 'typescript';
import { createRequire } from 'node:module';
import { renderToStaticMarkup } from 'react-dom/server';
import { displayLanguage } from '@qgroup/contracts';
import { displayText, displayLocale, uiText, withErrorText, errorText, displayError } from './language';
import { activityDisplayDate } from './activity-summary';
import { transformUILanguage } from '../ui-language';
const require = createRequire(import.meta.url);
afterEach(() => vi.unstubAllGlobals());
function render(source: string, language: string, original = false) {
  vi.stubGlobal('document', { documentElement: { lang: language } });
  const code = ts.transpileModule(original ? source : transformUILanguage(source, '/src/example.tsx'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const output = { Sample: undefined as unknown as () => React.ReactNode };
  new Function('require', 'exports', code)((name: string) => name === './language' ? { displayText, uiText, withErrorText, errorText, displayError } : require(name), output);
  return renderToStaticMarkup(output.Sample());
}
it('shows traditional Chinese for every non-simplified primary browser language even with a simplified fallback', () => {
  for(const language of ['zh-Hant','zh-TW','zh-HK','zh-MO','zh','en','ja-JP','ko-KR','fr-FR','de-DE']) expect(displayLanguage(language+',zh-CN;q=0.8')).toBe('zh-Hant');
  for(const language of ['zh-CN','zh-SG','zh-Hans','zh-Hans-CN']) expect(displayLanguage(language+',en;q=0.8')).toBe('zh-Hans');
});
it('uses the selected script for weekdays while retaining event time zones and UTC+8 display rules', () => {
  for(const language of ['zh-Hans','zh-Hant','en-US','ja','']) {
    vi.stubGlobal('document',{documentElement:{lang:language}});
    expect(displayLocale()).toBe(language==='zh-Hans'?'zh-CN':'zh-TW');
    const local=activityDisplayDate('2026-11-28T16:00:00Z','Asia/Shanghai');
    expect(local).toContain(language==='zh-Hans'?'周日':'週日');expect(local).toContain('00:00');expect(local).not.toContain('GMT+8');
    expect(activityDisplayDate('2026-11-28T16:00:00Z','Asia/Tokyo')).toContain('01:00（GMT+9）');
  }
});
it('localizes field hints and dialog controls while preserving dynamic errors, input data and protocol values', () => {
  const source=`function Field(p:any){return <p>{p.hint}／{p.error}</p>}function Dialog(p:any){return <button aria-label={p.closeLabel}>返回</button>}
    export function Sample(){const raw='后台發 · 帐号後臺';return <><Field hint="顯示時區可留空" error="欄位無效"/><Field hint={raw} error={raw}/><Dialog closeLabel="關閉對話框"/><input value={raw}/></>}`;
  const simplified=render(source,'zh-Hans');expect(simplified).toContain('显示时区可留空／栏位无效');expect(simplified).toContain('aria-label="关闭对话框"');expect(simplified).toContain('后台發 · 帐号後臺／后台發 · 帐号後臺');expect(simplified).toContain('value="后台發 · 帐号後臺"');
  expect(render(source,'zh-Hant')).toBe(render(source,'zh-Hant',true));
});
