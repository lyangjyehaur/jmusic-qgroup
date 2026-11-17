import { createServer, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { BrowserContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';
test.use({ serviceWorkers: 'allow' });
const dist = new URL('../../../.rebuild-dist/web/', import.meta.url), worker = readFileSync(new URL('sw.js', dist), 'utf8'), retire = readFileSync(new URL('music/sw.js', dist), 'utf8'), oldWorker = readFileSync(new URL('../../../music_site/public/sw.js', import.meta.url), 'utf8'), shell = readFileSync(new URL('index.html', dist), 'utf8'), build = shell.match(/name="qgroup-build" content="([a-f0-9]{64})"/)![1]!;
/** Extra synthetic host isolates real SW update lifecycle from the API's source tree. */
async function host() {
    const state = { version: build, retiring: true, broken: false, assetFailure: false };
    const send = (response: ServerResponse, status: number, type: string, body: string) => { response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' }); response.end(body); };
    const server = createServer(async (request, response) => {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname;
        if (path === '/sw.js')
            return send(response, 200, 'text/javascript', state.broken ? 'invalid javascript }' : worker.replaceAll(build, state.version));
        if (path === '/music/sw.js')
            return send(response, 200, 'text/javascript', state.retiring ? retire : oldWorker);
        if (path === '/other/sw.js')
            return send(response, 200, 'text/javascript', "self.addEventListener('install',event=>self.skipWaiting());");
        if (path === '/icon-512.png' && state.assetFailure)
            return send(response, 503, 'text/plain', 'Synthetic asset download failure');
        if (path === '/music/test-old.html' || path === '/other/test.html')
            return send(response, 200, 'text/html', '<!doctype html><title>Old synthetic page</title><h1>Old synthetic page</h1>');
        try {
            const headers: Record<string, string> = {};
            if (request.headers.cookie)
                headers.Cookie = request.headers.cookie;
            const upstream = await fetch('http://127.0.0.1:5082' + request.url, { headers, redirect: 'manual' });
            for (const [key, value] of upstream.headers)
                if (!['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(key))
                    response.setHeader(key, value);
            response.statusCode = upstream.status;
            const body = upstream.headers.get('content-type')?.includes('text/html') ? (await upstream.text()).replaceAll(build, state.version) : Buffer.from(await upstream.arrayBuffer());
            response.end(body);
        }
        catch {
            send(response, 502, 'text/plain', 'Synthetic upstream unavailable');
        }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    return { state, origin, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
async function controlled(page: Page) { await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? '')).toMatch(/\/sw.js$/); }
async function cacheKeys(page: Page) { return page.evaluate(() => caches.keys()); }
async function ready(page: Page) { await controlled(page); await expect.poll(() => cacheKeys(page)).toContain('qgroup-unified-shell-' + build); }
async function cookie(context: BrowserContext, origin: string) { await context.addCookies([{ name: 'kanban_session', value: 'fixture-alice', url: origin, httpOnly: true, sameSite: 'Lax' }]); }
test('root and installed legacy manifests preserve one app identity and expose valid native icons', async ({ page, request }) => {
    const native = await request.get('/manifest.webmanifest'), legacy = await request.get('/music/manifest.json');
    expect(native.headers()['cache-control']).toBe('no-store');
    expect(legacy.headers()['cache-control']).toBe('no-store');
    const manifest = await native.json();
    expect(await legacy.json()).toEqual(manifest);
    expect(manifest).toMatchObject({ id: '/music/index.html', name: '群聚', start_url: '/activities', scope: '/', display: 'standalone' });
    for (const size of [192, 512]) {
        const icon = await request.get('/icon-' + size + '.png');
        expect(icon.status()).toBe(200);
        const bytes = await icon.body();
        expect(bytes.readUInt32BE(16)).toBe(size);
        expect(bytes.readUInt32BE(20)).toBe(size);
    }
    for (const path of ['/sw.js', '/music/sw.js']) {
        const response = await request.get(path);
        expect(response.status()).toBe(200);
        expect(response.headers()['content-type']).toContain('javascript');
        expect(response.headers()['cache-control']).toBe('no-store');
    }
    await page.goto('/me/app');
    await ready(page);
    await expect(page.getByRole('heading', { name: '應用程式', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.querySelector<HTMLLinkElement>('link[rel="manifest"]')?.getAttribute('href'))).toBe('/manifest.webmanifest');
    await page.setViewportSize({ width: 360, height: 800 });
    await expect(page.locator('header.header')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/unified-pwa-mobile.png', fullPage: true });
});
test('the active root worker preserves the complete synthetic QQ redirect and a native music save', async ({ page, context }) => {
    await page.goto('/me/app');
    await ready(page);
    await page.goto('/login?returnTo=%2Fme%2Faccounts');
    const consent = page.getByRole('checkbox');
    if (await consent.count()) await consent.check();
    await page.getByRole('button', { name: '前往 QQ 登入', exact: true }).click();
    await page.getByRole('button', { name: '確認登入', exact: true }).click();
    await expect(page.getByRole('heading', { name: '測試帳號 browser-default', exact: true })).toBeVisible();
    expect((await (await context.request.get('/api/v2/session')).json()).authenticated).toBe(true);
    let activityWrites = 0;
    page.on('request', request => { if (request.url().includes('/api/v2/activities/') && ['POST','PUT','DELETE'].includes(request.method())) activityWrites++; });
    await page.goto('/?event=listen&action=join');
    await expect(page).toHaveURL('/activities/listen/signup');
    await expect(page.getByRole('heading', { name: '週末一起聽日系音樂', exact: true })).toBeVisible();
    expect(activityWrites).toBe(0);
    await page.goto('/me/music');
    await page.getByRole('button', { name: 'Aimer', exact: true }).click();
    await page.getByRole('button', { name: '保存我的成分', exact: true }).click();
    await expect(page.getByText('已保存。', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Aimer', exact: true })).toHaveAttribute('aria-pressed', 'true');
});
test('offline navigation reveals no cached account or activity, and SW ignores all API/auth methods and poisoned caches', async ({ page, context }) => {
    const h = await host();
    try {
        await cookie(context, h.origin);
        await page.goto(h.origin + '/activities/listen');
        await ready(page);
        await expect(page.getByRole('heading', { name: '週末一起聽日系音樂', exact: true })).toBeVisible();
        const cached = await page.evaluate(async () => { const names = await caches.keys(), result: Record<string, string[]> = {}; for (const name of names)
            result[name] = (await (await caches.open(name)).keys()).map(r => new URL(r.url).pathname); return result; });
        for (const paths of Object.values(cached))
            expect(paths.every(path => path.startsWith('/assets/') || ['/icon.svg', '/icon-192.png', '/icon-512.png', '/.qgroup-worker-retirements'].includes(path))).toBe(true);
        await page.evaluate(async () => { const cache = await caches.open('unrelated-private-fixture'); for (const path of ['/api/v2/session', '/api/v2/activities/listen', '/auth/qq/callback?code=secret', '/music/api/me', '/activities/listen'])
            await cache.put(path, new Response('PRIVATE SYNTHETIC SECRET')); });
        await context.setOffline(true);
        for (const [path, method] of [['/api/v2/session', 'GET'], ['/api/v2/activities/listen', 'GET'], ['/auth/qq/callback?code=secret', 'GET'], ['/music/api/me', 'GET'], ['/.qgroup-worker-retirements', 'GET'], ['/api/v2/activities/listen/registration', 'POST']])
            expect(await page.evaluate(async ({ path, method }) => { try {
                return await (await fetch(path!, { method })).text();
            }
            catch {
                return 'network failed';
            } }, { path, method })).toBe('network failed');
        const response = await page.goto(h.origin + '/activities/listen');
        expect(response?.status()).toBe(503);
        await expect(page.getByRole('heading', { name: '暫時無法連線', exact: true })).toBeVisible();
        await expect(page.locator('body')).not.toContainText('PRIVATE SYNTHETIC SECRET');
        await expect(page.locator('body')).not.toContainText('小青');
        await context.setOffline(false);
        await page.reload();
        await expect(page.getByRole('heading', { name: '週末一起聽日系音樂', exact: true })).toBeVisible();
        expect(await cacheKeys(page)).toContain('unrelated-private-fixture');
    }
    finally {
        await context.setOffline(false);
        await page.goto('about:blank');
        await h.close();
    }
});
test('an update waits for explicit activation and does not reload any editing tab or delete its older asset cache', async ({ page, context }) => {
    const h = await host();
    const second = await context.newPage();
    page.on('dialog', dialog => void dialog.accept());
    try {
        await cookie(context, h.origin);
        await page.goto(h.origin + '/activities/new');
        await ready(page);
        await page.getByLabel('活動名稱', { exact: true }).fill('更新前保留的草稿');
        await second.goto(h.origin + '/me/app');
        await controlled(second);
        await page.evaluate(async ({ build }) => { await (await caches.open('qgroup-unified-shell-' + build)).put('/assets/previous-chunk-abc12345.js', new Response('old chunk')); await (await caches.open('unrelated-cache')).put('/assets/unrelated-chunk-abc12345.js', new Response('unrelated secret')); }, { build });
        h.state.version = 'f'.repeat(64);
        await second.getByRole('button', { name: '檢查更新', exact: true }).click();
        await expect(second.getByRole('button', { name: '啟用已下載版本', exact: true })).toBeVisible();
        await expect(page.getByLabel('活動名稱', { exact: true })).toHaveValue('更新前保留的草稿');
        expect(await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration('/'))?.waiting)).toBe(true);
        expect(await cacheKeys(second)).toContain('qgroup-unified-shell-' + h.state.version);
        await second.getByRole('button', { name: '啟用已下載版本', exact: true }).click();
        await expect(second.getByRole('button', { name: '保存草稿後重新載入', exact: true })).toBeVisible();
        await expect(page.getByLabel('活動名稱', { exact: true })).toHaveValue('更新前保留的草稿');
        expect(await cacheKeys(second)).toContain('qgroup-unified-shell-' + build);
        await context.setOffline(true);
        expect(await page.evaluate(async () => await (await fetch('/assets/previous-chunk-abc12345.js')).text())).toBe('old chunk');
        expect(await page.evaluate(async () => { try {
            return await (await fetch('/assets/unrelated-chunk-abc12345.js')).text();
        }
        catch {
            return 'network failed';
        } })).toBe('network failed');
        await context.setOffline(false);
        await second.getByRole('button', { name: '保存草稿後重新載入', exact: true }).click();
        await expect.poll(() => second.evaluate(() => document.querySelector<HTMLMetaElement>('meta[name="qgroup-build"]')?.content)).toBe(h.state.version);
        expect(await cacheKeys(second)).toContain('qgroup-unified-shell-' + build);
        await page.reload();
        await expect(page.getByLabel('活動名稱', { exact: true })).toHaveValue('更新前保留的草稿');
        await expect.poll(() => cacheKeys(page)).not.toContain('qgroup-unified-shell-' + build);
        expect(await cacheKeys(page)).toContain('qgroup-unified-shell-' + h.state.version);
    }
    finally {
        await context.setOffline(false);
        await page.goto('about:blank');
        await second.close();
        await h.close();
    }
});
test('retiring the exact legacy registration waits for old clients to close and preserves unrelated caches and browser drafts', async ({ page, context }) => {
    const h = await host();
    h.state.retiring = false;
    const old = await context.newPage();
    try {
        await old.goto(h.origin + '/music/test-old.html');
        await old.evaluate(async () => { await navigator.serviceWorker.register('/music/sw.js', { scope: '/music/' }); await navigator.serviceWorker.ready; });
        await controlled(old);
        await old.evaluate(async () => { sessionStorage.setItem('old-draft', 'legacy original'); sessionStorage.setItem('controller-changes', '0'); navigator.serviceWorker.addEventListener('controllerchange', () => { sessionStorage.setItem('controller-changes', String(Number(sessionStorage.getItem('controller-changes')) + 1)); location.reload(); }); localStorage.setItem('unrelated-preference', 'keep'); await (await caches.open('qgroup-music-react-synthetic')).put('/music/ui.css', new Response('old CSS')); await (await caches.open('other-app-cache')).put('/other/file', new Response('keep')); await navigator.serviceWorker.register('/other/sw.js', { scope: '/other/' }); });
        h.state.retiring = true;
        await page.goto(h.origin + '/me/app');
        await ready(page);
        await page.getByRole('button', { name: '檢查更新', exact: true }).click();
        await expect(page.getByText('舊成分站離線元件待退役；請保存草稿，關閉舊成分站視窗後重新開啟。', { exact: false })).toBeVisible();
        await expect.poll(() => old.evaluate(async () => !!(await navigator.serviceWorker.getRegistration('/music/'))?.waiting)).toBe(true);
        expect(await old.evaluate(() => sessionStorage.getItem('old-draft'))).toBe('legacy original');
        expect(await old.evaluate(() => sessionStorage.getItem('controller-changes'))).toBe('0');
        expect(await cacheKeys(page)).toContain('qgroup-music-react-synthetic');
        expect(new URL(old.url()).pathname).toBe('/music/test-old.html');
        await old.close();
        await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).some(r => new URL(r.scope).pathname === '/music/'))).toBe(false);
        await expect.poll(() => cacheKeys(page)).not.toContain('qgroup-music-react-synthetic');
        expect(await cacheKeys(page)).toContain('other-app-cache');
        expect(await page.evaluate(() => localStorage.getItem('unrelated-preference'))).toBe('keep');
        expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).some(r => new URL(r.scope).pathname === '/other/'))).toBe(true);
    }
    finally {
        if (!old.isClosed())
            await old.close();
        await page.goto('about:blank');
        await h.close();
    }
});
test('failed worker downloads retain the active version and its cache, with a retryable update status', async ({ page }) => {
    const h = await host();
    try {
        await page.goto(h.origin + '/me/app');
        await ready(page);
        h.state.broken = true;
        await page.getByRole('button', { name: '檢查更新', exact: true }).click();
        await expect(page.getByRole('alert')).toContainText('無法檢查離線元件');
        expect(await cacheKeys(page)).toContain('qgroup-unified-shell-' + build);
        expect(await page.evaluate(() => navigator.serviceWorker.controller?.state)).toBe('activated');
        h.state.broken = false;
        await page.getByRole('button', { name: '檢查更新', exact: true }).click();
        await expect(page.getByText('已檢查更新；下載完成後會顯示可用版本。', { exact: true })).toBeVisible();
    }
    finally {
        await page.goto('about:blank');
        await h.close();
    }
});
test('an incomplete precache rejects the update, deletes its partial cache, and allows a clean retry', async ({ page }) => {
    const h = await host();
    try {
        await page.goto(h.origin + '/me/app');
        await ready(page);
        h.state.version = 'e'.repeat(64);
        h.state.assetFailure = true;
        await page.getByRole('button', { name: '檢查更新', exact: true }).click();
        await expect(page.getByRole('alert')).toContainText('更新下載失敗，原版本仍保留');
        await expect.poll(() => cacheKeys(page)).not.toContain('qgroup-unified-shell-' + h.state.version);
        expect(await cacheKeys(page)).toContain('qgroup-unified-shell-' + build);
        expect(await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration('/'))?.waiting)).toBe(false);
        h.state.assetFailure = false;
        await page.getByRole('button', { name: '檢查更新', exact: true }).click();
        await expect(page.getByRole('button', { name: '啟用已下載版本', exact: true })).toBeVisible();
        expect(await cacheKeys(page)).toContain('qgroup-unified-shell-' + h.state.version);
    }
    finally {
        await page.goto('about:blank');
        await h.close();
    }
});
test('a newer download can supersede a waiting version without reporting a failed installation', async ({ page }) => {
    const h = await host();
    try {
        await page.goto(h.origin + '/me/app');
        await ready(page);
        h.state.version = 'c'.repeat(64);
        await page.getByRole('button', { name: '檢查更新', exact: true }).click();
        await expect(page.getByRole('button', { name: '啟用已下載版本', exact: true })).toBeVisible();
        h.state.version = 'b'.repeat(64);
        await page.getByRole('button', { name: '檢查更新', exact: true }).click();
        await expect.poll(() => page.evaluate(async () => {
            const waiting = (await navigator.serviceWorker.getRegistration('/'))?.waiting;
            if (!waiting) return '';
            return new Promise<string>(resolve => {
                const channel = new MessageChannel();
                channel.port1.onmessage = event => { channel.port1.close(); resolve(event.data.build); };
                waiting.postMessage({ type: 'QGROUP_GET_VERSION' }, [channel.port2]);
            });
        })).toBe(h.state.version);
        await expect(page.getByRole('alert')).toHaveCount(0);
        expect(await cacheKeys(page)).toContain('qgroup-unified-shell-' + build);
        expect(await cacheKeys(page)).toContain('qgroup-unified-shell-' + h.state.version);
    } finally {
        await page.goto('about:blank');
        await h.close();
    }
});
test('a newly opened tab can activate an already waiting worker and clear its completed activation control', async ({ page, context }) => {
    const h = await host(), second = await context.newPage();
    try {
        await page.goto(h.origin + '/me/app');
        await ready(page);
        h.state.version = 'a'.repeat(64);
        await page.getByRole('button', { name: '檢查更新', exact: true }).click();
        await expect(page.getByRole('button', { name: '啟用已下載版本', exact: true })).toBeVisible();
        await second.goto(h.origin + '/me/app');
        await expect(second.getByRole('button', { name: '啟用已下載版本', exact: true })).toBeVisible();
        await second.getByRole('button', { name: '啟用已下載版本', exact: true }).click();
        await expect(second.getByRole('button', { name: '啟用已下載版本', exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: '保存草稿後重新載入', exact: true })).toBeVisible();
        await expect(second.getByRole('alert')).toHaveCount(0);
    } finally {
        await second.close();
        await page.goto('about:blank');
        await h.close();
    }
});
