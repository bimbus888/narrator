// Offline support: the app files are cached on install and served from the cache first,
// refreshed in the background when online. Audio itself lives in IndexedDB, not here.
const CACHE = 'narrator-v8';
const SHELL = ['./', 'index.html', 'app.js', 'lib.js', 'tts-worker.js', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png',
  'vendor/kokoro.web.js', 'vendor/ligature-words.txt', 'vendor/lamejs.js', 'vendor/pdf.min.mjs', 'vendor/pdf.worker.min.mjs'];

// cache: 'reload' so an update never stores the browser's stale (up to 10 minutes old) copy
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('narrator-') && k !== CACHE && k !== 'narrator-cdn').map(k => caches.delete(k)))).then(() => self.clients.claim())));

// Cross-origin isolation lets the voice engine use every CPU core (static hosts can't set these headers themselves)
const isolate = r => {
  if (!r || r.status === 0 || r.type === 'opaqueredirect') return r;
  const h = new Headers(r.headers);
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
};

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin === location.origin) {
    // stale-while-revalidate: instant (and offline) from cache, update in background
    e.respondWith(caches.open(CACHE).then(async c => {
      const hit = await c.match(e.request, { ignoreSearch: true });
      const net = fetch(e.request, { cache: 'no-cache' }).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; });
      if (hit) { e.waitUntil(net.catch(() => {})); return isolate(hit); }
      return isolate(await net);
    }));
  } else if (url.hostname === 'cdn.jsdelivr.net') {
    // voice-engine runtime files (versioned URLs): cache forever once fetched
    e.respondWith(caches.open('narrator-cdn').then(async c => (await c.match(e.request)) || fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; })));
  }
});
