import * as pdfjs from './vendor/pdf.min.mjs';
import { itemsToLines, refixLigatures, looksScanned, pagesToSections, chapterTimes, makeChunks, mp3Seconds, id3Tag, readId3Meta, fmtTime, titleFromFilename } from './lib.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;

const VERSION = 9;   // shown on the Downloads page, so it's easy to see whether a phone has the latest version
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const audio = $('#audio');
const VOICES = { bm_lewis: 'Lewis (British male, deeper, default)', bm_george: 'George (British male)', bm_fable: 'Fable (British male)', bm_daniel: 'Daniel (British male)', bf_emma: 'Emma (British female)', bf_isabella: 'Isabella (British female)' };
const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5];
const ls = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} }, del: k => { try { localStorage.removeItem(k); } catch {} } };

// ---------- storage (IndexedDB: persistent, survives restarts; PDFs and audio kept in separate stores)
const dbp = new Promise((res, rej) => {
  const r = indexedDB.open('audiobooks', 1);
  r.onupgradeneeded = () => {
    const d = r.result;
    d.createObjectStore('books', { keyPath: 'id' });
    d.createObjectStore('chunks', { keyPath: ['bookId', 'idx'] });
    d.createObjectStore('audio');   // key [bookId, idx] -> MP3 Blob
    d.createObjectStore('pdfs');    // key bookId -> original PDF Blob
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function tx(stores, mode, fn) {
  const t = (await dbp).transaction(stores, mode);
  const done = new Promise((res, rej) => { t.oncomplete = res; t.onerror = t.onabort = () => rej(t.error); });
  const out = await fn(...[stores].flat().map(s => t.objectStore(s)));
  await done;
  return out;
}
const range = id => IDBKeyRange.bound([id, 0], [id, Infinity]);
const getBook = id => tx('books', 'readonly', s => req(s.get(id)));
const putBook = b => tx('books', 'readwrite', s => req(s.put(b)));
const allBooks = () => tx('books', 'readonly', s => req(s.getAll())).then(b => b.sort((x, y) => (y.lastPlayed || y.created) - (x.lastPlayed || x.created)));
const getChunks = id => tx('chunks', 'readonly', s => req(s.getAll(range(id))));
const getAudio = id => tx('audio', 'readonly', s => req(s.getAll(range(id))));

// real words, used to repair the fi/ff/fl letter pairs some PDFs scramble (see lib.js)
const ligWords = fetch(new URL('./vendor/ligature-words.txt', import.meta.url)).then(r => r.text()).then(t => new Set(t.split('\n'))).catch(() => null);

const persist = () => navigator.storage?.persist?.().catch(() => {});

// ---------- UI state
let view = 'library', books = [], gen = null, current = null, sleep = null, busy = false;
const status = (msg, cls = '') => { const el = $('#status'); el.className = cls; el.textContent = msg || ''; };

async function render() {
  books = await allBooks();
  document.querySelectorAll('nav button').forEach(b => b.setAttribute('aria-current', b.dataset.view === view));
  $('#view').innerHTML = view === 'library' ? libraryHTML() : view === 'player' ? playerHTML() : await downloadsHTML();
  if (view === 'player') updatePlayer();
}

const coverHTML = b => b.cover ? `<img class="cover" src="${b.cover}" alt="">` : `<div class="cover">${esc(b.title[0])}</div>`;
const ready = b => b.total && b.done === b.total;
const pct = (a, b) => Math.round((100 * a) / (b || 1));
const position = b => Number(ls.get('pos:' + b.id)) || 0;

function bookState(b) {
  if (gen?.bookId === b.id) {
    const left = gen.eta ? ` · about ${fmtTime(gen.eta)} left` : '';
    return `<div class="bar"><i style="width:${gen.pct ?? 0}%"></i></div>
      <div class="muted">${esc(gen.msg || `Generating ${pct(b.done, b.total)}%`)}${left}</div>
      ${queuedCount() ? `<div class="muted">Then ${queuedCount()} more book${queuedCount() > 1 ? 's' : ''} in the queue.</div>` : ''}
      <div class="row"><button data-act="stop" data-id="${b.id}">${gen.stop ? 'Pausing…' : 'Pause'}</button></div>`;
  }
  if (ready(b)) {
    const p = position(b);
    const fix = !b.redo ? '' : b.queued && gen ? `<div class="muted">Pronunciation fix queued.</div>
      <div class="row"><button data-act="unqueue" data-id="${b.id}">Remove from queue</button></div>`
      : `<div class="muted">${b.redo} part${b.redo > 1 ? 's' : ''} had misread words (like “off” read as “ofi”). Re-voicing them takes about ${fmtTime(b.redo * 105)}; the book stays playable meanwhile.</div>
      <div class="row"><button class="primary" data-act="${gen ? 'queue' : 'gen'}" data-id="${b.id}">${gen ? 'Add fix to queue' : 'Fix pronunciation'}</button></div>`;
    return `<div class="muted">${fmtTime(b.seconds)} · ${p ? pct(p, b.seconds) + '% listened' : 'Not started'}</div>
      <div class="ok muted">✓ Downloaded · plays offline</div>${fix}`;
  }
  if (b.queued && gen) return `<div class="muted">Queued: starts automatically when the book before it finishes.</div>
    <div class="row"><button data-act="unqueue" data-id="${b.id}">Remove from queue</button></div>`;
  const failed = b.failed ? `<div class="bad muted">${b.failed} part${b.failed > 1 ? 's' : ''} failed.</div>` : '';
  const voice = b.done ? '' : `<select data-act="voice" data-id="${b.id}" aria-label="Voice">${Object.entries(VOICES).map(([k, v]) => `<option value="${k}" ${k === b.voice ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <button data-act="preview" data-id="${b.id}" ${gen ? 'disabled' : ''}>▶ Preview voice</button>`;
  return `${b.done ? `<div class="bar"><i style="width:${pct(b.done, b.total)}%"></i></div>` : ''}
    <div class="muted">${b.done ? `Audio ${pct(b.done, b.total)}% generated (paused)` : `${b.pages} pages · ${b.chapters.length} chapter${b.chapters.length > 1 ? 's' : ''} · audio not generated yet`}</div>${failed}
    <div class="row">${voice}${gen
      ? `<button class="primary" data-act="queue" data-id="${b.id}">Add to queue</button>`
      : `<button class="primary" data-act="gen" data-id="${b.id}">${b.failed ? 'Retry failed parts' : b.done ? 'Resume generating' : 'Generate audio'}</button>`}</div>`;
}

function libraryHTML() {
  const last = books.find(b => b.id === ls.get('last') && ready(b));
  return `<h1>Library</h1>
    ${last ? `<button class="primary resume" data-act="resume">▶&nbsp; Resume “${esc(last.title)}” · ${fmtTime(position(last))}</button>` : ''}
    <label class="btn file ${last ? '' : 'primary'}" style="width:100%;justify-content:center;margin-bottom:6px">＋ Add a PDF<input type="file" accept="application/pdf,.pdf" data-act="upload"></label>
    <h2>Your books</h2>
    ${books.length ? books.map(b => `<div class="card">
      <div class="${ready(b) ? 'clickable' : ''}" data-act="${ready(b) ? 'open' : ''}" data-id="${b.id}">${coverHTML(b)}</div>
      <div class="body"><div class="title ${ready(b) ? 'clickable' : ''}" data-act="${ready(b) ? 'open' : ''}" data-id="${b.id}">${esc(b.title)}</div>${bookState(b)}</div></div>`).join('')
      : '<p class="muted">No books yet. Add a PDF to begin. Everything stays on this device.</p>'}`;
}

function playerHTML() {
  if (!current) return `<h1>Player</h1><p class="muted">Pick a downloaded book in the Library.</p>`;
  const b = current.book;
  return `<div class="player">
    ${coverHTML(b)}
    <div><div class="ptitle">${esc(b.title)}</div></div>
    <select id="chapter" aria-label="Chapter">${current.chapters.map((c, i) => `<option value="${i}">${esc(c.title)}</option>`).join('')}</select>
    <input id="seek" type="range" min="0" max="${Math.floor(b.seconds)}" step="1" value="0" aria-label="Position">
    <div class="times"><span id="t-pos">0:00</span><span id="t-left"></span></div>
    <div class="controls">
      <button class="skip" data-act="back" aria-label="Back 15 seconds"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4"/><text x="12" y="15.5" font-size="7" text-anchor="middle" fill="currentColor" stroke="none">15</text></svg></button>
      <button class="play" data-act="toggle" aria-label="Play"><svg id="play-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>
      <button class="skip" data-act="fwd" aria-label="Forward 15 seconds"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4"/><text x="12" y="15.5" font-size="7" text-anchor="middle" fill="currentColor" stroke="none">15</text></svg></button>
    </div>
    <div class="speeds">${SPEEDS.map(s => `<button data-act="speed" data-speed="${s}" aria-pressed="${s === audio.playbackRate}">${s}×</button>`).join('')}</div>
    <div class="row" style="justify-content:center"><label class="muted" for="sleep">Sleep timer</label>
      <select id="sleep"><option value="">Off</option><option value="15">15 min</option><option value="30">30 min</option><option value="45">45 min</option><option value="60">60 min</option><option value="chapter">End of chapter</option></select>
      <span id="sleep-left" class="muted"></span></div>
  </div>`;
}

async function downloadsHTML() {
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  const pdfSizes = await tx('pdfs', 'readonly', s => Promise.all(books.map(b => req(s.get(b.id)).then(p => p?.size || 0))));
  const mb = n => n < 1048576 ? Math.ceil(n / 1024) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(n > 1048576 * 10 ? 0 : 1) + ' MB' : (n / 1073741824).toFixed(1) + ' GB';
  return `<h1>Downloads</h1>
    <p class="muted">${est ? `Using ${mb(est.usage)} of about ${mb(est.quota)} available to this app.` : ''}
      ${persisted ? '<span class="ok">Storage is persistent.</span>' : '<button data-act="persist">Keep my downloads safe</button>'}</p>
    <label class="btn file" style="width:100%;justify-content:center">⇪ Import an audiobook (.mp3) from another device<input type="file" accept="audio/mpeg,.mp3" data-act="import"></label>
    <h2>Books on this device</h2>
    ${books.map((b, i) => `<div class="card">${coverHTML(b)}<div class="body">
      <div class="title">${esc(b.title)}</div>
      <div class="muted">${ready(b) ? `<span class="ok">✓ Available offline</span> · ${fmtTime(b.seconds)}` : b.done ? `Partly generated (${pct(b.done, b.total)}%)` : 'No audio on this device'}
        · audio ${mb(b.bytes || 0)}${pdfSizes[i] ? ` · original PDF ${mb(pdfSizes[i])} (kept separately)` : ''}</div>
      <div class="row">
        ${ready(b) ? `<button data-act="export" data-id="${b.id}">Send to phone / export MP3</button>` : ''}
        ${b.done && !b.imported ? `<button data-act="delaudio" data-id="${b.id}">Delete audio</button>` : ''}
        <button class="danger" data-act="delbook" data-id="${b.id}">Delete book</button>
      </div></div></div>`).join('') || '<p class="muted">Nothing downloaded yet.</p>'}
    <details class="muted" style="margin-top:24px"><summary>Narrator version ${VERSION} · playback log</summary>
      <pre style="white-space:pre-wrap;font-size:12px">${esc(playLog.join('\n') || 'Nothing played yet.')}</pre></details>`;
}

// ---------- adding a PDF
// -> { pdf, pages: [[{text,size}]], outline: [{title, page}] (the PDF's bookmarks, if any) }
async function readPdf(blob) {
  const words = await ligWords;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const tc = await (await pdf.getPage(i)).getTextContent();
    pages.push(itemsToLines(tc.items.filter(it => 'str' in it).map(it => ({
      str: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: Math.hypot(it.transform[2], it.transform[3]) || it.height,
    })), words));
    if (i % 10 === 0) status(`Reading page ${i} of ${pdf.numPages}…`);
  }
  let items = (await pdf.getOutline().catch(() => null)) || [];
  if (items.length === 1 && items[0].items?.length) items = items[0].items;   // a single top-level book entry
  const outline = [];
  for (const o of items) {
    try {
      const dest = typeof o.dest === 'string' ? await pdf.getDestination(o.dest) : o.dest;
      outline.push({ title: o.title.trim(), page: (await pdf.getPageIndex(dest[0])) + 1 });
    } catch {}
  }
  return { pdf, pages, outline };
}

const chunkRecords = (bookId, chunks) => chunks.map((c, idx) => ({ bookId, idx, ...c, chars: c.parts.join(' ').length, status: 'pending' }));

// Bring books made by earlier versions up to date (chapters from bookmarks, fi/ff/fl repairs),
// regenerating as little audio as possible. retime: recompute chapter times after parts were re-voiced.
async function upgradeBook(book, { retime = false } = {}) {
  const needsLig = !book.ligV, needsChapters = !(book.chaptersV >= 2) || retime;
  if (book.imported || (!needsLig && !needsChapters)) return;
  const file = await tx('pdfs', 'readonly', s => req(s.get(book.id))), words = await ligWords;
  if (!file || !words) return;
  status(`Updating “${book.title}”…`);
  const { pages, outline } = await readPdf(file);
  const sections = pagesToSections(pages, book.title, outline);
  if (!book.done) {   // nothing generated yet: just rebuild it
    const { chunks, chapters } = makeChunks(sections);
    Object.assign(book, { chapters, total: chunks.length, failed: 0, chaptersV: 2, ligV: 1 });
    await tx(['books', 'chunks'], 'readwrite', (bs, cs) => { cs.delete(range(book.id)); chunkRecords(book.id, chunks).forEach(c => cs.put(c)); bs.put(book); });
    return status('');
  }
  let chunks = await getChunks(book.id);
  const changed = [];
  if (needsLig) {   // re-voice only parts with misread words; their old audio keeps playing until then
    chunks = chunks.map(c => {
      const parts = c.parts.map(p => refixLigatures(p, words));
      if (parts.join('\n') === c.parts.join('\n')) return c;
      const fixed = { ...c, parts, chars: parts.join(' ').length, redo: c.status === 'done' || c.redo };
      changed.push(fixed);
      return fixed;
    });
    book.redo = chunks.filter(c => c.redo).length;
    book.ligV = 1;
  }
  if (needsChapters && ready(book) && outline.length >= 2) {
    const times = chapterTimes(sections, chunks);
    if (times.length >= 2) book.chapters = times;
    book.chaptersV = 2;
  }
  await tx(['books', 'chunks'], 'readwrite', (bs, cs) => { changed.forEach(c => cs.put(c)); bs.put(book); });
  status('');
}

async function addPdf(file) {
  persist();
  status('Opening PDF…');
  const { pdf, pages, outline } = await readPdf(file);
  if (looksScanned(pages)) {
    throw new Error(`This PDF looks like scanned page images, so there is no text to read aloud.\nIt needs OCR (text recognition) first. Free options: on a Mac, open it in Preview and use File › Export (or the free "OCRmyPDF" tool), then add the new PDF here.`);
  }
  const title = titleFromFilename(file.name);
  const { chunks, chapters } = makeChunks(pagesToSections(pages, title, outline));
  let cover = '';
  try {
    const page = await pdf.getPage(1), vp = page.getViewport({ scale: 1 });
    const v = page.getViewport({ scale: 240 / vp.width }), c = document.createElement('canvas');
    c.width = v.width; c.height = v.height;
    // rendering pauses while the page is hidden, so never let the cover block the import
    await Promise.race([page.render({ canvasContext: c.getContext('2d'), canvas: c, viewport: v }).promise, new Promise((_, rej) => setTimeout(() => rej(new Error('cover timeout')), 4000))]);
    cover = c.toDataURL('image/jpeg', 0.7);
  } catch (e) { console.warn('cover', e); }
  const id = crypto.randomUUID();
  const book = { id, title, created: Date.now(), pages: pdf.numPages, voice: 'bm_lewis', cover, chapters, chaptersV: 2, ligV: 1, total: chunks.length, done: 0, failed: 0, bytes: 0, seconds: 0 };
  await tx(['books', 'chunks', 'pdfs'], 'readwrite', (bs, cs, ps) => {
    bs.put(book);
    chunkRecords(id, chunks).forEach(c => cs.put(c));
    ps.put(file, id);
  });
  const words = chunks.reduce((n, c) => n + c.parts.join(' ').split(/\s+/).length, 0);
  status(`Added “${title}”: ${chapters.length} chapter(s), about ${fmtTime(words / 150 * 60)} of listening. Tap “Generate audio”.`, 'ok');
}

// ---------- voice generation (one book at a time, in a background worker)
let worker;
const waiting = new Map();
let nextId = 1;
function ask(msg) {
  if (!worker) {
    worker = new Worker(new URL('./tts-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data: m }) => {
      if (m.type === 'load' && gen) { gen.msg = `Loading the voice (downloaded once, then kept on this device)… ${Math.round(m.progress)}%`; throttledRender(); }
      if (m.type === 'device') console.info('Voice engine running on', m.device);
      if (m.type === 'progress' && gen?.t0) { gen.charsDone += m.chars; showProgress(); }
      if (m.type === 'ready' || m.type === 'done' || m.type === 'error') { waiting.get(m.id)?.(m); waiting.delete(m.id); }
    };
    worker.onerror = e => { // worker crashed (e.g. out of memory): fail everything pending, start fresh next time
      for (const r of waiting.values()) r({ type: 'error', message: e.message || 'Voice engine crashed' });
      waiting.clear(); worker.terminate(); worker = null;
    };
  }
  const id = nextId++;
  return new Promise(res => { waiting.set(id, res); worker.postMessage({ ...msg, id }); });
}
const loadModel = () => ask({ type: 'load' }).then(m => { if (m.type === 'error') throw new Error(m.message); });

// percentage, audio ready so far and time left, updated after every sentence
function showProgress() {
  const { book, t0, charsDone, charsAll, charsBefore } = gen;
  gen.pct = (100 * (charsBefore + charsDone)) / charsAll;
  const elapsed = performance.now() - t0;   // first sentences include GPU warm-up, so wait before estimating
  gen.eta = charsDone && elapsed > 60000 ? (elapsed / charsDone) * (charsAll - charsBefore - charsDone) / 1000 : 0;
  gen.msg = ready(book) ? `Fixing pronunciation: ${book.redo} part${book.redo === 1 ? '' : 's'} to go`
    : `Generating ${gen.pct.toFixed(1)}%${book.seconds ? ` · ${fmtTime(book.seconds)} of audio ready` : ''}`;
  throttledRender();
}

let renderTimer;
const throttledRender = () => { if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = null; if (view === 'library') render(); }, 500); };

let wakeLock;
const keepAwake = async on => { try { if (on) wakeLock = await navigator.wakeLock?.request('screen'); else { await wakeLock?.release(); wakeLock = null; } } catch {} };
document.addEventListener('visibilitychange', () => { if (gen && document.visibilityState === 'visible') keepAwake(true); });

// Queue: books get a `queued` timestamp; when one finishes, the oldest queued book starts automatically
const queuedCount = () => books.filter(b => b.queued).length;
async function setQueued(id, on) { const b = await getBook(id); b.queued = on ? Date.now() : 0; await putBook(b); }

async function generate(bookId) {
  if (gen) return;
  let finished = false, redid = false;
  persist();
  gen = { bookId, stop: false, msg: 'Starting the voice engine…' };
  keepAwake(true);
  render();
  try {
    await loadModel();
    const book = await getBook(bookId);
    if (book.queued) { book.queued = 0; await putBook(book); }
    const todo = (await getChunks(bookId)).filter(c => c.status !== 'done' || c.redo);
    book.failed = 0;
    const all = await getChunks(bookId);
    Object.assign(gen, {
      book, t0: performance.now(), charsDone: 0,
      charsAll: all.reduce((n, c) => n + c.chars, 0),
      charsBefore: all.reduce((n, c) => n + (c.status === 'done' && !c.redo ? c.chars : 0), 0),
    });
    showProgress();
    for (const c of todo) {
      if (gen.stop) break;
      const r = await ask({ type: 'chunk', parts: c.parts, heading: c.heading, voice: book.voice });
      if (r.blob) {
        const wasRedo = c.redo, old = wasRedo ? { bytes: c.bytes, seconds: c.seconds } : { bytes: 0, seconds: 0 };
        Object.assign(c, { status: 'done', redo: false, bytes: r.blob.size, seconds: mp3Seconds(r.blob.size), error: null });
        if (wasRedo) { book.redo--; redid = true; } else book.done++;
        book.bytes += c.bytes - old.bytes; book.seconds += c.seconds - old.seconds;
        await tx(['chunks', 'audio', 'books'], 'readwrite', (cs, as, bs) => { cs.put(c); as.put(r.blob, [bookId, c.idx]); bs.put(book); });
      } else {
        Object.assign(c, { status: 'failed', error: r.message });
        book.failed++;
        await tx(['chunks', 'books'], 'readwrite', (cs, bs) => { cs.put(c); bs.put(book); });
        console.warn('chunk failed', c.idx, r.message);
      }
    }
    finished = !gen.stop;
    status(book.done === book.total && book.failed ? `${book.failed} part(s) failed. Tap the button to retry.` : book.done === book.total ? `“${book.title}” is ready and saved on this device. ✓` : book.failed ? `${book.failed} part(s) failed. Tap “Retry failed parts”.` : 'Generation paused. You can resume any time.', book.failed ? 'bad' : 'ok');
  } catch (e) {
    status(`Could not generate audio: ${e.message}\n(The voice model needs an internet connection the first time.)`, 'bad');
  } finally {
    gen = null;
    if (finished) await getBook(bookId).then(b => upgradeBook(b, { retime: redid && b.chapters.some(c => c.start != null) })).catch(console.warn);
    const next = finished && (await allBooks()).filter(b => b.queued).sort((x, y) => x.queued - y.queued)[0];
    if (next) generate(next.id);   // keeps the screen awake and carries on with the queue
    else { keepAwake(false); render(); }
  }
}

async function previewVoice(bookId) {
  const book = await getBook(bookId);
  if (gen) return;
  status('Preparing a short voice sample… (the first time downloads the voice: about 330 MB on a computer, 90 MB on a phone)');
  try {
    await loadModel();
    const r = await ask({ type: 'chunk', parts: ['Here, in the quiet of the early morning, the story begins.'], voice: book.voice });
    if (!r.blob) throw new Error(r.message);
    const a = new Audio(URL.createObjectURL(r.blob));
    a.play();
    status('');
  } catch (e) { status('Voice preview failed: ' + e.message, 'bad'); }
}

// ---------- player
const speed = () => Number(ls.get('speed')) || 1;
// Saved position to restore. iPhone Safari only loads audio once play is pressed and may ignore
// an early jump, so keep re-applying it on every media event until it has really landed.
let pendingSeek = null, seekTries = 0, resumed = null;   // resumed: {at, until} to catch a player that slips back
function applyPendingSeek(ev) {
  if (pendingSeek === null && resumed && ev === 'timeupdate' && performance.now() < resumed.until && audio.currentTime < resumed.at - 20) {
    plog(`position slipped back to ${fmtTime(audio.currentTime)}, re-applying ${fmtTime(resumed.at)}`);
    pendingSeek = resumed.at; resumed = null;
  }
  if (pendingSeek === null || audio.readyState < 1) return;
  if (audio.duration) pendingSeek = Math.min(pendingSeek, audio.duration - 1);
  if (Math.abs(audio.currentTime - pendingSeek) < 1.5) {
    plog(`${ev}: resumed at ${fmtTime(audio.currentTime)}`);
    if (pendingSeek > 30) resumed = { at: pendingSeek, until: performance.now() + 20000 };
    pendingSeek = null;
    return;
  }
  if (++seekTries > 80) { plog(`${ev}: gave up jumping to ${fmtTime(pendingSeek)}, playing from ${fmtTime(audio.currentTime)}`); pendingSeek = null; return; }
  const end = audio.seekable.length ? fmtTime(audio.seekable.end(audio.seekable.length - 1)) : 'none';
  plog(`${ev}: at ${fmtTime(audio.currentTime)}, jumping to ${fmtTime(pendingSeek)} (state ${audio.readyState}, seekable to ${end})`);
  audio.currentTime = pendingSeek;
}
for (const ev of ['loadedmetadata', 'loadeddata', 'canplay', 'playing', 'timeupdate', 'seeked']) audio.addEventListener(ev, () => applyPendingSeek(ev));

// short log of what the player did, shown on the Downloads page for troubleshooting
const playLog = [];
function plog(msg) { playLog.push(new Date().toTimeString().slice(0, 8) + ' ' + msg); if (playLog.length > 40) playLog.shift(); }
for (const ev of ['play', 'pause', 'error', 'stalled']) audio.addEventListener(ev, () => plog(`${ev} at ${fmtTime(audio.currentTime)}${audio.error ? ' error ' + audio.error.code : ''}`));

async function loadBook(id) {
  if (current?.book.id === id) return;
  const book = await getBook(id);
  const [chunks, blobs] = await Promise.all([getChunks(id), getAudio(id)]);
  let t = 0;
  const starts = chunks.map(c => { const s = t; t += c.seconds || 0; return s; });
  const chapters = book.chapters.map(ch => ({ title: ch.title, start: ch.start ?? starts[ch.chunk] ?? 0 }));
  if (current) URL.revokeObjectURL(current.url);
  // Normally the service worker serves the audio as a real file (iPhone can only seek in those);
  // a blob: URL is the fallback for the rare page load the service worker doesn't control
  const viaSW = !!navigator.serviceWorker?.controller;
  current = { book, chapters, url: viaSW ? `audio/${encodeURIComponent(id)}.mp3?v=${book.bytes}-${blobs.length}` : URL.createObjectURL(new Blob(blobs, { type: 'audio/mpeg' })) };
  pendingSeek = position(book);
  seekTries = 0;
  plog(`v${VERSION} opened “${book.title}”, saved position ${fmtTime(pendingSeek)}, ${viaSW ? 'file' : 'blob'} source`);
  // "#t=" makes the player itself start at the saved time; applyPendingSeek is the fallback
  audio.src = current.url + (pendingSeek > 1 ? `#t=${pendingSeek.toFixed(1)}` : '');
  audio.defaultPlaybackRate = audio.playbackRate = speed();
  ls.set('last', id);
  book.lastPlayed = Date.now();
  putBook(book);
  setMediaSession();
}

const chapterAt = t => { let i = 0; current.chapters.forEach((c, j) => { if (t >= c.start) i = j; }); return i; };

function savePos() {
  if (!current || pendingSeek !== null) return;
  ls.set('pos:' + current.book.id, audio.currentTime.toFixed(1));
}

function seek(t) {
  if (!current) return;
  t = Math.max(0, Math.min(current.book.seconds - 0.5, t));
  if (pendingSeek !== null) pendingSeek = t;
  resumed = null;   // the user chose this spot, so going backwards is intended
  audio.currentTime = t;
  savePos();
  updatePlayer();
}

function togglePlay() {
  if (!current) return;
  if (audio.paused) {
    if (audio.ended || audio.currentTime >= current.book.seconds - 1) seek(0);
    audio.play().catch(e => status('Playback failed: ' + e.message, 'bad'));
  } else audio.pause();
}

function setMediaSession() {
  if (!('mediaSession' in navigator) || !current) return;
  const b = current.book, ch = current.chapters[chapterAt(audio.currentTime)];
  navigator.mediaSession.metadata = new MediaMetadata({
    title: ch?.title || b.title, artist: b.title, album: 'Narrator',
    artwork: b.cover ? [{ src: b.cover, sizes: '240x340', type: 'image/jpeg' }] : [{ src: new URL('icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' }],
  });
}
function setPositionState() {
  if (!current || !navigator.mediaSession?.setPositionState || !audio.duration) return;
  try { navigator.mediaSession.setPositionState({ duration: audio.duration, position: Math.min(audio.currentTime, audio.duration), playbackRate: audio.playbackRate }); } catch {}
}
if ('mediaSession' in navigator) {
  const h = { play: () => audio.play(), pause: () => audio.pause(), seekbackward: () => seek(audio.currentTime - 15), seekforward: () => seek(audio.currentTime + 15), seekto: d => seek(d.seekTime) };
  for (const [k, f] of Object.entries(h)) try { navigator.mediaSession.setActionHandler(k, f); } catch {}
}

let lastChapter = -1, lastTick = 0, lastSave = 0;
function updatePlayer() {
  if (!current || view !== 'player' || !$('#seek')) return;
  const t = pendingSeek ?? audio.currentTime, total = current.book.seconds, ci = chapterAt(t);
  if (document.activeElement !== $('#seek')) $('#seek').value = t;
  $('#t-pos').textContent = fmtTime(t);
  $('#t-left').textContent = `-${fmtTime((total - t) / audio.playbackRate)} left${audio.playbackRate !== 1 ? ` at ${audio.playbackRate}×` : ''}`;
  if (document.activeElement !== $('#chapter')) $('#chapter').value = ci;
  $('#play-icon').innerHTML = audio.paused ? '<path d="M8 5v14l11-7z"/>' : '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>';
  $('.play').setAttribute('aria-label', audio.paused ? 'Play' : 'Pause');
  $('#sleep').value = sleep ? sleep.kind : '';
  $('#sleep-left').textContent = sleep?.kind && sleep.kind !== 'chapter' ? fmtTime(sleep.left) + ' left' : '';
  document.querySelectorAll('[data-speed]').forEach(b => b.setAttribute('aria-pressed', Number(b.dataset.speed) === audio.playbackRate));
}

audio.addEventListener('loadedmetadata', setPositionState);
audio.addEventListener('play', () => { lastTick = performance.now(); updatePlayer(); });
audio.addEventListener('pause', () => { savePos(); updatePlayer(); });
audio.addEventListener('ratechange', setPositionState);
audio.addEventListener('ended', () => { ls.set('pos:' + current.book.id, String(current.book.seconds)); updatePlayer(); });
audio.addEventListener('timeupdate', () => {
  if (!current) return;
  if (pendingSeek !== null) return;   // still restoring the saved position
  const now = performance.now();
  if (sleep && !audio.paused) {
    sleep.left -= (now - lastTick) / 1000;
    const end = sleep.kind === 'chapter' ? audio.currentTime >= sleep.chapterEnd : sleep.left <= 0;
    if (end) { audio.pause(); sleep = null; }
  }
  lastTick = now;
  if (now - lastSave > 3000) { lastSave = now; savePos(); setPositionState(); }
  const ci = chapterAt(audio.currentTime);
  if (ci !== lastChapter) { lastChapter = ci; setMediaSession(); }
  updatePlayer();
});
addEventListener('pagehide', savePos);
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && savePos());

// ---------- export / import (move a book generated on a laptop to a phone)
async function exportBook(id) {
  const book = await getBook(id);
  const [chunks, blobs] = await Promise.all([getChunks(id), getAudio(id)]);
  let t = 0;
  const starts = chunks.map(c => { const s = t; t += c.seconds || 0; return s; });
  const meta = { title: book.title, duration: book.seconds, cover: book.cover, chapters: book.chapters.map(ch => ({ title: ch.title, start: ch.start ?? starts[ch.chunk] })) };
  const file = new File([id3Tag(meta), ...blobs], book.title.replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 80) + '.mp3', { type: 'audio/mpeg' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: book.title }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = file.name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 120000);
  status(`Saved “${file.name}” to your Downloads folder. Send it to your phone (e.g. AirDrop), then on the phone open Downloads › Import.`, 'ok');
}

async function importMp3(file) {
  persist();
  status(`Importing “${file.name}”…`);
  let meta = readId3Meta(new Uint8Array(await file.slice(0, 1 << 20).arrayBuffer()));
  if (!meta) {
    const a = new Audio(URL.createObjectURL(file));
    const duration = await new Promise((res, rej) => { a.onloadedmetadata = () => res(a.duration); a.onerror = () => rej(new Error('This file is not playable audio.')); });
    meta = { title: file.name.replace(/\.mp3$/i, ''), duration, chapters: [{ title: 'Start', start: 0 }] };
  }
  const id = crypto.randomUUID();
  const book = { id, title: meta.title, created: Date.now(), imported: true, cover: meta.cover || '', chapters: meta.chapters, total: 1, done: 1, failed: 0, bytes: file.size, seconds: meta.duration };
  await tx(['books', 'chunks', 'audio'], 'readwrite', (bs, cs, as) => {
    bs.put(book);
    cs.put({ bookId: id, idx: 0, status: 'done', seconds: meta.duration, bytes: file.size, parts: [], chars: 0 });
    as.put(new Blob([file], { type: 'audio/mpeg' }), [id, 0]);
  });
  status(`“${meta.title}” imported and available offline. ✓`, 'ok');
}

async function deleteAudio(id, wholeBook) {
  if (current?.book.id === id) { audio.pause(); audio.removeAttribute('src'); audio.load(); URL.revokeObjectURL(current.url); current = null; }
  await tx(['books', 'chunks', 'audio', 'pdfs'], 'readwrite', async (bs, cs, as, ps) => {
    as.delete(range(id));
    if (wholeBook) { bs.delete(id); cs.delete(range(id)); ps.delete(id); return; }
    const book = await req(bs.get(id));
    const chunks = await req(cs.getAll(range(id)));
    for (const c of chunks) cs.put({ ...c, status: 'pending', bytes: 0, seconds: 0 });
    bs.put({ ...book, done: 0, failed: 0, bytes: 0, seconds: 0 });
  });
  ls.del('pos:' + id);
}

// ---------- events
document.addEventListener('click', async e => {
  const nav = e.target.closest('nav button');
  if (nav) { view = nav.dataset.view; status(''); return render(); }
  const el = e.target.closest('[data-act]');
  if (!el || !el.dataset.act) return;
  const { act, id } = el.dataset;
  try {
    if (act === 'resume') { togglePlay(); view = 'player'; render(); }
    if (act === 'open') { await loadBook(id); view = 'player'; render(); }
    if (act === 'gen') generate(id);
    if (act === 'queue' || act === 'unqueue') { await setQueued(id, act === 'queue'); render(); }
    if (act === 'stop' && gen) { gen.stop = true; render(); }
    if (act === 'preview') previewVoice(id);
    if (act === 'toggle') togglePlay();
    if (act === 'back') seek(audio.currentTime - 15);
    if (act === 'fwd') seek(audio.currentTime + 15);
    if (act === 'speed') { audio.defaultPlaybackRate = audio.playbackRate = Number(el.dataset.speed); ls.set('speed', el.dataset.speed); updatePlayer(); }
    if (act === 'persist') { await navigator.storage?.persist?.(); render(); }
    if (act === 'export') { status('Preparing the MP3…'); await exportBook(id); }
    if (act === 'delaudio' && confirm('Delete the generated audio for this book? The PDF stays, so you can generate it again.')) { await deleteAudio(id, false); status('Audio deleted.'); render(); }
    if (act === 'delbook' && confirm('Delete this book, its PDF and its audio from this device?')) { await deleteAudio(id, true); status('Book deleted.'); render(); }
  } catch (err) { console.error(err); status(err.message, 'bad'); }
});

document.addEventListener('change', async e => {
  const el = e.target;
  try {
    if (el.dataset.act === 'upload' && el.files[0]) { busy = true; await addPdf(el.files[0]).finally(() => busy = false); render(); }
    if (el.dataset.act === 'import' && el.files[0]) { busy = true; await importMp3(el.files[0]).finally(() => busy = false); render(); }
    if (el.dataset.act === 'voice') { const b = await getBook(el.dataset.id); b.voice = el.value; await putBook(b); }
    if (el.id === 'chapter') seek(current.chapters[el.value].start + 0.01);
    if (el.id === 'sleep') {
      const ci = chapterAt(audio.currentTime);
      sleep = !el.value ? null : el.value === 'chapter'
        ? { kind: 'chapter', chapterEnd: current.chapters[ci + 1]?.start ?? current.book.seconds }
        : { kind: el.value, left: Number(el.value) * 60 };
      updatePlayer();
    }
  } catch (err) { console.error(err); status(err.message, 'bad'); }
  if (el.type === 'file') el.value = '';
});
document.addEventListener('input', e => { if (e.target.id === 'seek') seek(Number(e.target.value)); });

// ---------- start
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(e => console.warn('SW', e));
  // the service worker adds the cross-origin-isolation headers; reload once so they take effect
  const reloadOnce = () => {
    if (crossOriginIsolated || sessionStorage.getItem('coi') || busy || gen || !audio.paused) return; // never interrupt work
    sessionStorage.setItem('coi', '1');
    location.reload();
  };
  const hadController = !!navigator.serviceWorker.controller;
  if (hadController) reloadOnce();
  // a new version just took over: reload once to start using it, unless that would interrupt something
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !busy && !gen && audio.paused) location.reload(); else reloadOnce();
  });
}
(async () => {
  for (const b of await allBooks()) await upgradeBook(b).catch(e => { console.warn('upgrade', e); status(''); });
  const last = ls.get('last');
  if (last) {
    const b = await getBook(last);
    if (b && ready(b)) await loadBook(last).catch(console.warn);   // preload so “Resume” starts with one tap
  }
  render();
})();

window.__app = { addPdf, importMp3, generate, loadBook, exportBook, deleteAudio, getChunks, getBook, audio };  // used by end-to-end tests
