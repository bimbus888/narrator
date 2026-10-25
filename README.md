# Narrator: free PDF-to-audiobook

Turn a PDF into an audiobook on your own device and listen offline. No accounts, no subscriptions, no paid APIs. Your PDFs and audio never leave your device.

## How it works (one paragraph)

The app is a plain website (a "Progressive Web App"). When you add a PDF, your browser reads the text, removes page numbers and repeated headers, and finds the chapters. When you tap **Generate audio**, a free open-source voice model (**Kokoro-82M**, Apache-2.0 licence, voice "George", a British male) runs *inside your browser* and turns the text into MP3 audio, part by part. Every finished part is saved straight away in the browser's permanent storage on that device, so you can stop and resume at any time. The website itself only serves the app's code; nothing you upload is sent anywhere.

## 1. Run it on your laptop

```bash
cd ~/Desktop/pdf-audiobook && python3 -m http.server 8000
```

Then open **http://localhost:8000** in **Google Chrome** (Chrome uses your Mac's graphics chip, which is the fastest option). Leave the Terminal window open while you use it.

Once the app is hosted online (step 5), you can skip this and just use the web address.

## 2. Make an audiobook (on the laptop)

1. **Library › Add a PDF**. It takes a few seconds, even for a 300-page book.
2. Optional: choose a voice and tap **Preview voice**.
3. Tap **Generate audio**. The first time, it downloads the voice (about 330 MB, once only).
4. Leave the tab open and visible. The screen is kept awake automatically. You can tap **Pause** and **Resume generating** later. Nothing finished is lost, even if you close the browser.

**How long it takes:** on this MacBook (M2) it took about **1.4 minutes per minute of audio**. A 5-hour book is roughly an overnight job. Start it the evening before.

## 3. Put it on your iPhone

Generating on the iPhone works for short documents but is very slow, so make books on the laptop and send them to the phone:

1. On the laptop: **Downloads › Send to phone / export MP3**. Chrome saves `Book title.mp3` to your Downloads folder.
2. AirDrop that file to your iPhone and choose **Save to Files**.
3. On the iPhone, open the app (see below) › **Downloads › Import an audiobook (.mp3)** › pick the file. Chapters and the title come with it.

**Install the app on the iPhone (once):** open the app's web address in **Safari** › Share button › **Add to Home Screen**. Always open it from the home-screen icon. The home-screen app has its own storage, separate from Safari's, and iOS does not auto-clear it.

## 4. At the gym (no internet)

- Before leaving: check the book shows **✓ Downloaded · plays offline** in the Library.
- At the gym: open Narrator from the home screen and tap **Resume**. Lock the phone; playback continues. Use the lock screen or your headphones to play and pause, and the lock screen's ±15 s buttons to skip.
- Your place is saved every few seconds and every time you pause, so it survives closing the app or restarting the phone.

## 5. Share with family

The app needs to be on a free static web host so phones can reach it over HTTPS. **GitHub Pages** is free; the app is about 4 MB of files. Then send everyone the one link. Each person's books and audio stay on their own device. Nobody can see anyone else's, and there is no shared library.

Family members need nothing installed: Chrome or Safari on a laptop to make books, and the home-screen app on the phone to listen.

## Costs and outside services

| What | Cost | Notes |
|---|---|---|
| Voice model (Kokoro-82M) | Free, Apache-2.0 | Downloaded once from huggingface.co, then cached on the device |
| Voice engine runtime files | Free | Downloaded once from cdn.jsdelivr.net, then cached |
| PDF reader (pdf.js), MP3 encoder (lamejs) | Free, open source | Included in `vendor/` |
| Hosting (GitHub Pages) | Free | Serves only the app's code. No API keys, no database, no accounts for users |

No paid API is used anywhere. The only internet use is the first-time download of the app and the voice.

## Limitations (honest list)

- **Speed:** about 0.7x real time on an M2 MacBook with Chrome (measured), and much slower on phones. Long books take hours.
- **Voice:** George is the closest free, legally licensed British male narrator. It is clear and pleasant, but not an Attenborough-quality performance. Fable, Lewis and Daniel are alternatives.
- **iPhone background playback** relies on Safari's standard audio support. It is designed to keep playing with the screen locked, and the whole book is one continuous audio file so iOS never has to start a new track in the background. **This has not been tested on a real iPhone yet** (see below). If iOS ever stops it, the exported MP3 also plays in **BookPlayer** (a free, open-source iPhone audiobook app) as a fallback.
- **Scanned PDFs** (photos of pages) have no text. The app detects this and tells you to run OCR first (for example the free OCRmyPDF).
- **Text cleanup is heuristic.** Two-column layouts, footnotes, tables and front matter (copyright pages) are read as they appear. Chapters come from large headings and "Chapter N" lines, so some books get extra subsection "chapters", which only affects the chapter list.
- Very occasionally a broken PDF font turns "ff" into "fi" (for example "afiection").
- iPhone storage: about 22 MB per hour of audio.

## Tests

```bash
npm test
```

**Automated (run, passing):** 12 unit tests covering text extraction, header, footer and page-number removal, drop caps, hyphenation, chapter detection, sentence splitting, chunking of long books (no text lost), the MP3 chapter tag round trip, and formatting.

**Manual end-to-end in a Chromium browser on this Mac (done):**
- Real PDFs (173 and 321 pages) imported in under 3 seconds each. A scanned PDF was correctly rejected.
- Audio generated with the George voice. A Whisper speech-to-text model transcribed it almost word for word. ffprobe confirms a valid MP3 whose length exactly matches the app's chapter timings.
- Playback, ±15 s, chapter jump, speed changes, sleep timer ("end of chapter" stopped exactly at the chapter boundary), lock-screen metadata.
- Position kept after reload, and one-tap Resume.
- **Offline:** web server switched off, then the app reloaded from its offline cache and the book played from on-device storage.
- Generation interrupted by a page reload, then resumed from the next unfinished part with finished parts kept.
- Export to MP3, then import: title, chapters and duration preserved.
- Deleting audio keeps the original PDF, and the book can be regenerated.

**Still needs your iPhone (not tested; no iPhone or simulator was available):** Add to Home Screen, import via Files, playback in airplane mode, playback with the screen locked, headphone and lock-screen controls, and the position surviving a phone restart.

## Files

`index.html` (UI and styles), `app.js` (library, player, downloads, storage), `lib.js` (text cleanup and chunking, unit-tested), `tts-worker.js` (voice generation and MP3 encoding), `sw.js` (offline support), `vendor/` (open-source libraries), `tests/`.
