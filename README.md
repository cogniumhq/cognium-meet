# Cognium Meet

Chrome extension + local API for recording browser tab audio (any `http`/`https` tab, including Google Meet), transcribing with OpenAI Whisper or diarized transcription, and generating AI meeting notes and Q&A over your saved meetings.

**What you get**

- **Record** tab audio with optional microphone (mixed or dual-track **You** / **Others**)
- **Transcribe** via OpenAI `whisper-1` (fast) or `gpt-4o-transcribe-diarize` (speaker labels)
- **Meeting notes** — summary, action items, decisions, open questions (`@ax-llm/ax`)
- **Ask** — natural-language questions across one meeting or your full history
- **Meeting AI** — OpenAI (BYOK in extension Settings) or local **Ollama** for notes + Ask

## Architecture

- **Chrome extension** (`apps/extension`) — `tabCapture` + offscreen `MediaRecorder`, IndexedDB backup, background upload/transcription/Ask in the service worker
- **API** (`apps/api`) — multipart audio upload, ffmpeg prep/chunking, transcription, notes generation, semantic search + Ask
- **Shared types** (`packages/shared`) — recording metadata, transcript/notes formatting, client settings

## Prerequisites

- Node.js 20+
- pnpm 9+
- Chrome (stable)
- OpenAI API key for transcription (and for notes/Ask when using OpenAI as the meeting AI provider). Default transcription model is `whisper-1`; choose **Diarize** in extension Settings for speaker labels.

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
2. Open a tab with audio (e.g. [Google Meet](https://meet.google.com) or any page playing speech).
3. Click the Cognium Meet extension → **Start recording**.
4. Record for at least 30 seconds, then click **Stop & transcribe**.
5. Wait for **Transcript ready** (and **Notes ready** if meeting notes are enabled).
6. View the transcript in the popup, or download TXT/JSON.
7. If notes are enabled, download notes JSON/MD or open them in the popup.
8. In **Ask**, ask a question about the recording (or all meetings) and confirm an answer with citations.

### Edge cases to verify

| Case | Expected |
|------|----------|
| Start on `chrome://` or restricted page | Error: open a normal `http`/`https` tab |
| Close recorded tab while recording | Recording stops; error on stop if tab gone |
| Empty / very short recording | Upload may fail or transcription returns minimal text |
| Solo meeting without mic grant | Silent audio; little or no transcript (grant mic) |
| API down during upload | Popup shows upload error |

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/v1/recordings` | Upload `audio` (multipart) + client settings metadata |
| `GET` | `/v1/recordings/:id` | Poll status (`processing`, `completed`, `failed`, notes status) |
| `POST` | `/v1/recordings/:id/retry` | Retry failed/stale transcription |
| `DELETE` | `/v1/recordings/:id` | Delete recording and transcripts |
| `GET` | `/v1/recordings/:id/transcript.txt` | Plain text transcript |
| `GET` | `/v1/recordings/:id/transcript.json` | JSON with segments |
| `GET` | `/v1/recordings/:id/notes.json` | AI meeting notes (JSON) |
| `GET` | `/v1/recordings/:id/notes.md` | AI meeting notes (Markdown) |
| `POST` | `/v1/recordings/:id/notes` | Regenerate meeting notes |
| `POST` | `/v1/ask` | Ask about meetings (`{ messages, recordingId?, llmProvider?, meetingLlmModel? }`) |

Auth: `Authorization: Bearer <API_TOKEN>` when `API_TOKEN` is set.

For OpenAI transcription/notes/Ask, send `X-OpenAI-Key` from the extension (or rely on server `OPENAI_API_KEY`). Meeting AI provider, models, upload limits, and delete-audio behavior are sent per request from extension Settings.

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

Speaker labels (`Speaker 1`, `Speaker 2`, …) appear when using **Diarize** or **dual-track** capture (**You** / **Others**).

**notes.json** (when meeting notes are enabled)

```json
{
  "recordingId": "uuid",
  "summary": "Sprint review covered backend updates and release timing.",
  "actionItems": ["Ship API retry endpoint by Friday"],
  "decisions": ["Use Whisper as default transcription model"],
  "openQuestions": ["Do we need hosted API for beta users?"]
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

## Roadmap

See [ROADMAP.md](./ROADMAP.md) for shipped features and next steps (known-speaker **You** on mixed diarize, real-time captions, hosted API, etc.).
