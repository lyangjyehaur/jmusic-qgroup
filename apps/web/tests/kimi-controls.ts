import type { Page } from '@playwright/test';
const labels:Record<string,string>={main:'領域',sub:'細分','领域':'領域','乐队':'樂隊','组合':'組合','社团':'社團','企划':'企劃','1':'只聽過幾首','2':'聽過一些','3':'常聽','4':'本命',public:'公開',invitation:'邀請可見','运动':'運動','约K':'約 K','游戏':'遊戲','出游':'出遊',system:'跟隨系統',light:'淺色',dark:'深色',comfortable:'舒適',compact:'緊湊',gunju:'苔綠',pink:'粉色',blue:'淺藍',yellow:'淺黃',bound:'已取得 UnionID',missing:'QQ 已綁定、缺少 UnionID',unbound:'未綁定 QQ',custom:'自訂',female:'女',male:'男',rare:'共同項／冷門優先',familiar:'我的熟悉度優先'};
export async function chooseOption(page:Page,label:string|RegExp,value:string|{label:string}){
 if(typeof label==='string'&&label.endsWith('喜歡程度')&&await page.locator('.music-level-dialog').count()){
  await chooseMusicLevel(page,typeof value==='string'?labels[value]??value:value.label);return;
 }
 const control=page.getByLabel(label,{exact:true});
 return selectControl(control,value);
}
export async function expectOption(page:Page,label:string|RegExp,value:string){
 const {expect}=await import('@playwright/test');const control=page.getByLabel(label,{exact:true});
 if(await control.evaluate(el=>el.tagName==='FIELDSET'))await expect(control.locator('input[type=radio][value='+JSON.stringify(value)+']')).toBeChecked();
 else if(await control.evaluate(el=>el.tagName==='SELECT'))await expect(control).toHaveValue(value);
 else await expect(control).toContainText(labels[value]??value);
}

export async function toggleMusicTerm(page:Page,name:string){
 await page.locator('.selection-workspace').waitFor();
 const selected=page.getByRole('button',{name:'移除'+name,exact:true});
 if(await selected.count()){await selected.click();return;}
 await page.locator('.quick-add input').fill(name);
 const add=page.locator('.quick-add-results').getByRole('button').filter({hasText:name});
 const sub=/細分|细分/.test(await add.innerText());await add.click();
 if(sub)await chooseMusicLevel(page);
}
export async function chooseMusicLevel(page:Page,label='常聽'){
 const localized=await page.locator('html').getAttribute('lang')==='zh-Hans'?({'本命':'本命','常聽':'常听','聽過一些':'听过一些','只聽過幾首':'只听过几首'}[label]??label):label;
 await page.locator('.music-level-dialog').getByRole('button',{name:localized,exact:true}).click();
 await page.locator('.music-level-dialog').waitFor({state:'hidden'});
}
export async function closeMusicLevel(page:Page){
 await page.locator('.music-level-dialog').getByRole('button',{name:'關閉喜歡程度',exact:true}).click();
 await page.locator('.music-level-dialog').waitFor({state:'hidden'});
}
export async function removeMusicTermFromDetail(page:Page){
 const domain=page.getByRole('button',{name:'取消選取',exact:true});
 const sub=page.getByRole('button',{name:'調整喜歡程度',exact:true});
 await domain.or(sub).click();
 if(await page.locator('.music-level-dialog').count()){
  await page.locator('.music-level-dialog').getByRole('button',{name:'從已選中移除',exact:true}).click();
  await page.locator('.music-level-dialog').waitFor({state:'hidden'});
 }
}
export async function expectMusicTerm(page:Page,name:string,selected=true){
 await page.locator('.selection-workspace').waitFor();
 const {expect}=await import('@playwright/test');await expect(page.getByRole('button',{name:'移除'+name,exact:true})).toHaveCount(selected?1:0);
}
export async function openMusicContact(page:Page){
 const tools=page.locator('.music-profile-tools'),contact=page.getByRole('link',{name:'聯絡 QQ',exact:true});await contact.or(tools.locator('.disclosure-trigger')).first().waitFor();if(await tools.count()&&!await tools.evaluate(el=>el.hasAttribute('data-open')))await tools.locator('.disclosure-trigger').click();
 await contact.click();
}

export async function openAdminTool(page:Page,name:string){
 const tab=['bot 設定','bot 投遞紀錄'].includes(name)?'QQ bot':['重置成分與詞庫','刪除申請'].includes(name)?'隱私審核':name==='成分匯出與歷史備份'?'備份紀錄':name==='音樂詞庫管理'?'活動與內容':'成員／權限';
 await page.getByRole('tab',{name:tab,exact:true}).click();
 await page.locator('.admin-workspace').getByRole('link',{name,exact:true}).click();
}

export async function openActivityTool(page:Page,name:string){
 await page.getByRole('tab',{name:'管理',exact:true}).click();
 await page.getByRole('link',{name,exact:true}).click();
}

export async function openMusicCatalog(page:Page){
 await page.getByRole('link',{name:'音樂詞庫',exact:true}).and(page.locator('.back-link')).click();
}

/** Use Yahha select or segmented options, preserving their stored values. */
export async function selectControl(control: import('@playwright/test').Locator, value: string | {label?:string;value?:string;index?:number}) {
 if(await control.evaluate(el=>el.tagName==='SELECT'))return control.selectOption(value);
 if(await control.evaluate(el=>el.tagName==='FIELDSET')){
  if(typeof value==='object'&&value.label!==undefined)return control.getByRole('radio',{name:value.label,exact:true}).check();
  if(typeof value==='object'&&value.index!==undefined)return control.getByRole('radio').nth(value.index).check();
  return control.locator('input[type=radio][value='+JSON.stringify(typeof value==='string'?value:value.value)+']').check();
 }
 await control.click();
 const page=control.page(),list=page.getByRole('listbox');
 if(typeof value==='object'&&value.label!==undefined)await list.getByRole('option',{name:value.label,exact:true}).click();
 else if(typeof value==='object'&&value.index!==undefined)await list.getByRole('option').nth(value.index).click();
 else {const expected=typeof value==='string'?value:value.value!;await list.getByRole('option').filter({has:page.locator('[data-option-value='+JSON.stringify(expected)+']')}).click();}
}

export async function expectControlValue(control: import('@playwright/test').Locator, value: string | RegExp, options?: {timeout?:number}) {
 const {expect}=await import('@playwright/test');
 if(await control.getAttribute('role')==='combobox'&&await control.evaluate(el=>el.tagName==='BUTTON'))
  await expect(control.locator('[data-option-value]')).toHaveAttribute('data-option-value',value,options);
 else await expect(control).toHaveValue(value,options);
}

export async function expectAvailableOption(control: import('@playwright/test').Locator, value:string, label:string) {
 const {expect}=await import('@playwright/test');await control.click();
 await expect(control.page().getByRole('listbox').locator('[data-option-value='+JSON.stringify(value)+']')).toHaveText(label);
 await control.page().keyboard.press('Escape');
}
