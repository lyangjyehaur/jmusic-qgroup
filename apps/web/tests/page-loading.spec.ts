import {readdirSync} from 'node:fs';
import {test,expect} from './fixtures';

const assets=new URL('../../../.rebuild-dist/web/assets/',import.meta.url);
const roomFile=readdirSync(assets).find(name=>/^music-rooms-.*\.js$/.test(name));
if(!roomFile)throw Error('Build the split page assets before browser verification');
const roomPattern='**/assets/'+roomFile;
test.use({musicRooms:true});

test('cold activity navigation loads its page without downloading unrelated management or room-tool pages',async({page})=>{
  const scripts:string[]=[];
  page.on('request',request=>{if(request.resourceType()==='script')scripts.push(new URL(request.url()).pathname);});
  await page.goto('/activities');
  await expect(page.getByRole('heading',{name:'活動',exact:true})).toBeVisible();
  expect(scripts.some(path=>/\/activities-[^/]+\.js$/.test(path))).toBe(true);
  expect(scripts.filter(path=>/\/(?:admin-bot|admin-backups|music-rooms|guide)-[^/]+\.js$/.test(path))).toEqual([]);
  await expect(page.getByRole('banner')).toHaveCount(1);
});

test('a delayed page keeps the existing navigation mounted and starts no room operations before its bundle loads',async({page,context})=>{
  await context.addCookies([{name:'kanban_session',value:'fixture-alice',url:`http://127.0.0.1:${process.env.REBUILD_TEST_PORT ?? 5082}`,httpOnly:true,sameSite:'Lax'}]);
  await page.goto('/people');
  await expect(page.getByRole('heading',{name:'同好',exact:true})).toBeVisible();
  await page.getByRole('banner').evaluate(node=>node.setAttribute('data-loading-fixture','persisted'));
  let release!:()=>void,downloadStarted=false;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const operations:string[]=[];
  page.on('request',request=>{if(request.url().includes('/api/v2/music/rooms'))operations.push(request.method());});
  await page.route(roomPattern,async route=>{downloadStarted=true;await gate;await route.continue();});
  try{
    await page.getByRole('link',{name:'自由分房',exact:true}).click();
    await expect.poll(()=>downloadStarted).toBe(true);
    await expect(page.getByRole('status').filter({hasText:'正在載入頁面…'})).toBeVisible();
    await expect(page.getByRole('banner')).toHaveAttribute('data-loading-fixture','persisted');
    await expect(page.getByRole('navigation',{name:'主要導覽'})).toBeVisible();
    expect(operations).toEqual([]);
    release();
    await expect(page.getByRole('heading',{name:'自由分房',exact:true})).toBeVisible();
    await expect(page.getByRole('banner')).toHaveAttribute('data-loading-fixture','persisted');
    await expect(page.getByRole('status').filter({hasText:'正在載入頁面…'})).toHaveCount(0);
    expect(operations.every(method=>method==='GET')).toBe(true);
  }finally{release();}
});

test('a failed page download provides recovery and a reload restores the same destination without business writes',async({page})=>{
  let writes=0;
  page.on('request',request=>{if(request.url().includes('/api/')&&!['GET','HEAD','OPTIONS'].includes(request.method()))writes++;});
  await page.route(roomPattern,route=>route.fulfill({status:503,contentType:'text/javascript',headers:{'Cache-Control':'no-store'},body:'Synthetic unavailable page bundle'}));
  await page.goto('/tools/room-lab');
  await expect(page.getByRole('heading',{name:'暫時無法顯示頁面',exact:true})).toBeVisible();
  await expect(page.getByText('請重新整理；已保存的分頁草稿會保留。',{exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'回到活動',exact:true})).toBeVisible();
  await page.unroute(roomPattern);
  await page.reload();
  await expect(page).toHaveURL('/tools/room-lab');
  await expect(page.getByRole('heading',{name:'自由分房',exact:true})).toBeVisible();
  expect(writes).toBe(0);
});

test('conflicting legacy bot actions are rejected before any page bundle or activity operation mounts',async({page})=>{
  const activityRequests:string[]=[],registrationScripts:string[]=[];
  page.on('request',request=>{
    if(request.url().includes('/api/v2/activities'))activityRequests.push(request.url());
    if(/\/activity-registration-[^/]+\.js$/.test(new URL(request.url()).pathname))registrationScripts.push(request.url());
  });
  await page.goto('/?event=listen&action=join&action=leave');
  await expect(page.getByText('連結不完整或包含衝突的操作，請重新取得連結。',{exact:true})).toBeVisible();
  expect(activityRequests).toEqual([]);expect(registrationScripts).toEqual([]);
});
