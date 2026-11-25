// Compare the actual supplied prototype and integrated UI in the same browser.
// Usage: node tools/rebuild/compare-kimi-activity-cta.mjs <prototype URL> <web URL> <output directory>
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const [prototypeURL, webURL, output] = process.argv.slice(2);
assert(prototypeURL && webURL && output, 'Provide both running local URLs and an output directory');
const directory = resolve(output); await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const properties = ['width','height','minHeight','padding','fontFamily','fontSize','fontWeight','lineHeight','gap','color','backgroundColor','border','borderRadius','boxShadow','outline','outlineOffset','transform'];
const results = [], differences = [];
try {
  for (const preset of ['pink','gunju','blue','yellow']) for (const width of [1440,390]) {
    const pages = [];
    for (const [name, url] of [['prototype', prototypeURL], ['integrated', webURL]]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      await context.addInitScript(({name,preset}) => {
        if (name === 'prototype') localStorage.setItem('gunju.yahhaPreset', preset);
        else localStorage.setItem('qgroup:appearance:v1', JSON.stringify({theme:'light',preset,density:'comfortable',wallpapers:false}));
      }, {name,preset});
      const page = await context.newPage(); await page.goto(new URL('/activities', url).href);
      const button = page.locator('.activities-page .page-header .page-actions button'); await button.waitFor();
      assert.equal(await button.textContent(), '新增活動');
      pages.push({name,context,page,button});
    }
    for (const state of ['normal','hover','focus','pressed']) {
      const pair = [];
      for (const {name,page,button} of pages) {
        await page.mouse.move(0,0); await button.evaluate(el=>el.blur());
        if (state === 'hover') await button.hover();
        if (state === 'focus') { await page.keyboard.press('Tab'); await button.focus(); }
        if (state === 'pressed') { await button.hover(); await page.mouse.down(); }
        await page.waitForTimeout(180);
        const measured = await button.evaluate((el, properties) => {
          const style=getComputedStyle(el), box=el.getBoundingClientRect(), header=el.closest('.page-header').getBoundingClientRect(), icon=el.querySelector('svg');
          return {styles:Object.fromEntries(properties.map(key=>[key,style[key]])),rightInset:header.right-box.right,icon:[icon.getAttribute('width'),icon.getAttribute('height')],appearance:el.dataset.appearance};
        }, properties);
        pair.push(measured);
        if (state === 'normal' && preset === 'pink') {
          const box=await button.boundingBox();
          await page.screenshot({path:resolve(directory,`${name}-${width}.png`),clip:{x:box.x-8,y:box.y-8,width:box.width+16,height:box.height+20}});
          await page.screenshot({path:resolve(directory,`${name}-page-${width}.png`)});
        }
        if (state === 'pressed') { await page.mouse.move(0,0); await page.mouse.up(); }
      }
      const record={preset,width,state,prototype:pair[0],integrated:pair[1]};results.push(record);
      if (JSON.stringify(pair[0])!==JSON.stringify(pair[1])) differences.push(record);
    }
    for (const {context} of pages) await context.close();
  }
} finally { await browser.close(); }
await writeFile(resolve(directory,'comparison.json'),JSON.stringify({comparisons:results.length,differences,results},null,2));
assert.equal(differences.length,0,`${differences.length} visual comparisons differ; inspect comparison.json`);
console.log(`${results.length} prototype comparisons matched: four palettes, desktop/mobile, normal/hover/focus/pressed`);
