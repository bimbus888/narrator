import test from 'node:test';
import assert from 'node:assert/strict';
import { itemsToLines, looksScanned, pagesToSections, splitSentences, makeChunks, id3Tag, readId3Meta, fmtTime, titleFromFilename, MAX_PART, mp3Seconds } from '../lib.js';

const body = 'The quick brown fox jumps over the lazy dog near the river bank at dawn.';
const page = (n, extra = []) => [
  { text: 'MY BOOK RUNNING HEADER', size: 9 },
  ...extra,
  { text: body, size: 11 }, { text: body, size: 11 },
  { text: String(n), size: 9 },
];

test('itemsToLines groups by baseline and inserts spaces', () => {
  const lines = itemsToLines([
    { str: 'Hello', x: 0, y: 100, w: 30, h: 10 },
    { str: 'world', x: 35, y: 100, w: 30, h: 10 },
    { str: 'Next', x: 0, y: 80, w: 20, h: 10 },
  ]);
  assert.deepEqual(lines.map(l => l.text), ['Hello world', 'Next']);
});

test('removes repeated headers and page numbers, detects chapters', () => {
  const pages = [
    page(1, [{ text: 'Chapter 1', size: 20 }, { text: 'The Beginning', size: 20 }]),
    page(2),
    page(3, [{ text: 'Chapter 2', size: 20 }]),
    page(4),
    page(5, [{ text: 'Chapter 3', size: 20 }]),
  ];
  const secs = pagesToSections(pages, 'Fallback');
  assert.deepEqual(secs.map(s => s.title), ['Chapter 1. The Beginning', 'Chapter 2', 'Chapter 3'], 'headings at page tops are not mistaken for running headers');
  const all = secs.map(s => s.text).join(' ');
  assert.ok(!all.includes('RUNNING HEADER'));
  assert.ok(!/\b[1-5]\b/.test(all), 'page numbers removed');
});

test('body-size "Chapter N" line counts as heading; "Part of the..." does not', () => {
  const secs = pagesToSections([[{ text: body, size: 11 }, { text: 'Chapter Three', size: 11 }, { text: 'Part of the reason was simple.', size: 11 }, { text: body, size: 11 }]], 'T');
  assert.deepEqual(secs.map(s => s.title), ['T', 'Chapter Three']);
});

test('re-joins hyphenated words across lines', () => {
  const secs = pagesToSections([[{ text: 'An exam-', size: 11 }, { text: 'ple at Sloan-', size: 11 }, { text: 'Kettering.', size: 11 }]], 'T');
  assert.equal(secs[0].text, 'An example at Sloan-Kettering.');
});

test('drop caps rejoin their word; inline "chapter 10," references are not headings', () => {
  const secs = pagesToSections([[
    { text: 'Chapter One', size: 20 }, { text: 'S', size: 40 }, { text: 'ome years ago I went home.', size: 11 },
    { text: 'chapter 10, “Profitable Firms.”', size: 11 }, { text: body, size: 11 },
  ]], 'T');
  assert.deepEqual(secs.map(s => s.title), ['Chapter One']);
  assert.ok(secs[0].text.startsWith('Some years ago'));
});

test('wrapped headings join with a space, "CHAPTER 3" + title with a full stop', () => {
  const secs = pagesToSections([[{ text: 'CHAPTER 3', size: 20 }, { text: 'The Acquisition', size: 20 }, { text: 'Process', size: 20 }, { text: body, size: 11 }]], 'T');
  assert.equal(secs[0].title, 'CHAPTER 3. The Acquisition Process');
});

test('broken "fi" ligature is repaired', () => {
  assert.equal(itemsToLines([{ str: 'the \u0000nal step', x: 0, y: 0, w: 50, h: 10 }])[0].text, 'the final step');
});

test('scanned detection', () => {
  assert.ok(looksScanned([[], [], [{ text: 'x', size: 1 }]]));
  assert.ok(!looksScanned([page(1)]));
});

test('sentence split respects abbreviations and max length', () => {
  const s = splitSentences('Mr. Smith went home. He slept! Did he? Yes.');
  assert.deepEqual(s, ['Mr. Smith went home.', 'He slept!', 'Did he?', 'Yes.']);
  const long = splitSentences(('word, ').repeat(200));
  assert.ok(long.length > 1 && long.every(p => p.length <= MAX_PART));
  assert.equal(long.join(' ').replace(/\s+/g, ' ').trim(), ('word, ').repeat(200).trim());
});

test('long documents are chunked and every chapter starts a chunk', () => {
  const sections = [{ title: 'One', text: (body + ' ').repeat(200) }, { title: 'Two', text: body }];
  const { chunks, chapters } = makeChunks(sections, 1200);
  assert.ok(chunks.length > 10);
  assert.ok(chunks.every(c => c.parts.join(' ').length <= 1200 + MAX_PART));
  assert.equal(chunks[chapters[1].chunk].chapter, 1);
  assert.equal(chunks[chapters[1].chunk].parts[0], 'Two.');
  assert.ok(chunks[chapters[1].chunk].heading && !chunks[1].heading);
  const spoken = chunks.flatMap(c => c.parts).join(' ');
  assert.equal((spoken.match(/lazy dog/g) || []).length, 201, 'no text lost');
});

test('ID3 tag round-trips metadata, including unicode', () => {
  const meta = { title: 'Café — Ünïcode', chapters: [{ title: 'Intro', start: 0 }, { title: 'Two', start: 61.5 }], duration: 120 };
  const tag = id3Tag(meta);
  const file = new Uint8Array(tag.length + 4); file.set(tag);
  assert.deepEqual(readId3Meta(file), meta);
  assert.equal(readId3Meta(new Uint8Array([0xff, 0xfb, 0, 0])), null);
});

test('formatting helpers', () => {
  assert.equal(fmtTime(65), '1:05');
  assert.equal(fmtTime(3725), '1:02:05');
  assert.equal(titleFromFilename("Start Something -- Mycoskie -- 2012.pdf"), 'Start Something');
  assert.equal(titleFromFilename('Financial Statements_ A Guide -- Ittelson.pdf'), 'Financial Statements: A Guide');
  assert.equal(titleFromFilename('Financial-Intelligence-for-Entrepreneurs_-What.pdf'), 'Financial Intelligence for Entrepreneurs What');
  assert.equal(mp3Seconds(6000), 1);
});
