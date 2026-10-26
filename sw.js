// Offline support: the app files are cached on install and served from the cache first,
// refreshed in the background when online. Audio lives in IndexedDB and is served below.
const CACHE = 'narrator-v9';
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

// A book's audio is served at audio/<bookId>.mp3 straight from IndexedDB, with HTTP range support.
// iPhone Safari can't seek inside a large blob: URL (it treats it as an endless live stream),
// but it plays and seeks normal files fetched in byte ranges.
const audioBlobs = new Map();   // url -> Blob of the whole book (cheap: references the stored parts)
const bookAudio = id => new Promise((res, rej) => {
  const open = indexedDB.open('audiobooks');
  open.onerror = () => rej(open.error);
  open.onsuccess = () => {
    const get = open.result.transaction('audio').objectStore('audio').getAll(IDBKeyRange.bound([id, 0], [id, Infinity]));
    get.onsuccess = () => res(new Blob(get.result, { type: 'audio/mpeg' }));
    get.onerror = () => rej(get.error);
  };
});
async function serveAudio(req, url) {
  if (!audioBlobs.has(url.href)) audioBlobs.set(url.href, await bookAudio(decodeURIComponent(url.pathname.split('/audio/').pop().replace(/\.mp3$/, ''))));
  const blob = audioBlobs.get(url.href), size = blob.size;
  const headers = { 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes' };
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
  if (!m) return new Response(blob, { headers: { ...headers, 'Content-Length': String(size) } });
  const start = m[1] ? +m[1] : Math.max(0, size - +m[2]), end = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
  if (start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  return new Response(blob.slice(start, end + 1), { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) } });
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin === location.origin && url.pathname.includes('/audio/')) return e.respondWith(serveAudio(e.request, url));
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
