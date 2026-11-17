/// <reference lib="webworker" />
/** Replacement at the exact old script URL. Never force activation or reload old tabs. */
export {};
const scope = globalThis as unknown as ServiceWorkerGlobalScope;
scope.addEventListener('activate', event => event.waitUntil((async () => {
    if (new URL(scope.location.href).pathname !== '/music/sw.js' || new URL(scope.registration.scope).pathname !== '/music/')
        return;
    for (const key of await caches.keys())
        if (key.startsWith('qgroup-music-'))
            await caches.delete(key);
    await scope.registration.unregister();
    // There is deliberately no fetch handler, skipWaiting, clients.claim or navigation.
})()));
