# Cognium Meet

Record Google Meet tab audio with a Chrome extension, transcribe via OpenAI Whisper, and save timestamped text files.

## Architecture

- **Chrome extension** (`apps/extension`) — captures Meet tab audio with `tabCapture` + offscreen `MediaRecorder`
- **API** (`apps/api`) — accepts WebM uploads, runs Whisper, writes `transcript.txt` + `transcript.json`
- **Shared types** (`packages/shared`) — recording metadata and transcript formatting

## Prerequisites

- Node.js 20+
- pnpm 9+
- Chrome (stable)
- OpenAI API key with Whisper access

## Setup

### 1. Install dependencies

```bash
cd cognium-meet
pnpm install
pnpm build
```

### 2. Configure API

```bash
cp apps/api/.env.example apps/api/.env
```

Edit `apps/api/.env`:

```env
OPENAI_API_KEY=sk-...
PORT=3847
API_TOKEN=dev-token-change-me
DELETE_AUDIO_AFTER_TRANSCRIPTION=true
```

Start the API (loads `apps/api/.env` automatically):

```bash
pnpm dev:api
```

Health check: `curl http://localhost:3847/health`

> **ENOSPC / file watcher limit:** `dev:api` and `dev:extension` run **without** hot-reload to avoid Linux inotify limits. Restart them after code changes, or use `dev:watch` variants once you raise `fs.inotify.max_user_watches` (e.g. `echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf && sudo sysctl -p`).

### 3. Load the Chrome extension

```bash
pnpm dev:extension
```

This builds into `apps/extension/dist`. Re-run after extension code changes, then click **Reload** on `chrome://extensions`.

Optional hot-reload: `pnpm --filter @cognium/meet-extension dev:watch`

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select `cognium-meet/apps/extension/dist`
5. Open extension **Settings** and set:
   - API URL: `http://localhost:3847`
   - API Token: same value as `API_TOKEN` in `.env`
   - Click **Grant microphone access** (see below)

### Microphone capture

`chrome.tabCapture` records only what the meeting tab plays through your speakers —
that is, the **other** participants. Google Meet does not loop your own microphone
back into your tab, so to also record **your** voice the recorder mixes in your
microphone.

Click **Grant microphone access** in Settings once. After that the offscreen
recorder mixes mic + tab audio automatically. Without it, recordings contain only
remote participants (and a solo test will be silent — Whisper returns just `you`).

## Manual E2E test

1. Start the API (`pnpm dev:api`) and load the extension.
2. Open [Google Meet](https://meet.google.com) and join or start a meeting.
3. Play audio in the meeting (speak or share a short audio clip).
4. Click the Cognium Meet extension → **Start recording**.
5. Confirm the red consent banner appears on the Meet page.
6. Record for at least 30 seconds, then click **Stop & transcribe**.
7. Wait for status **Transcript ready**.
8. In **Recent transcripts**, click **Download TXT** and verify timestamped lines.
9. Download JSON and confirm `segments` with `start`, `end`, and `text`.

### Edge cases to verify

| Case | Expected |
|------|----------|
| Start on non-Meet tab | Error: open a Google Meet tab |
| Close Meet tab while recording | Recording stops; error on stop if tab gone |
| Empty / very short recording | Upload may fail or Whisper returns minimal text |
| Solo meeting without mic grant | Silent audio; transcript is just `you` (grant mic) |
| API down during upload | Popup shows upload error |

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/v1/recordings` | Upload `audio` (multipart) + optional metadata |
| `GET` | `/v1/recordings/:id` | Poll status (`processing`, `completed`, `failed`) |
| `GET` | `/v1/recordings/:id/transcript.txt` | Plain text transcript |
| `GET` | `/v1/recordings/:id/transcript.json` | JSON with segments |

Auth: `Authorization: Bearer <API_TOKEN>` when `API_TOKEN` is set.

## Output format

**transcript.txt**

```
[00:00:00] Welcome everyone to the sprint review.
[00:00:12] Let's start with the backend updates.
```

**transcript.json**

```json
{
  "recordingId": "uuid",
  "language": "en",
  "duration": 120.5,
  "segments": [
    { "start": 0.0, "end": 4.2, "text": "Welcome everyone..." }
  ]
}
```

## Legal / consent

Recording laws vary by jurisdiction. The extension shows an on-page banner while recording. You must inform all participants before recording.

## Development

```bash
pnpm typecheck   # typecheck all packages
pnpm test        # run shared unit tests
pnpm build       # build all packages
```

Transcripts and metadata are stored under `storage/` (gitignored).

## Roadmap (not in v1)

- AI summaries via `@ax-llm/ax`
- Speaker diarization (Deepgram / pyannote)
- Real-time streaming captions
- Meeting bot auto-join
