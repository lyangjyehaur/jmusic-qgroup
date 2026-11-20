/// <reference lib="webworker" />
/** Compiled independently of React. Never cache a document or a server response. */
export {};
import { displayLanguage } from '@qgroup/contracts/language';
import { offlinePage } from './offline';
declare const __PWA_BUILD_ID__: string;
declare const __PWA_ASSETS__: string[];
const scope = globalThis as unknown as ServiceWorkerGlobalScope;
const build = __PWA_BUILD_ID__, assets = new Set(__PWA_ASSETS__), cacheName = 'qgroup-unified-shell-' + build;
const currentClients = new Map<string, string>();
const ownedCache = (name: string) => /^qgroup-unified-shell-[a-f0-9]{64}$/.test(name);
const hashedAsset = (path: string) => /^\/assets\/[\w.-]+-[\w-]{8,}\.(?:js|css|woff2?|png|svg|webp|avif)$/.test(path);
const retirementRecord = new URL('/.qgroup-worker-retirements', scope.location.origin).href;
async function cleanup() {
    const clients = await scope.clients.matchAll({ type: 'window' }), ids = new Set(clients.map(client => client.id));
    for (const id of currentClients.keys())
        if (!ids.has(id))
            currentClients.delete(id);
    // Keep old assets until every controlled page has identified its current build.
    // An unknown / background / older page is evidence to keep its cached files.
    if (!clients.length || clients.some(client => currentClients.get(client.id) !== build))
        return;
    // Snapshot at activation, not on cleanup: a still active older worker must
    // never delete a newer worker's installing/waiting cache. Persist across naps.
    const record = await (await caches.open(cacheName)).match(retirementRecord);
    const retired: unknown = record ? await record.json() : [];
    if (Array.isArray(retired))
        for (const key of retired)
            if (typeof key === 'string' && ownedCache(key) && key !== cacheName)
                await caches.delete(key);
}
scope.addEventListener('install', event => event.waitUntil((async () => {
    try {
        const cache = await caches.open(cacheName);
        // Keep the complete inventory, but bound each atomic cache operation's
        // queued downloads and retained response bodies. Installation finishes
        // only after every batch; a failed batch removes the entire new cache.
        const paths = [...assets];
        for (let start = 0; start < paths.length; start += 4)
            await cache.addAll(paths.slice(start, start + 4).map(path => new Request(new URL(path, scope.location.origin), { cache: 'reload', credentials: 'omit' })));
    }
    catch (error) {
        await caches.delete(cacheName);
        throw error;
    }
    // Updates wait for explicit activation, or for all existing pages to close.
})()));
scope.addEventListener('activate', event => event.waitUntil((async () => {
    const retired = (await caches.keys()).filter(key => ownedCache(key) && key !== cacheName);
    await (await caches.open(cacheName)).put(retirementRecord, new Response(JSON.stringify(retired), { headers: { 'Content-Type': 'application/json' } }));
    await scope.clients.claim();
})()));
scope.addEventListener('message', event => {
    const source = event.source as Client | null;
    if (!source || source.type !== 'window' || new URL(source.url).origin !== scope.location.origin)
        return;
    if (event.data?.type === 'QGROUP_GET_VERSION')
        event.ports[0]?.postMessage({ build });
    if (event.data?.type === 'QGROUP_ACTIVATE' && event.data.build === build)
        event.waitUntil(scope.skipWaiting());
    if (event.data?.type === 'QGROUP_CLIENT_READY' && /^[a-f0-9]{64}$/.test(event.data.build ?? '')) {
        currentClients.set(source.id, event.data.build);
        source.postMessage({ type: 'QGROUP_WORKER_VERSION', build });
        event.waitUntil(cleanup());
    }
});
scope.addEventListener('fetch', event => {
    const request = event.request, url = new URL(request.url);
    if (request.method !== 'GET' || url.origin !== scope.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/') || /^\/music\/api(?:\/|$)/.test(url.pathname))
        return;
    if (request.mode === 'navigate') {
        event.respondWith(fetch(request).catch(() => {
            const language = displayLanguage(request.headers.get('accept-language') ?? scope.navigator.languages.join(','));
            return new Response(offlinePage(language), { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Language': language, 'Vary': 'Accept-Language', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" } });
        }));
        return;
    }
    if ((!assets.has(url.pathname) && !hashedAsset(url.pathname)) || url.search || request.cache === 'no-store')
        return;
    event.respondWith((async () => {
        const cache = await caches.open(cacheName), cached = await cache.match(url.pathname);
        if (cached && request.cache !== 'reload' && request.cache !== 'no-cache')
            return cached;
        // An already open older page may load a split chunk after activation. Read
        // only immutable asset paths from precisely owned caches while it is alive.
        if (!assets.has(url.pathname) && request.cache !== 'reload' && request.cache !== 'no-cache') {
            for (const key of await caches.keys())
                if (key !== cacheName && ownedCache(key)) {
                    const previous = await (await caches.open(key)).match(url.pathname);
                    if (previous)
                        return previous;
                }
        }
        const response = await fetch(request);
        if (assets.has(url.pathname) && response.ok && response.type === 'basic' && !response.headers.get('cache-control')?.includes('no-store'))
            await cache.put(url.pathname, response.clone());
        return response;
    })());
});
