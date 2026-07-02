# Cognium Meet

Record Google Meet tab audio with a Chrome extension, transcribe via OpenAI **gpt-4o-transcribe-diarize**, and save timestamped text files with speaker labels.

## Architecture

- **Chrome extension** (`apps/extension`) — captures Meet tab audio with `tabCapture` + offscreen `MediaRecorder`
- **API** (`apps/api`) — accepts WebM uploads, runs diarized transcription, writes `transcript.txt` + `transcript.json`
- **Shared types** (`packages/shared`) — recording metadata and transcript formatting

## Prerequisites

- Node.js 20+
- pnpm 9+
- Chrome (stable)
- OpenAI API key with access to `gpt-4o-transcribe-diarize` (set `TRANSCRIPTION_MODEL=whisper-1` for legacy Whisper)

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
# Optional server fallback — users can also set their own key in extension Settings
OPENAI_API_KEY=sk-...
PORT=3847
API_TOKEN=dev-token-change-me
```

`OPENAI_API_KEY` on the server is **optional**. If unset, each user must add their **OpenAI API key** in extension Settings (stored locally, sent as `X-OpenAI-Key`). Priority per request: extension key → stored recording key → server fallback.

Transcription model, meeting notes, Ask, Ollama, upload limits, and delete-audio behavior are configured in the **extension Settings** (sent with each upload and Ask request), not in `.env`.

To run notes + Ask with Ollama, open extension Settings and set **Meeting AI provider** to Ollama, then set **Ollama URL** (e.g. `http://localhost:11434`) and **Ollama model** (e.g. `qwen2.5:7b`). The API appends `/v1` automatically for OpenAI-compatible calls. Ollama must be reachable from the machine running the API.

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
   - **OpenAI API key** (unless the server has `OPENAI_API_KEY` set)
   - Transcription model, meeting AI provider, notes/Ask options, upload limit, etc.
   - Click **Grant microphone access** (see below)

### Microphone capture

`chrome.tabCapture` records only what the meeting tab plays through your speakers —
that is, the **other** participants. Google Meet does not loop your own microphone
back into your tab, so to also record **your** voice the recorder mixes in your
microphone.

Click **Grant microphone access** in Settings once. After that the offscreen
recorder mixes mic + tab audio automatically. Without it, recordings contain only
remote participants (and a solo test will be mostly silent without mic).

## Manual E2E test

1. Start the API (`pnpm dev:api`) and load the extension.
2. Open [Google Meet](https://meet.google.com) and join or start a meeting.
3. Play audio in the meeting (speak or share a short audio clip).
4. Click the Cognium Meet extension → **Start recording**.
5. Record for at least 30 seconds, then click **Stop & transcribe**.
6. Wait for status **Transcript ready**.
7. In **Recent transcripts**, click **Download TXT** and verify timestamped lines with speaker labels.
8. Download JSON and confirm `segments` with `start`, `end`, `text`, and `speaker`.

### Edge cases to verify

| Case | Expected |
|------|----------|
| Start on non-Meet tab | Error: open a Google Meet tab |
| Close Meet tab while recording | Recording stops; error on stop if tab gone |
| Empty / very short recording | Upload may fail or transcription returns minimal text |
| Solo meeting without mic grant | Silent audio; little or no transcript (grant mic) |
| API down during upload | Popup shows upload error |

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/v1/recordings` | Upload `audio` (multipart) + optional metadata |
| `GET` | `/v1/recordings/:id` | Poll status (`processing`, `completed`, `failed`) |
| `GET` | `/v1/recordings/:id/transcript.txt` | Plain text transcript |
| `GET` | `/v1/recordings/:id/transcript.json` | JSON with segments |
| `POST` | `/v1/ask` | Ask a question across saved meetings (`{ question, recordingId? }`) |

Auth: `Authorization: Bearer <API_TOKEN>` when `API_TOKEN` is set.

Each Chrome profile sends a stable `X-Cognium-User-Id` (UUID in extension local storage). The API stores recordings under `storage/users/<userId>/` so profiles do not share transcripts.

If you have old recordings from before per-profile storage, either record again or move files manually into your profile folder (find your UUID in extension DevTools → Application → Local Storage → `cogniumUserId`).

## Output format

**transcript.txt**

```
[00:00:00] Speaker 1: Welcome everyone to the sprint review.
[00:00:12] Speaker 2: Let's start with the backend updates.
```

**transcript.json**

```json
{
  "recordingId": "uuid",
  "language": "en",
  "duration": 120.5,
  "segments": [
    { "start": 0.0, "end": 4.2, "text": "Welcome everyone...", "speaker": "Speaker 1" }
  ]
}
```

## Legal / consent

Recording laws vary by jurisdiction. You must inform all participants before recording.

## Development

```bash
pnpm typecheck   # typecheck all packages
pnpm test        # run shared unit tests
pnpm build       # build all packages
```

Transcripts and metadata are stored under `storage/` (gitignored).

## Roadmap (not in v1)

- AI summaries via `@ax-llm/ax`
- Known-speaker **You** label via diarize reference clips
- Real-time streaming captions
- Meeting bot auto-join
