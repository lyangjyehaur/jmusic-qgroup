import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures';
import { expectControlValue } from './kimi-controls';

test('active pages route every form control through the Yahha adapter',async()=>{
 const root=fileURLToPath(new URL('../src/',import.meta.url)),unwrapped:string[]=[];
 for(const file of fs.readdirSync(root).filter(f=>f.endsWith('.tsx')&&f!=='kimi-ui.tsx')){
  const source=ts.createSourceFile(file,fs.readFileSync(path.join(root,file),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  function visit(node:ts.Node){
   if(ts.isJsxElement(node)||ts.isJsxSelfClosingElement(node)){
    const tag=(ts.isJsxElement(node)?node.openingElement.tagName:node.tagName).getText(source);
    if(['input','textarea','select','button','details','dialog'].includes(tag)){
     const wrapped=ts.isJsxElement(node.parent)&&node.parent.openingElement.tagName.getText(source)==='Field';
     if(!wrapped)unwrapped.push(file+':'+(source.getLineAndCharacterOfPosition(node.getStart(source)).line+1));
    }
   }
   ts.forEachChild(node,visit);
  }
  visit(source);
 }
 expect(unwrapped).toEqual([]);
});

test('mobile Select keyboard navigation preserves values on Escape and never submits the form',async({page,context})=>{
 const origin=`http://127.0.0.1:${process.env.REBUILD_TEST_PORT??5082}`;
 await context.addCookies([{name:'kanban_session',value:'fixture-alice',url:origin,httpOnly:true,sameSite:'Lax'}]);
 await page.setViewportSize({width:430,height:932});await page.goto('/activities/new');
 const select=page.getByRole('combobox',{name:'活動類型',exact:true});
 await expect(select).toHaveJSProperty('tagName','BUTTON');
 const original=await select.locator('[data-option-value]').getAttribute('data-option-value');
 const writes:string[]=[];page.on('request',request=>{if(request.method()==='POST')writes.push(request.url());});
 await select.focus();await select.press('ArrowDown');await expect(page.getByRole('listbox')).toBeVisible();
 await page.keyboard.press('End');const last=page.getByRole('option').last();await expect(last).toBeFocused();
 const next=await last.locator('[data-option-value]').getAttribute('data-option-value');
 await page.keyboard.press('Escape');await expect(select).toBeFocused();await expectControlValue(select,original!);await expect(page.locator('.yj-select-popup')).not.toBeVisible();
 await select.press('ArrowDown');await expect(page.getByRole('listbox')).toBeVisible();await page.keyboard.press('ArrowDown');await page.keyboard.press('End');await expect(last).toBeFocused();await page.keyboard.press('Enter');
 await expectControlValue(select,next!);await expect(select).toBeFocused();
 await expect(page.getByRole('listbox')).toHaveCount(0);expect(writes).toEqual([]);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('guide deep links reveal Yahha panels and closed disclosures retain their mounted content',async({page})=>{
 await page.goto('/guide#section-7');const section=page.locator('#section-7');
 await expect(section.locator('.disclosure-trigger')).toHaveAttribute('aria-expanded','true');
 await section.locator('.disclosure-trigger').click();await expect(section.locator('.disclosure-trigger')).toHaveAttribute('aria-expanded','false');
 await expect(section.locator('.disclosure-panel p').first()).toHaveCount(1);
 await expect(section.locator('.disclosure-panel p').first()).not.toBeVisible();
});

test('mobile popovers keep content inside the popup and dismiss on Escape and navigation',async({page,context})=>{
 const origin=`http://127.0.0.1:${process.env.REBUILD_TEST_PORT??5082}`;
 await context.addCookies([{name:'kanban_session',value:'fixture-alice',url:origin,httpOnly:true,sameSite:'Lax'}]);
 await page.setViewportSize({width:430,height:932});await page.goto('/activities/listen');
 const popup=page.locator('.menu-popover');
 async function expectContained(selector:string){
  await expect(popup).toBeVisible();
  expect(await popup.evaluate(el=>getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  expect(await popup.evaluate((el,selector)=>{
   const box=el.getBoundingClientRect(),items=Array.from(el.querySelectorAll(selector));
   return items.length>0&&items.every(item=>{const rect=item.getBoundingClientRect();
    return rect.width>0&&rect.height>0&&rect.left>=box.left&&rect.right<=box.right+1&&rect.top>=box.top&&rect.bottom<=box.bottom+1;
   });
  },selector)).toBe(true);
 }
 const activity=page.getByRole('button',{name:'更多活動操作',exact:true});
 await activity.click();await expectContained('a');
 await page.keyboard.press('Escape');await expect(popup).toHaveCount(0);await expect(activity).toBeFocused();
 await activity.click();await popup.getByRole('link',{name:'活動歷史',exact:true}).click();
 await expect(page).toHaveURL(/\/activities\/listen\/history$/);await expect(popup).toHaveCount(0);
 await page.getByRole('dialog').getByRole('button',{name:'返回活動',exact:true}).click();
 const account=page.getByRole('button',{name:'帳號選單',exact:true});
 await account.click();await expectContained('a');
 await page.keyboard.press('Escape');await expect(account).toBeFocused();
 const appearance=page.getByRole('button',{name:'外觀設定',exact:true});
 await appearance.click();await expectContained('[role="combobox"],input[role="switch"]');
 await page.keyboard.press('Escape');await expect(popup).toHaveCount(0);await expect(appearance).toBeFocused();
});
