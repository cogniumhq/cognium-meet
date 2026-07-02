import "dotenv/config";
import { serve } from "@hono/node-server";
import { join } from "node:path";
import { DEFAULT_TRANSCRIPTION_MODEL } from "@cognium/meet-shared";
import { createApp } from "./app.js";
import { resumePendingRecordings } from "./transcription/process-recording.js";
import { resumePendingMeetingNotes } from "./notes/process-notes.js";
import { createTranscriptionProviderFactory } from "./transcription/create-provider.js";
import { UserStoreRegistry } from "./storage/user-store-registry.js";

const port = Number.parseInt(process.env.PORT ?? "3847", 10);
const storageDir = process.env.STORAGE_DIR ?? join(process.cwd(), "../../storage");
const apiToken = process.env.API_TOKEN;
const openaiKey = process.env.OPENAI_API_KEY?.trim() || undefined;

if (!openaiKey) {
  console.warn(
    "OPENAI_API_KEY is not set — transcription and OpenAI notes/Ask require clients to send X-OpenAI-Key.",
  );
}

const userRegistry = new UserStoreRegistry(storageDir);
const getTranscriptionProvider = createTranscriptionProviderFactory(openaiKey);

const deps = {
  userRegistry,
  getTranscriptionProvider,
  defaultTranscriptionModel: DEFAULT_TRANSCRIPTION_MODEL,
  openaiApiKey: openaiKey,
  apiToken,
};

const app = createApp(deps);

serve({ fetch: app.fetch, port }, () => {
  console.log(`cognium-meet API listening on http://localhost:${port}`);
  console.log(`Default transcription model: ${DEFAULT_TRANSCRIPTION_MODEL}`);
  console.log(
    `OpenAI key: ${openaiKey ? "server fallback configured" : "extension BYOK only"}`,
  );
  console.log("Meeting AI, upload limits, and storage options come from extension Settings.");
  console.log("Per-user storage: storage/users/<chrome-profile-uuid>/");
});

void (async () => {
  const warmed = await userRegistry.warmAll();
  if (warmed.users > 0) {
    console.log(
      `[search] indexed ${warmed.recordings} completed recording(s) across ${warmed.users} user(s)`,
    );
  }
  await resumePendingRecordings(deps);
  await resumePendingMeetingNotes(deps);
})();
