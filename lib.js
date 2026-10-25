// Pure helpers (no DOM): PDF text cleanup, chapter detection, chunking, MP3 tag.
// Unit-tested by tests/lib.test.mjs (run: node --test tests/)

export const SAMPLE_RATE = 24000;           // Kokoro output
export const BITRATE = 48;                  // kbps, constant bitrate mono MP3
export const mp3Seconds = bytes => (bytes * 8) / (BITRATE * 1000);
export const MAX_PART = 300;                // chars per TTS call (model limit is ~510 phoneme tokens)
export const CHUNK_CHARS = 1200;            // chars per stored/retryable audio chunk

// pdf.js text items {str,x,y,w,h} -> lines [{text,size}]
export function itemsToLines(items) {
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
  // ponytail: broken PDF fonts often map the "fi" ligature to U+0000; "fi" is the usual culprit
  return lines.map(l => ({ text: l.text.replace(/\u0000/g, 'fi').replace(/\s+/g, ' ').trim(), size: l.h })).filter(l => l.text);
}

// Text-based PDF or scanned images? (scanned PDFs have almost no extractable text)
export function looksScanned(pages) {
  const chars = pages.reduce((n, p) => n + p.reduce((m, l) => m + l.text.length, 0), 0);
  return chars / Math.max(1, pages.length) < 40;
}

const norm = s => s.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
const PAGE_NUM = /^(page\s*)?(\d+|[ivxlcdm]+)(\s*(of|\/)\s*\d+)?$/i;
const HEADING_RE = /^((chapter|part|book)\s+(\d+|[ivxlc]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*([:.]|$)|(prologue|epilogue|introduction|preface|foreword|conclusion|afterword|appendix)\b)/i;

// pages: [[{text,size}]] -> sections [{title,text}]
export function pagesToSections(pages, bookTitle) {
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

  const lines = [];
  for (const p of pages) p.forEach((l, i) => {
    if (PAGE_NUM.test(l.text)) return;
    const atEdge = i < 2 || i >= p.length - 2;
    if (atEdge && !isHeading(l) && edgeCount.get(norm(l.text)) >= minRepeat) return;
    lines.push(l);
  });

  // ponytail: font-size + "Chapter N" heuristic, ignores PDF outline/bookmarks. Add outline if headings get missed.
  const sections = [{ title: bookTitle, text: '' }];
  let prevHeading = false, dropCap = '';
  for (const l of lines) {
    const heading = isHeading(l);
    if (!heading && l.size >= body * 1.25 && /^[A-Z]$/.test(l.text)) { dropCap = l.text; continue; } // decorative first letter
    const t = dropCap + l.text, cur = sections.at(-1);
    dropCap = '';
    if (heading) {
      // "Chapter 3" + "The Title" -> "Chapter 3. The Title"; a heading wrapped over two lines is joined with a space
      if (prevHeading) cur.title = (cur.title + (/(^(chapter|part|book)\s+\S+|\d)$/i.test(cur.title) ? '. ' : ' ') + t).slice(0, 160);
      else if (sections.length === 1 && !cur.text) cur.title = t;
      else sections.push({ title: t, text: '' });
    } else if (cur.text.endsWith('-')) {
      cur.text = /^[a-z]/.test(t) ? cur.text.slice(0, -1) + t : cur.text + t;   // re-join hyphenated word
    } else {
      cur.text = cur.text ? cur.text + ' ' + t : t;
    }
    prevHeading = heading;
  }
  return sections;
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
