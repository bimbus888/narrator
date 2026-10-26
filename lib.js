// Pure helpers (no DOM): PDF text cleanup, chapter detection, chunking, MP3 tag.
// Unit-tested by tests/lib.test.mjs (run: node --test tests/)

export const SAMPLE_RATE = 24000;           // Kokoro output
export const BITRATE = 48;                  // kbps, constant bitrate mono MP3
export const mp3Seconds = bytes => (bytes * 8) / (BITRATE * 1000);
export const MAX_PART = 300;                // chars per TTS call (model limit is ~510 phoneme tokens)
export const CHUNK_CHARS = 1200;            // chars per stored/retryable audio chunk

// pdf.js text items {str,x,y,w,h} -> lines [{text,size}]; words: Set of real words (vendor/ligature-words.txt)
export function itemsToLines(items, words) {
  const lines = [];
  let cur = null;
  for (const it of items) {
    if (!it.str) continue;
    if (cur && Math.abs(it.y - cur.y) <= Math.max(2, cur.h * 0.5)) {
      const gap = it.x - cur.xEnd;
      const space = gap > cur.h * 0.15 && !cur.text.endsWith(' ') && !it.str.startsWith(' ');
      cur.text += (space ? ' ' : '') + it.str;
      cur.xEnd = it.x + it.w;
      cur.h = Math.max(cur.h, it.h);
    } else {
      cur = { text: it.str, y: it.y, h: it.h, xEnd: it.x + it.w };
      lines.push(cur);
    }
  }
  return lines.map(l => ({ text: fixLigatures(l.text, words).replace(/\s+/g, ' ').trim(), size: l.h })).filter(l => l.text);
}

// Some PDF fonts turn the fi, ff, ffi, fl and ffl ligatures into one unknown symbol (U+0000).
// Try each and keep the one that makes a real word: "o#ce" -> office, "#ow" -> flow, "sta#" -> staff.
const LIGATURES = ['fi', 'ff', 'ffi', 'fl', 'ffl'];

// the word list has base forms only, so also accept common endings: identified -> identify, offers -> offer
const ENDINGS = [['ies', 'y'], ['ied', 'y'], ['ier', 'y'], ['ily', 'y'], ['iness', 'y'], ['s', ''], ['es', ''], ['ed', ''], ['ed', 'e'], ['d', ''],
  ['ing', ''], ['ing', 'e'], ['ly', ''], ['ness', ''], ['ment', ''], ['ments', ''], ['able', ''], ['ably', ''], ['ally', 'al']];
const isDerived = (w, words) => ENDINGS.some(([end, add]) => w.endsWith(end) && words.has(w.slice(0, -end.length) + add));

// how well s reads as English around positions [a, b): a whole real word beats any word inside it
function wordCover(s, a, b, words) {
  const word = s.replace(/[^a-z]/g, '');
  if (word.length === s.length && words.has(word)) return 101;            // exact dictionary word
  if (word.length === s.length && isDerived(word, words)) return 100;     // a dictionary word plus an ending
  let best = 0;
  for (let st = 0; st <= a; st++) for (let en = s.length; en >= b && en - st > best; en--) if (words.has(s.slice(st, en))) best = en - st;
  return best;
}

function fixLigatures(t, words) {
  return t.replace(/[A-Za-z]*\u0000[A-Za-z\u0000]*/g, function fix(word) {
    const i = word.indexOf('\u0000');
    if (i < 0) return word;
    const lower = word.toLowerCase();
    let lig = null, score = 0;
    if (words) for (const l of LIGATURES) {
      const s = wordCover(lower.slice(0, i) + l + lower.slice(i + 1).replace(/\u0000/g, 'fi'), i, i + l.length, words);
      if (s > score) { lig = l; score = s; }
    }
    // unknown word (e.g. a name): "ff" at the end of a word (Smirnoff), otherwise "fi"
    lig ??= /[a-z]/i.test(word[i - 1] || '') && !/[a-z]/i.test(word[i + 1] || '') ? 'ff' : 'fi';
    if (/[A-Z]/.test(word) && word === word.toUpperCase()) lig = lig.toUpperCase();
    return fix(word.slice(0, i) + lig + word.slice(i + 1));
  });
}

// Text from earlier versions guessed broken ligatures as "fi" ("ofi", "difierent") or "ff" ("identiffed").
// Returns the corrected text, so those parts can be re-voiced.
export function refixLigatures(text, words) {
  return text.replace(/[A-Za-z]*f[fi][A-Za-z]*/g, word => {
    const lower = word.toLowerCase();
    for (const { index: i } of lower.matchAll(/f(?=[fi])/g)) {
      const asIs = wordCover(lower, i, i + 2, words);
      let best = null, score = 0;
      for (const l of LIGATURES.filter(l => l !== lower.slice(i, i + 2))) {
        const sc = wordCover(lower.slice(0, i) + l + lower.slice(i + 2), i, i + l.length, words);
        if (sc > score) { best = l; score = sc; }
      }
      // only when the current spelling is clearly worse ("fit" must not become "flit")
      if (best && (asIs === 0 || score >= asIs + 2)) return word.slice(0, i) + (word === word.toUpperCase() ? best.toUpperCase() : best) + word.slice(i + 2);
    }
    return word;
  });
}

// Text-based PDF or scanned images? (scanned PDFs have almost no extractable text)
export function looksScanned(pages) {
  const chars = pages.reduce((n, p) => n + p.reduce((m, l) => m + l.text.length, 0), 0);
  return chars / Math.max(1, pages.length) < 40;
}

const norm = s => s.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
// lowercase roman numerals only: a lone capital I, M, C... is far more often a decorative drop cap
const PAGE_NUM = /^((?:page|Page|PAGE)\s*)?(\d+|[ivxlcdm]+|[IVXLCDM]{2,})(\s*(of|\/)\s*\d+)?$/;
const HEADING_RE = /^((chapter|part|book)\s+(\d+|[ivxlc]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*([:.]|$)|(prologue|epilogue|introduction|preface|foreword|conclusion|afterword|appendix)\b)/i;

// Front matter that is not worth listening to and the index (only skipped when the PDF has bookmarks naming them)
const SKIP_SECTION = /^(cover|title( page)?|half title|copyright|contents|table of contents|index)$/i;

// pages: [[{text,size}]], outline: [{title, page}] (PDF bookmarks, 1-based pages) -> sections [{title,text}]
export function pagesToSections(pages, bookTitle, outline = []) {
  // Repeated running headers/footers: top/bottom 2 lines recurring on many pages
  const edgeCount = new Map();
  const edgeLines = p => [...p.slice(0, 2), ...p.slice(-2)];
  for (const p of pages) for (const k of new Set(edgeLines(p).map(l => norm(l.text)))) edgeCount.set(k, (edgeCount.get(k) || 0) + 1);
  const minRepeat = Math.max(3, pages.length * 0.04);

  // Body font size = size covering the most characters
  const bySize = new Map();
  for (const p of pages) for (const l of p) { const s = Math.round(l.size); bySize.set(s, (bySize.get(s) || 0) + l.text.length); }
  const body = [...bySize].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  const isHeading = ({ text: t, size }) => t.length <= 80 && /[a-z].*[a-z]/i.test(t) && !/[,;]$/.test(t) &&
    (size >= body * 1.25 || (HEADING_RE.test(t) && t.length <= 60));

  const kept = pages.map(p => p.filter((l, i) => {
    if (PAGE_NUM.test(l.text)) return false;
    const atEdge = i < 2 || i >= p.length - 2;
    return !(atEdge && !isHeading(l) && edgeCount.get(norm(l.text)) >= minRepeat);
  }));

  // Bookmarks are the author's own chapter list, so trust them over guessing from font sizes.
  // ponytail: chapters start at page granularity; text before the first bookmark (the cover) is dropped
  const marks = outline.filter(m => m.page >= 1 && m.page <= pages.length).sort((a, b) => a.page - b.page);
  if (marks.length >= 2) {
    return marks.map((m, i) => {
      const lines = kept.slice(m.page - 1, (marks[i + 1]?.page ?? pages.length + 1) - 1).flat();
      while (lines.length && isHeading(lines[0])) lines.shift();   // the printed heading duplicates the title
      return { title: m.title, text: joinLines(lines, body) };
    }).filter(sec => !SKIP_SECTION.test(sec.title.trim()));
  }

  const sections = [{ title: bookTitle, lines: [] }];
  let prevHeading = false;
  for (const l of kept.flat()) {
    const heading = isHeading(l), cur = sections.at(-1);
    if (heading) {
      // "Chapter 3" + "The Title" -> "Chapter 3. The Title"; a heading wrapped over two lines is joined with a space
      if (prevHeading) cur.title = (cur.title + (/(^(chapter|part|book)\s+\S+|\d)$/i.test(cur.title) ? '. ' : ' ') + l.text).slice(0, 160);
      else if (sections.length === 1 && !cur.lines.length) cur.title = l.text;
      else sections.push({ title: l.text, lines: [] });
    } else cur.lines.push(l);
    prevHeading = heading;
  }
  return sections.map(sec => ({ title: sec.title, text: joinLines(sec.lines, body) }));
}

function joinLines(lines, body) {
  let text = '', dropCap = '', wait = 0;
  for (const l of lines) {
    // Decorative first letter: attach it to the next line that starts mid-word ("S" + "oon I was"),
    // which may come after an epigraph printed in between
    if (l.size >= body * 1.25 && /^[A-Z]$/.test(l.text)) { dropCap = l.text; wait = 8; continue; }
    let t = l.text;
    if (dropCap && /^[a-z]/.test(t) && !/[a-z,;-]$/.test(text)) { t = dropCap + t; dropCap = ''; }   // not mid-sentence
    else if (dropCap && --wait <= 0) dropCap = '';
    if (text.endsWith('-')) text = /^[a-z]/.test(t) ? text.slice(0, -1) + t : text + t;   // re-join hyphenated word
    else text = text ? text + ' ' + t : t;
  }
  return text;
}

// Repair chapter times for audio already generated: find where each section's opening words
// were spoken inside the stored chunks. chunks: [{parts, seconds}] in order -> [{title, start}]
export function chapterTimes(sections, chunks) {
  // older text-cleanup versions differ slightly (ligatures, drop caps), so compare loosely and try a few probes
  const loose = s => s.replace(/\s+/g, ' ').replace(/ff/g, 'fi').trim();
  let t = 0;
  const spans = chunks.map(c => { const text = loose(c.parts.join(' ')); const span = { text, start: t, seconds: c.seconds || 0 }; t += span.seconds; return span; });
  const out = [];
  let from = 0;
  for (const sec of sections) {
    const text = loose(sec.text);
    for (const k of [0, 60, 150, 300]) {
      const probe = text.slice(k, k + 40);
      if (probe.length < 15) break;
      const i = spans.findIndex((s, n) => n >= from && s.text.includes(probe));
      if (i < 0) continue;
      const sp = spans[i], pos = Math.max(0, sp.text.indexOf(probe) - k);
      out.push({ title: sec.title, start: sp.start + (pos / sp.text.length) * sp.seconds });
      from = i;
      break;
    }
  }
  return out;
}

const ABBR = /\b(mr|mrs|ms|dr|prof|st|vs|etc|e\.g|i\.e|no|fig|vol|pp?|inc|ltd|co|jr|sr)\.$/i;

export function splitSentences(text) {
  const out = [];
  for (const s of text.split(/(?<=[.!?…]["'”’)\]]*)\s+(?=["'“‘(\[]?[A-Z0-9])/)) {
    if (out.length && ABBR.test(out.at(-1))) out[out.length - 1] += ' ' + s;
    else out.push(s);
  }
  return out.flatMap(s => splitLong(s.trim(), MAX_PART)).filter(s => /\w/.test(s));
}

function splitLong(s, max) {
  const parts = [];
  while (s.length > max) {
    let cut = Math.max(s.lastIndexOf('; ', max), s.lastIndexOf(', ', max), s.lastIndexOf(': ', max));
    if (cut < max * 0.4) cut = s.lastIndexOf(' ', max);
    if (cut <= 0) cut = max;
    parts.push(s.slice(0, cut + 1).trim());
    s = s.slice(cut + 1).trim();
  }
  if (s) parts.push(s);
  return parts;
}

// sections -> { chunks: [{chapter, heading, parts[]}], chapters: [{title, chunk}] }
// Every chapter starts a new chunk so chapter start times line up with chunk boundaries.
export function makeChunks(sections, target = CHUNK_CHARS) {
  const chunks = [], chapters = [];
  sections.forEach((sec, ci) => {
    chapters.push({ title: sec.title, chunk: chunks.length });
    let parts = [/[.!?]$/.test(sec.title) ? sec.title : sec.title + '.'];
    let len = 0, heading = true;
    for (const s of splitSentences(sec.text)) {
      if (len + s.length > target && len) { chunks.push({ chapter: ci, heading, parts }); parts = []; len = 0; heading = false; }
      parts.push(s);
      len += s.length;
    }
    chunks.push({ chapter: ci, heading, parts });
  });
  return { chunks, chapters };
}

// --- ID3v2.4 tag carrying title + chapter list, so an exported MP3 can be re-imported on another device
const enc = new TextEncoder(), dec = new TextDecoder();
const syncsafe = n => [(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127];
const cat = arrs => { const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0)); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; };
const frame = (id, body) => cat([enc.encode(id), new Uint8Array([...syncsafe(body.length), 0, 0]), body]);

export function id3Tag(meta) {
  const frames = cat([
    frame('TIT2', cat([new Uint8Array([3]), enc.encode(meta.title)])),
    frame('TXXX', cat([new Uint8Array([3]), enc.encode('audiobook'), new Uint8Array([0]), enc.encode(JSON.stringify(meta))])),
  ]);
  return cat([new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, ...syncsafe(frames.length)]), frames]);
}

export function readId3Meta(b) {
  if (b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33 || b[3] !== 4) return null;
  const ss = o => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];
  const end = Math.min(b.length, 10 + ss(6));
  for (let o = 10; o + 10 <= end && b[o];) {
    const id = dec.decode(b.subarray(o, o + 4)), len = ss(o + 4), body = b.subarray(o + 10, o + 10 + len);
    if (id === 'TXXX') {
      const z = body.indexOf(0, 1);
      if (dec.decode(body.subarray(1, z)) === 'audiobook') return JSON.parse(dec.decode(body.subarray(z + 1)));
    }
    o += 10 + len;
  }
  return null;
}

export function fmtTime(s) {
  s = Math.max(0, Math.round(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
}

export function titleFromFilename(name) {
  let t = name.replace(/\.pdf$/i, '').split(' -- ')[0];
  if (!t.includes(' ')) t = t.replace(/[-_]+/g, ' ');
  return t.replace(/\s*_\s*/g, ': ').replace(/\s+/g, ' ').trim() || 'Untitled';
}
