// Minimal service worker: makes ScanPay installable (PWA) without caching anything.
// Payments must always hit the network, so there is deliberately no offline cache.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {
  // network pass-through (the handler's presence is what makes the app installable)
});
