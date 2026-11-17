import { expect, type Locator, type Page } from '@playwright/test';

export async function checkAdminReceipt(page: Page, inventory: Locator, key: string, committed = true) {
  const receipt = page.waitForResponse(response => response.url().endsWith('/api/v2/admin/operations/' + key));
  await inventory.getByRole('button', { name: '核對結果', exact: true }).click();
  const response = await receipt;
  expect(response.request().method()).toBe('GET');
  expect(response.request().postData()).toBe(null);
  expect(response.request().headers()['x-admin-scope']).toMatch(/^[a-f0-9]{64}$/);
  expect(await response.json()).toEqual({ committed });
  await expect(inventory.getByText(committed
    ? '此操作編號已有回執，請回原頁核對內容及目前權限。'
    : '尚未查到此操作編號的回執，請回原頁確認原操作結果。', { exact: true })).toBeVisible();
}
