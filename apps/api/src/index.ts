import "dotenv/config";
import { serve } from "@hono/node-server";
import { join } from "node:path";
import { createApp } from "./app.js";
import { resumePendingRecordings } from "./transcription/process-recording.js";
import { OpenAIDiarizeProvider } from "./transcription/openai-diarize.js";
import { OpenAIWhisperProvider } from "./transcription/openai-whisper.js";
import { RecordingStore } from "./storage/recording-store.js";

const port = Number.parseInt(process.env.PORT ?? "3847", 10);
const storageDir = process.env.STORAGE_DIR ?? join(process.cwd(), "../../storage");
const apiToken = process.env.API_TOKEN;
const openaiKey = process.env.OPENAI_API_KEY;

if (!openaiKey) {
  console.error("OPENAI_API_KEY is required");
  process.exit(1);
}

const store = new RecordingStore(storageDir);
await store.ensureReady();

const transcriptionModel = process.env.TRANSCRIPTION_MODEL ?? "gpt-4o-transcribe-diarize";
const transcription =
  transcriptionModel === "whisper-1"
    ? new OpenAIWhisperProvider(openaiKey)
    : new OpenAIDiarizeProvider(openaiKey);
const deleteAudioAfterTranscription =
  process.env.DELETE_AUDIO_AFTER_TRANSCRIPTION !== "false";

const maxUploadBytes = Number.parseInt(
  process.env.MAX_UPLOAD_BYTES ?? String(150 * 1024 * 1024),
  10,
);

const deps = {
  store,
  transcription,
  apiToken,
  deleteAudioAfterTranscription,
  maxUploadBytes,
};

const app = createApp(deps);

void resumePendingRecordings(deps);

serve({ fetch: app.fetch, port }, () => {
  console.log(`cognium-meet API listening on http://localhost:${port}`);
  console.log(`Transcription model: ${transcriptionModel}`);
});
