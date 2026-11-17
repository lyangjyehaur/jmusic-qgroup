import { test, expect } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';
const origin = 'http://127.0.0.1:5082',
  profile = (letter: string) => 'm_' + letter.repeat(32);
test.use({ adminCatalog: true, musicRooms: true });
async function login(context: BrowserContext, user = 'alice') {
  await context.addCookies([
    {
      name: 'kanban_session',
      value: 'fixture-' + user,
      url: origin,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
}
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const rooms = (page: Page) => page.getByRole('region', { name: '分房安排', exact: true });
async function split(page: Page, event = false) {
  await page.goto('/tools/room-lab' + (event ? '?eventId=listen' : ''));
  await expect(page.getByRole('group', { name: /參與成員/ })).toBeVisible();
  if (!event) {
    await page.getByRole('checkbox', { name: /詞庫bob|非常長的合成會員名稱/ }).check();
    await page.getByRole('checkbox', { name: /詞庫orphan/ }).check();
  }
  await button(page, '產生分房建議').click();
  await expect(rooms(page)).toBeVisible();
  await expect(button(page, '重新計分')).toBeEnabled();
  await expect(rooms(page).getByText(/平均/).first()).toBeVisible();
}
async function leave(page: Page) {
  await button(page, '保留分房草稿並離開').click();
}
test('free rooms analyze, split in three modes, preserve manual moves, lookup and reload scoped drafts', async ({
  page,
  context,
}) => {
  await login(context);
  await split(page);
  for (const mode of ['capacity', 'sizes', 'rooms']) {
    await page.getByRole('combobox', { name: '分房依據', exact: true }).selectOption(mode);
    if (mode === 'sizes') await page.getByLabel('各房人數（以逗號分隔）', { exact: true }).fill('1,2');
    else await page.getByLabel(mode === 'rooms' ? '房數' : '每房容量', { exact: true }).fill('2');
    await button(page, '產生分房建議').click();
    await expect(rooms(page).locator('.room-lab-room')).toHaveCount(2);
  }
  await page.getByRole('combobox', { name: '移動 詞庫bob', exact: true }).selectOption('');
  await expect(rooms(page)).toContainText('包間輸入有變更');
  await button(page, '重新計分').click();
  await expect(rooms(page).getByText('包間輸入有變更', { exact: false })).toHaveCount(0);
  await button(page, '分析同房合拍度').click();
  await expect(page.getByRole('region', { name: '同房合拍分析', exact: true })).toContainText('兩兩配對 · 3 組');
  await expect(rooms(page).locator('.room-lab-room')).toHaveCount(2);
  await expect(rooms(page)).toContainText('包間輸入有變更');
  await button(page, '重新計分').click();
  await page.reload();
  await expect(rooms(page).locator('.room-lab-room')).toHaveCount(2);
  await expect(rooms(page)).toContainText('待人工安排 · 1 人');
  await page.getByLabel('固定成分 ID 或聯絡 QQ', { exact: true }).fill('10002');
  await button(page, '定位成員').click();
  await expect(page.getByLabel('搜尋成員名稱或成分 ID', { exact: true })).toHaveValue(profile('b'));
  await expect(page.locator('.room-lab-pool').getByRole('checkbox')).toHaveCount(1);
  await page.getByRole('checkbox', { name: '包含自己', exact: true }).uncheck();
  const another = await context.newPage();
  await another.goto('/tools/room-lab');
  await expect(another.getByRole('checkbox', { name: '包含自己', exact: true })).not.toBeChecked();
  await another.close();
});
test('activity roster keeps unmatched and unselected people and adoption requires review before saving via the existing room editor', async ({
  page,
  context,
}) => {
  await login(context);
  await split(page, true);
  await expect(rooms(page)).toContainText('沒有成分的同行 · 無成分');
  await page.getByRole('checkbox', { name: /小白.*候補/ }).uncheck();
  await expect(rooms(page)).toContainText('包間輸入有變更');
  await page.getByRole('combobox', { name: '移動 小白', exact: true }).selectOption('');
  await expect(rooms(page)).toContainText('小白 · 未加入試算');
  await page.getByRole('checkbox', { name: /小白.*候補/ }).check();
  const selects = rooms(page).locator('.room-lab-room');
  await selects.first().getByLabel(/容量$/).fill('3');
  const target = await selects.first().getByRole('combobox').first().inputValue();
  await page.getByRole('combobox', { name: '移動 沒有成分的同行', exact: true }).selectOption(target);
  await button(page, '重新計分').click();
  await expect(rooms(page)).toContainText('沒有成分的成員不列入合拍分數');
  await button(page, '核對並採用為正式分房').click();
  await leave(page);
  await expect(page.getByRole('region', { name: '採用分房建議', exact: true })).toContainText('沒有成分的同行');
  await expect(button(page, '保存預分包間')).toBeDisabled();
  await button(page, '載入建議到草稿').click();
  for (const select of await page.getByLabel('包間付款人', { exact: true }).all()) {
    const value = await select.locator('option').nth(1).getAttribute('value');
    await select.selectOption(value!);
  }
  await page
    .getByRole('checkbox', {
      name: '已核對包間人員與付款人，確認保存。',
      exact: true,
    })
    .check();
  await button(page, '保存預分包間').click();
  await expect(page.getByText('已保存。', { exact: true })).toBeVisible();
  const viewer = await (await context.request.get('/api/v2/session')).json(),
    saved = await (
      await context.request.get('/api/v2/activities/listen/rooms', {
        headers: { 'X-Account-Scope': viewer.scope },
      })
    ).json();
  expect(saved.rooms.flatMap((room: { person_ids: string[] }) => room.person_ids)).toContain('room-guest');
  expect(saved.rooms.flatMap((room: { person_ids: string[] }) => room.person_ids)).not.toContain('room-bob');
});
test('source failure and source changes keep the draft while disabling scores, sharing and adoption', async ({
  page,
  context,
}) => {
  await login(context);
  await split(page, true);
  const original = await rooms(page).locator('.room-lab-room').count();
  let fail = true;
  await page.route('**/api/v2/music/rooms/source?eventId=listen', async (route) => {
    if (fail)
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'SOURCE_DOWN',
          message: '來源暫時不可用',
        }),
      });
    const response = await route.fetch(),
      body = await response.json();
    body.sourceVersion = 'f'.repeat(64);
    await route.fulfill({ response, json: body });
  });
  await button(page, '核對最新來源，保留包間輸入').click();
  await expect(page.getByRole('alert').first()).toContainText('來源暫時不可用');
  await expect(button(page, '重新計分')).toBeDisabled();
  await expect(rooms(page).locator('.room-lab-room')).toHaveCount(original);
  fail = false;
  await button(page, '核對最新來源，保留包間輸入').click();
  await expect(
    page.getByText('已核對最新來源；包間輸入保留，請重新計分。', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(rooms(page).locator('.room-lab-room')).toHaveCount(original);
  await expect(button(page, '核對並採用為正式分房')).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: /圖片包含/ })).toBeDisabled();
});
test('corrupt drafts are preserved before rebuilding and private room results disappear after account revocation', async ({
  page,
  context,
}) => {
  await login(context);
  await page.goto('/tools/room-lab');
  await expect(page.getByRole('group', { name: /參與成員/ })).toBeVisible();
  const key = await page.evaluate(
    () => Object.keys(sessionStorage).find((key) => key.startsWith('qgroup:rebuild:room-lab:v1:'))!,
  );
  await page.evaluate((key) => sessionStorage.setItem(key, '{broken'), key);
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('原分房草稿無法讀取');
  expect(await page.evaluate((key) => sessionStorage.getItem(key), key)).toBe('{broken');
  await button(page, '另存原稿並建立新試算').click();
  expect(
    await page.evaluate(
      (key) =>
        Object.keys(sessionStorage).some(
          (candidate) => candidate.startsWith(key + ':recovery:') && sessionStorage.getItem(candidate) === '{broken',
        ),
      key,
    ),
  ).toBe(true);
  await page.getByRole('checkbox', { name: /詞庫bob|非常長的合成會員名稱/ }).check();
  await button(page, '產生分房建議').click();
  await expect(rooms(page)).toBeVisible();
  await context.clearCookies();
  await page.evaluate(() => {
    const channel = new BroadcastChannel('qgroup:rebuild:session');
    channel.postMessage('logout');
    channel.close();
  });
  await expect(page.getByRole('link', { name: '登入', exact: true })).toBeVisible();
  await expect(rooms(page)).toHaveCount(0);
  expect(
    await page.evaluate(() => Object.keys(sessionStorage).some((key) => key.startsWith('qgroup:rebuild:room-lab:'))),
  ).toBe(false);
});
test('mobile images, clipboard fallback and long names remain usable without private fields', async ({
  page,
  context,
}) => {
  await login(context);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async () => {
          throw Error('denied');
        },
      },
      configurable: true,
    }),
  );
  await page.route('**/api/v2/music/rooms/source', async (route) => {
    const response = await route.fetch(),
      body = await response.json();
    body.members.find((m: { id: string }) => m.id.endsWith('b'.repeat(32))).name = '非常長的合成會員名稱'.repeat(12);
    await route.fulfill({ response, json: body });
  });
  await split(page);
  await page.getByRole('checkbox', { name: /圖片包含/ }).check();
  await expect(page.getByRole('img', { name: /分房試算/ })).toBeVisible();
  await button(page, '複製分房清單').click();
  await expect(page.getByText('無法自動複製，請選取分房清單手動複製。', { exact: true })).toBeVisible();
  const text = await page.getByRole('textbox', { name: '分房清單', exact: true }).inputValue();
  expect(text).not.toMatch(/不可匯出|gender|m_[abc]{32}|10002/);
  const download = page.waitForEvent('download');
  await button(page, '下載分房圖片').click();
  expect((await download).suggestedFilename()).toBe('分房試算.png');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: 'test-results/unified-room-lab-mobile.png',
    fullPage: true,
  });
});
test('late calculations cannot replace a different activity or return after logout', async ({ page, context }) => {
  await login(context);
  await page.goto('/tools/room-lab?eventId=listen');
  await expect(button(page, '產生分房建議')).toBeEnabled();
  let release!: () => void, captured!: () => void;
  const pending = new Promise<void>((resolve) => {
      release = resolve;
    }),
    ready = new Promise<void>((resolve) => {
      captured = resolve;
    });
  await page.route('**/api/v2/music/rooms/calculate?eventId=listen', async (route) => {
    const response = await route.fetch();
    captured();
    await pending;
    await route.fulfill({ response }).catch(() => {});
  });
  await button(page, '產生分房建議').click();
  await ready;
  await page.getByRole('link', { name: '自由分房', exact: true }).click();
  await leave(page);
  await expect(page.getByRole('heading', { name: '自由分房', level: 1, exact: true })).toBeVisible();
  release();
  await expect(rooms(page)).toHaveCount(0);
  await expect(page.locator('.room-lab-pool')).not.toContainText('沒有成分的同行');
  await page.getByRole('checkbox', { name: /詞庫bob/ }).check();
  let releaseFree!: () => void, capturedFree!: () => void;
  const held = new Promise<void>((resolve) => {
      releaseFree = resolve;
    }),
    received = new Promise<void>((resolve) => {
      capturedFree = resolve;
    });
  await page.route('**/api/v2/music/rooms/calculate', async (route) => {
    const response = await route.fetch();
    capturedFree();
    await held;
    await route.fulfill({ response }).catch(() => {});
  });
  await button(page, '產生分房建議').click();
  await received;
  await context.clearCookies();
  await page.evaluate(() => {
    const channel = new BroadcastChannel('qgroup:rebuild:session');
    channel.postMessage('logout');
    channel.close();
  });
  await expect(page.getByRole('link', { name: '登入', exact: true })).toBeVisible();
  releaseFree();
  await expect(rooms(page)).toHaveCount(0);
});
test('adoption preserves an existing draft until explicitly replaced and keeps a successful receipt after an uncertain response', async ({
  page,
  context,
}) => {
  await login(context);
  await page.goto('/activities/listen/rooms');
  await button(page, '新增包間').click();
  await page.getByLabel('包間名稱', { exact: true }).fill('原稿包間');
  await page.getByRole('link', { name: '按成分試算分房', exact: true }).click();
  await button(page, '保留原稿並離開').click();
  await button(page, '產生分房建議').click();
  await expect(rooms(page)).toBeVisible();
  await button(page, '核對並採用為正式分房').click();
  await leave(page);
  await expect(page.getByLabel('包間名稱', { exact: true })).toHaveValue('原稿包間');
  await expect(button(page, '載入建議到草稿')).toBeDisabled();
  await page
    .getByRole('checkbox', {
      name: '確認以建議替換目前草稿的人員安排',
      exact: true,
    })
    .check();
  await button(page, '載入建議到草稿').click();
  await expect(page.getByLabel('包間名稱', { exact: true }).first()).toHaveValue('原稿包間');
  for (const select of await page.getByLabel('包間付款人', { exact: true }).all()) {
    const value = await select.locator('option').nth(1).getAttribute('value');
    await select.selectOption(value!);
  }
  let intercepted = false,
    originalKey = '';
  await page.route('**/api/v2/activities/listen/rooms', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    if (intercepted) {
      expect(route.request().headers()['idempotency-key']).toBe(originalKey);
      return route.continue();
    }
    intercepted = true;
    originalKey = route.request().headers()['idempotency-key']!;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'UNKNOWN_RESULT', message: '合成回應遺失' }),
    });
  });
  await page
    .getByRole('checkbox', {
      name: '已核對包間人員與付款人，確認保存。',
      exact: true,
    })
    .check();
  await button(page, '保存預分包間').click();
  await expect(button(page, '確認原包間保存結果')).toBeVisible();
  await page.reload();
  await button(page, '確認原包間保存結果').click();
  await expect(page.getByText('已保存。', { exact: true })).toBeVisible();
  expect(intercepted).toBe(true);
});
test('image failures retain a full text fallback, support retry and fall back from native sharing to download', async ({
  page,
  context,
}) => {
  await login(context);
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.toBlob;
    Object.assign(window, { roomImageFailure: true, roomCopied: '' });
    HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
      if ((window as unknown as { roomImageFailure: boolean }).roomImageFailure) {
        callback(null);
        return;
      }
      original.call(this, callback, ...args);
    };
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (text: string) => {
          Object.assign(window, { roomCopied: text });
        },
      },
      configurable: true,
    });
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(navigator, 'share', {
      value: async () => {
        throw Error('synthetic share failure');
      },
      configurable: true,
    });
  });
  await split(page);
  await page.getByRole('checkbox', { name: /圖片包含/ }).check();
  await expect(page.getByRole('alert')).toContainText('圖片產生失敗');
  await button(page, '複製分房清單').click();
  await expect(page.getByText('已複製分房清單。', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { roomCopied: string }).roomCopied)).toContain('詞庫bob');
  await page.evaluate(() => Object.assign(window, { roomImageFailure: false }));
  await button(page, '重新產生圖片').click();
  await expect(page.getByRole('img', { name: /分房試算/ })).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await button(page, '分享分房圖片').click();
  expect((await downloaded).suggestedFilename()).toBe('分房試算.png');
  await expect(page.getByText('分享失敗，已改為下載。', { exact: true })).toBeVisible();
});

test('music erasure removes room drafts and recovery copies across tabs before a new profile can be used', async ({
  page,
  context,
}) => {
  await login(context);
  await split(page);
  await page.evaluate(() => {
    const key = Object.keys(sessionStorage).find((key) => key.startsWith('qgroup:rebuild:room-lab:'))!;
    sessionStorage.setItem(key + ':recovery:synthetic', sessionStorage.getItem(key)!);
  });
  const privacy = await context.newPage();
  await privacy.goto('/me/privacy');
  await privacy.getByRole('radio', { name: '只刪除成分', exact: true }).check();
  await privacy.getByRole('checkbox', { name: '我已確認範圍，了解此操作無法復原', exact: true }).check();
  await privacy.getByRole('button', { name: '確認刪除成分', exact: true }).click();
  await expect(page.getByRole('link', { name: '保存成分', exact: true })).toBeVisible();
  await expect(rooms(page)).toHaveCount(0);
  expect(
    await page.evaluate(() => Object.keys(sessionStorage).some((key) => key.startsWith('qgroup:rebuild:room-lab:'))),
  ).toBe(false);
  await privacy.close();
});
