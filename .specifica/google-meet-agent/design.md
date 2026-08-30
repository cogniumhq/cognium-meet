# Design: Google Meet Agent

## Architecture

```text
Google Meet tab
      |
      v
Chrome extension action
      |
      v
tabCapture + offscreen MediaRecorder
      |
      +--> IndexedDB local backup
      |
      v
Local API: POST /v1/recordings
      |
      v
ffmpeg preparation and chunking
      |
      v
Whisper or diarized transcription
      |
      +--> transcript.txt / transcript.json
      |
      v
Meeting notes generation
      |
      +--> notes.md / notes.json
      |
      v
SQLite search index + Ask API
```

## Components

### Chrome extension

- The popup starts and stops recording and displays recording history.
- The service worker owns recording orchestration, upload, polling, retry, and
  Ask requests so work survives popup closure.
- The offscreen document owns `MediaRecorder` because recording APIs are not
  available directly in the service worker.
- `chrome.tabCapture` captures audio played by the active tab.
- Microphone audio is either mixed with tab audio or uploaded as a separate
  track for dual-track capture.
- IndexedDB stores pending audio until upload succeeds.

### Local API

- `POST /v1/recordings` accepts multipart audio and per-request settings.
- The recording store namespaces data by `X-Cognium-User-Id`.
- ffmpeg compresses and chunks recordings that exceed transcription limits.
- The transcription pipeline uses Whisper or diarized transcription.
- Notes generation runs after successful transcription.
- The search index supports scoped and full-history Ask requests.

## Data layout

For a user ID `<userId>`, the API stores data under:

```text
storage/users/<userId>/
├── recordings/   # source audio and optional microphone audio
├── transcripts/  # transcript.txt and transcript.json
├── notes/        # notes.md and notes.json
├── meta/         # recording metadata JSON
└── search.db     # per-user SQLite search index
```

The repository-level storage root is:

```text
/home/ahmed/sodium_apps/cognium-meet/storage
```

## API contract

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Check API availability |
| `POST` | `/v1/recordings` | Upload audio and start processing |
| `GET` | `/v1/recordings/:id` | Read recording and notes status |
| `POST` | `/v1/recordings/:id/retry` | Retry failed transcription |
| `DELETE` | `/v1/recordings/:id` | Delete recording and derived files |
| `GET` | `/v1/recordings/:id/transcript.txt` | Download text transcript |
| `GET` | `/v1/recordings/:id/transcript.json` | Download JSON transcript |
| `GET` | `/v1/recordings/:id/notes.md` | Download Markdown notes |
| `GET` | `/v1/recordings/:id/notes.json` | Download JSON notes |
| `POST` | `/v1/recordings/:id/notes` | Regenerate meeting notes |
| `POST` | `/v1/ask` | Ask about one or more meetings |

## Reliability and privacy

- Recording state is persisted in extension storage and can survive popup or
  service-worker restarts.
- Pending audio is backed up in IndexedDB before upload.
- User IDs isolate recordings, transcripts, notes, and search indexes.
- API authentication uses the configured bearer token.
- OpenAI keys may be supplied by extension settings or the server fallback.
- Recording consent remains the user's responsibility.

## Known limitations

- `tabCapture` records audio emitted by the tab, not the microphone by itself.
- Linux/Chrome microphone selection may require choosing a device explicitly.
- Participant display names are unavailable without Meet UI integration.
- Live captions and live chunk upload are not implemented.

