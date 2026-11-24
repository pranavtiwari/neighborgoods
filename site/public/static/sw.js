// Minimal network-first Service Worker for Share, Instead. PWA installability.
// Does not cache HTML/JS aggressively so deployments always take effect immediately.
self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
    // Pass all requests straight through to the network
    event.respondWith(fetch(event.request));
});
