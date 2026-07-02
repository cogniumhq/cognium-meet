import "dotenv/config";
import { serve } from "@hono/node-server";
import { join } from "node:path";
import {
  DEFAULT_TRANSCRIPTION_MODEL,
  parseMeetingLlmProvider,
  parseTranscriptionModel,
} from "@cognium/meet-shared";
import { createApp } from "./app.js";
import { resumePendingRecordings } from "./transcription/process-recording.js";
import { createTranscriptionProviderFactory } from "./transcription/create-provider.js";
import { UserStoreRegistry } from "./storage/user-store-registry.js";
import { normalizeOllamaUrl, type MeetingLlmConfig } from "./llm/create-meeting-llm.js";

const port = Number.parseInt(process.env.PORT ?? "3847", 10);
const storageDir = process.env.STORAGE_DIR ?? join(process.cwd(), "../../storage");
const apiToken = process.env.API_TOKEN;
const openaiKey = process.env.OPENAI_API_KEY;

if (!openaiKey) {
  console.error("OPENAI_API_KEY is required");
  process.exit(1);
}

const userRegistry = new UserStoreRegistry(storageDir);

const defaultTranscriptionModel = parseTranscriptionModel(
  process.env.TRANSCRIPTION_MODEL,
  DEFAULT_TRANSCRIPTION_MODEL,
);
const getTranscriptionProvider = createTranscriptionProviderFactory(openaiKey);
const deleteAudioAfterTranscription =
  process.env.DELETE_AUDIO_AFTER_TRANSCRIPTION !== "false";

const notesEnabled = process.env.MEETING_NOTES_ENABLED !== "false";
const notesModel = process.env.MEETING_NOTES_MODEL?.trim() || "gpt-4o-mini";
const askEnabled = process.env.MEETING_ASK_ENABLED !== "false";
const askModel = process.env.MEETING_ASK_MODEL?.trim() || notesModel;
const llmConfig: MeetingLlmConfig = {
  provider: parseMeetingLlmProvider(process.env.MEETING_LLM_PROVIDER?.trim().toLowerCase()),
  openaiApiKey: openaiKey,
  ollamaUrl: normalizeOllamaUrl(process.env.OLLAMA_URL?.trim() || "http://localhost:11434"),
  ollamaModel: process.env.MEETING_OLLAMA_MODEL?.trim() || "qwen2.5:7b",
};

const maxUploadBytes = Number.parseInt(
  process.env.MAX_UPLOAD_BYTES ?? String(150 * 1024 * 1024),
  10,
);

const deps = {
  userRegistry,
  getTranscriptionProvider,
  defaultTranscriptionModel,
  deleteAudioAfterTranscription,
  llmConfig,
  notesModel,
  notesEnabled,
  askEnabled,
  askModel,
  apiToken,
  maxUploadBytes,
};

const app = createApp(deps);

void resumePendingRecordings(deps);

serve({ fetch: app.fetch, port }, () => {
  console.log(`cognium-meet API listening on http://localhost:${port}`);
  console.log(`Default transcription model: ${defaultTranscriptionModel}`);
  console.log(
    `Meeting LLM provider: ${llmConfig.provider}${llmConfig.provider === "ollama" ? ` (${llmConfig.ollamaUrl}, model=${llmConfig.ollamaModel})` : ""}`,
  );
  console.log(`Meeting notes: ${notesEnabled ? `enabled (${notesModel})` : "disabled"}`);
  console.log(`Meeting Q&A: ${askEnabled ? `enabled (${askModel})` : "disabled"}`);
  console.log("Per-user storage: storage/users/<chrome-profile-uuid>/");
});
