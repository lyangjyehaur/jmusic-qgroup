import type { Page } from '@playwright/test';
export async function setActivityStart(page:Page,value:string){
  await page.getByLabel('活動日期',{exact:true}).fill(value.slice(0,10));
  await page.getByLabel('開始時間',{exact:true}).fill(value.slice(11));
}
export async function advancedActivity(page:Page){
  const toggle=page.getByRole('button',{name:'進階設定',exact:false});
  if(await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();
}
export async function fillAdvancedActivity(page:Page,label:string,value:string){
  await advancedActivity(page);await page.getByLabel(label,{exact:true}).fill(value);
}
