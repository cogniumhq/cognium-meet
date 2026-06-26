# Cognium Meet — Roadmap

You have a working core loop: record a browser tab → transcribe via Whisper → download timestamped TXT/JSON. This document outlines practical next steps, ordered by impact.

**Legend:** ✅ Done · 🟡 Partial · ⬜ Not started

## Shipped (not originally on roadmap)

| Status | Item |
|--------|------|
| ✅ | **Record any `http`/`https` tab** (not only Google Meet) |
| ✅ | **Microphone device picker** in Settings (`deviceId` binding; Chrome ≠ OS default) |
| ✅ | **Multipart upload** (no base64 bloat) + **150 MB** API body limit |
| ✅ | **Whisper prep**: compress to MP3 + **chunk long audio** before transcription |
| ✅ | **IndexedDB local backup** before upload; **Retry upload** on failure |
| ✅ | **Stop recording** without transcribe (save locally; transcribe later) |
| ✅ | **Delete local** (IndexedDB) and **Delete on server** (`DELETE /v1/recordings/:id`) |
| ✅ | **API request logging** + transcription lifecycle logs |
| ✅ | **Retry transcription** endpoint + OpenAI connection retries |
| ✅ | **Recording state** survives popup close / service worker restart |
| ✅ | **Consent banner** on recorded tabs |

---

## Tier 1 — Reliability & daily usability (do these first)

These address pain already hit during testing.

| Status | Item | Why |
|--------|------|-----|
| ✅ | **Background transcription** | Upload + poll run in the service worker; safe to close the popup while transcribing. |
| 🟡 | **Auto mic prompt on first record** | Mic grant + device picker live in **Settings**; popup warns when mic is missing. No in-popup CTA before first record yet. |
| ✅ | **Recording survives tab close** | On tab close or capture end, recorder stops and saves/uploads (no silent discard). |
| 🟡 | **Long meeting support (>30 min)** | Multipart upload, MP3 compression, Whisper chunking, and higher body limit are in. No live chunked upload *during* recording yet. |
| 🟡 | **Dev ergonomics** | `pnpm dev` / `dev:api` / `dev:extension`, `/health` endpoint, README notes on stale `:3847` and inotify. No `/version` or `dev:api:restart` script yet. |
| ⬜ | **Integration tests** | API upload → ffmpeg → Whisper (mocked) + extension audio-bytes round-trip tests. *(Only `packages/shared` has a unit test today.)* |

## Tier 2 — Otter/Fellow basics (biggest product jump)

| Status | Item | Why |
|--------|------|-----|
| ⬜ | **AI meeting notes** | Post-process `transcript.json` with `@ax-llm/ax`: summary, action items, decisions, open questions. |
| ⬜ | **Speaker labels** | Whisper doesn't diarize. Add Deepgram (`diarize=true`) or pyannote. |
| ⬜ | **In-popup transcript viewer** | Today you only download TXT/JSON. Show transcript inline with search and copy. |
| ⬜ | **SRT / VTT export** | Small addition on top of existing segments. |
| ⬜ | **Search across past meetings** | Index transcripts in SQLite or the API. |

## Tier 3 — Smarter capture

| Status | Item | Why |
|--------|------|-----|
| ⬜ | **Real-time captions** | Stream chunks to a live STT API; show captions in a sidebar or panel. |
| ⬜ | **Separate mic vs tab tracks** | Two streams → better diarization ("You" vs "Others"). |
| ⬜ | **Language detection + translation** | Optional translate-to-English (or target language) in the API. |
| ⬜ | **Calendar integration** | Google Calendar → suggest "Record this meeting?" when a call starts. |

## Tier 4 — Platform & scale

| Status | Item | Why |
|--------|------|-----|
| ⬜ | **Hosted API** | Deploy API (Fly.io, Railway, etc.) so users aren't on `localhost:3847`. |
| ⬜ | **User accounts / OAuth** | Replace bearer token with Google sign-in; per-user storage. |
| ⬜ | **Meeting bot path** | Playwright bot joins as a participant (Fireflies-style). |
| ⬜ | **Zoom / Teams** | Same pipeline, different capture per platform. |

## Suggested order (next 3 sprints)

```mermaid
flowchart TD
  subgraph sprint1 [Sprint 1 - Trust]
    A["Background upload and transcribe in SW ✅"]
    B["Auto mic permission UX 🟡"]
    C["Integration tests ⬜"]
  end
  subgraph sprint2 [Sprint 2 - Value]
    D["Ax meeting summary plus action items ⬜"]
    E["In-popup transcript viewer ⬜"]
    F["Search past transcripts ⬜"]
  end
  subgraph sprint3 [Sprint 3 - Polish]
    G["Speaker diarization ⬜"]
    H["Long meeting chunking 🟡"]
    I["Hosted API deploy ⬜"]
  end
  sprint1 --> sprint2 --> sprint3
```

- **Sprint 1** — Mostly done; finish mic-in-popup UX + integration tests.
- **Sprint 2** — Where it starts to feel like Otter (notes + readable output).
- **Sprint 3** — Multi-speaker meetings and production readiness.

## Quick wins (≈1 day each)

| Status | Item |
|--------|------|
| ✅ | Show full error text in history for failed / upload_failed recordings |
| ⬜ | **Open transcript folder** link in popup (path to `storage/transcripts/`) |
| ⬜ | **Whisper model toggle** in API env (`whisper-1` vs `gpt-4o-mini-transcribe`) |
| ⬜ | **Recording quality indicator** — byte size / duration before upload |
| ⬜ | **Auto-restart API** — `pnpm dev:api:restart` script |

## Recommended starting point

**Integration tests + in-popup mic CTA** — closes out Sprint 1 trust work.

Then **AI meeting notes (`@ax-llm/ax`)** — biggest step toward Otter/Fellow.
