<div align="center">

# cue

**An open-source AI copilot that floats over your screen — sees what you see, hears your meetings, and stays hidden from screen shares.**

A free, self-hosted alternative to Cluely. Bring your own AI key (OpenAI · Anthropic · Google Gemini).

<img src="docs/tutorial.png" width="620" alt="cue first-run tutorial" />

</div>

---

> [!IMPORTANT]
> **Please read this first.** cue tries to stay out of screen recordings/shares, but this is **best-effort, not guaranteed** — on macOS 15.4+ Apple can let modern capture tools see it anyway, and a phone camera always can. Using a hidden assistant during a **proctored exam, job interview, or recorded meeting** may break that platform's rules and, in some places, consent laws. cue is built for legitimate uses — your own notes, studying, accessibility, and practice. **You are responsible for how you use it.**

---

## What it does

cue floats a small glass panel on top of everything. It takes **three separate inputs** — your **screen**, your **microphone**, and your **meeting audio** (what the other person says) — and uses an AI model to help you in real time.

| Feature | How to trigger | What it uses |
|---|---|---|
| **Assist** | `⌘` `↵` or the *Assist* button | your screen + recent conversation |
| **What should I say?** | button | meeting audio + your mic |
| **Follow-up questions** | button | the whole conversation |
| **Recap** | button | the whole conversation |
| **Ask anything** | type + `↵` | your screen + conversation |
| **Solve a coding problem** | `⌘` `H` | your screen only |
| **Smart** toggle | pill in the box | switches to a smarter (slower) model |

It's a copilot for **live meetings** ("what do I say to that?") and **coding problems** (screenshot → full solution), and it's designed to be **invisible in screen shares** so it stays your private assistant.

---

## Install

There are two ways to install cue. **If you're not a developer, use Option A.**

### Option A — Download the app (easiest)

1. Go to the [**Releases**](../../releases) page and download the build for your platform.
2. Extract the archive and run the app from the extracted folder.
3. On macOS, you may need to right-click the app and choose **Open** the first time if Gatekeeper blocks it.

### Option B — Run from source (developers)

You need [Node.js](https://nodejs.org) 22.12+ installed (required by dev dependencies).

```bash
git clone https://github.com/Blueturboguy07/cue.git
cd cue
npm install
npm start
```

To build a packaged app:
```bash
npm run dist:mac    # macOS build
npm run dist:win    # Windows build
npm run dist:linux  # Linux x64 AppImage
```

Packaged builds include a pinned `whisper.cpp` runtime. When running from source, prepare the matching runtime once:

```bash
npm run prepare:whisper
```

Windows x64 and Linux x64/arm64 use checksum-verified binaries from the pinned upstream release. macOS x64/arm64 builds `whisper-server` from the same pinned source tag and requires CMake plus Xcode command-line tools.

> Note: permission grants can reset after a rebuild, so you may need to re-enable microphone/screen access after packaging a fresh build.

---

## First launch — the 1-minute setup

When cue opens the first time, a **built-in tutorial** walks you through everything below. You can reopen it anytime by clicking the **cue logo** (top-left of the pill). Here's the same thing in writing.

### Step 1 — Grant the needed permissions

cue can't help until your OS lets it see and hear. When you first use a feature, your system may prompt you — click **Allow**. If a prompt doesn't appear, add cue manually:

- **Windows:** Settings → **Privacy & security** → **Microphone** → allow **cue**; also enable **Screen recording** for screen capture and meeting-audio capture.
- **macOS:** System Settings → **Privacy & Security** → **Microphone** and **Screen Recording** → turn on **cue**. macOS may ask you to **quit & reopen** cue — let it.

### Step 2 — Add your AI key (bring your own)

cue uses **your own** API key, so it's free to run (you only pay your AI provider for what you use). Click the **`...`** button in the input box (or press `⌘` `,`) to open **Settings**, pick a provider, and paste your key:

| Provider | Get a key | Notes |
|---|---|---|
| **OpenAI** | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | One key does everything — **but** for the *listening* features the key must have **Whisper / audio** access (a "restricted" project key that only allows chat will give a 403 on transcription). |
| **Anthropic (Claude)** | [console.anthropic.com](https://console.anthropic.com) | Great for screen & coding help. Claude has no speech-to-text, so add an OpenAI or Gemini key too if you want the listening features. |
| **Google Gemini** | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | One key does chat + transcription. |

Your key is stored **only on your computer** (in `cue-data.json`) and is sent **only** to that provider. cue has no server and collects nothing.

### Optional — transcribe locally with whisper.cpp

Open **Settings → Audio**, choose **Local**, and download a model. `base.en` is the recommended English default; all 30 models supported by the official whisper.cpp download script are available, including multilingual, quantized, large, turbo, and TinyDiarize variants.

Local mode is independent from the chat provider, so you can use local speech-to-text with OpenAI, Anthropic, or Gemini chat. The selected model loads once when listening starts, serves both the **You** and **Them** channels, and unloads only after queued speech has been transcribed when listening stops.

- Audio inference stays on your computer and audio is never written to a temporary file.
- Model files are downloaded only when you ask, support cancel/resume, and are checked against pinned byte counts and SHA-256 hashes.
- Local mode never silently sends audio to a cloud fallback. A local failure is reported without sending the audio elsewhere.
- Models are stored under Cue's Electron user-data directory and can be imported or deleted from Settings.

### Optional — tailor answers to your background

In **Settings**, paste your résumé or professional background into **Résumé / professional background**. cue uses it as the factual reference for career-related answers and says when the résumé does not provide a detail. You can clear it anytime.

### Step 3 — The Zoom setting (only needed for Zoom)

cue is hidden from most screen-share tools automatically — **Google Meet, Microsoft Teams, and QuickTime need nothing.** **Zoom** has a specific setting that decides whether it respects cue's "don't capture me" flag:

> **Zoom → Settings → Share Screen → Advanced → Screen capture mode → choose "Advanced capture with window filtering."**

<div align="center"><img src="docs/zoom-setting.png" width="560" alt="Zoom screen capture mode setting" /></div>

**Why:** the *"...with window filtering"* modes tell Zoom to leave out windows that mark themselves as private — which is exactly what cue does. The **"Advanced capture without window filtering"** mode grabs the raw screen and **will show cue**, so avoid it.

---

## How to use it

- **`⌘` `↵` — Assist.** The do-the-smart-thing key. On a coding problem it solves it; in a conversation it tells you what to say. Works from anywhere.
- **`⌘` `H` — Solve what's on screen.** Screenshots a coding problem and returns the approach, code, and time/space complexity.
- **The `▢` button** (top bar) — start/stop **listening** to a meeting. The green dot means it's live.
- **Type a question** in the box and press `↵` to ask about your screen or conversation.
- **Smart** — flip it on for a smarter, more thorough model; off for fast and cheap.
- **Hide** collapses the panel to just the top bar. Drag cue around by the **top pill**. Quit with `⌘` `⇧` `X`.

The panel is see-through and click-through — the empty space around it never blocks the app behind it.

---

## How it works (under the hood)

cue is an [Electron](https://www.electronjs.org/) app. Everything runs locally except the calls to your chosen AI provider.

**The three inputs are kept completely separate:**
- **Screen** — captured with Electron's `desktopCapturer` (full-resolution screenshots, taken only when a feature needs one).
- **Your mic ("You")** — `getUserMedia` → downsampled to 16 kHz audio → transcribed.
- **Meeting audio ("Them")** — `getDisplayMedia` loopback capture of your system's output audio, kept on its own channel so cue knows *who* said what.

Both audio streams are transcribed by the independently selected speech provider (local whisper.cpp, Deepgram, OpenAI, or Gemini) and fed, with an optional screenshot, to your chat model. Responses **stream** into the panel word-by-word.

When Local transcription is selected, Cue runs one persistent `whisper-server` sidecar bound to `127.0.0.1` on a temporary port with a random request path. Voice activity detection creates bounded in-memory utterances with pre-roll, and both channels share a serialized inference queue because one Whisper context must not process concurrent requests. Stop immediately ends new audio capture, drains the current queue for a bounded period, then terminates the sidecar.

**The invisibility** is a single macOS window flag: `setContentProtection(true)`, which sets `NSWindowSharingNone`. This asks the window server to exclude cue from screen-capture streams. It's the same mechanism DRM apps and Zoom's own toolbar use. It is **not** a GPU trick or a special overlay layer — and on macOS 15.4+ Apple lets some capture tools ignore it, which is why it's best-effort (see the disclaimer at the top).

```
main process ──┬─ overlay window (frameless, transparent, always-on-top, content-protected)
               ├─ screenshot capture (desktopCapturer)
               ├─ speech-to-text (Whisper / Gemini)      ── "You" + "Them" channels
               └─ LLM streaming (OpenAI / Anthropic / Gemini)
renderer ──────┴─ the glass UI + mic capture + system-audio loopback
```

---

## Troubleshooting

**Local transcription says the runtime is not prepared.**
Packaged releases include the runtime. If you are running from source, run `npm run prepare:whisper` once and restart Cue. On macOS, install CMake and Xcode command-line tools first.

**Local transcription says the model is missing or invalid.**
Open **Settings → Audio**, select the model, and choose **Download**. A cancelled download can be resumed. If verification fails repeatedly, delete the partial/model file from the same screen and download it again.

**A large local model is slow or runs out of memory.**
Try `base.en`, `tiny.en`, or a quantized `q5`/`q8` model. Model size in Settings is the download size, not a guarantee of runtime RAM use; larger models require substantially more memory and CPU/GPU time.

**"It says give access, but I already gave access."**
You probably granted an older build. Because the app is ad-hoc signed, a rebuild changes its identity and macOS stops honoring the old grant (the checkmark can linger). Toggle cue **off and on** in System Settings → Screen Recording, or remove and re-add it.

**A feature returns "403" / "no access to model."**
Your API key is restricted. Most often it's an OpenAI **project key that only allows chat models** — it works for screen/coding help but 403s on transcription (Whisper). Fix: enable audio/Whisper on the key, use an unrestricted key, or add a Gemini key (cue falls back to it for transcription).

**Listening does nothing / no transcript.**
Check Settings shows a transcription-capable key (OpenAI with Whisper, or Gemini). Also make sure Screen Recording is granted (meeting audio needs it).

**cue shows up in my Zoom share.**
Set Zoom's **Screen capture mode** to *"Advanced capture with window filtering"* (see Step 3). And remember: on macOS 15.4+ this can still fail — it's best-effort.

**"cue is damaged and can't be opened."**
Run `xattr -cr /Applications/cue.app` in Terminal once (see Install → Option A).

---

## Privacy

- No Cue accounts, hosted service, or telemetry. cue collects nothing.
- Your API keys live in a local file (`cue-data.json`) and are sent only to the provider you chose.
- Your optional résumé text also lives in `cue-data.json` and is sent with each model request to your selected AI provider. It is stored as plain text; clear it in Settings to remove it.
- In Local transcription mode, microphone and meeting audio stay on your computer. In cloud transcription modes, audio is sent only to the selected speech provider.
- Audio utterances and the current transcript stay in memory; Cue does not write captured audio to disk. Downloaded local model files remain on disk until you delete them.
- Screenshots are sent to your selected chat provider only when a feature needs the screen.

## Contributing

Issues and PRs welcome. cue is intentionally small and readable — `main.js` (app + capture + AI), `renderer/` (the UI), `src/` (providers). No build step for the source (plain HTML/CSS/JS).

## Credits & license

Built as an open-source study of how tools like **Cluely** and **Interview Coder** work. Modeled on the open-source clones `pickle-com/glass` and `sohzm/cheating-daddy`.

Local transcription uses [whisper.cpp](https://github.com/ggml-org/whisper.cpp), distributed under the MIT License. Its license notice is included in packaged runtimes.

**License: [GPL-3.0-or-later](LICENSE).**
