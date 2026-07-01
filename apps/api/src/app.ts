import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { v4 as uuidv4 } from "uuid";
import { COGNIUM_USER_ID_HEADER, type RecordingMeta } from "@cognium/meet-shared";
import { parseAudioCaptureMode, parseTranscriptionModel } from "@cognium/meet-shared";
import type { RecordingStore } from "./storage/recording-store.js";
import type { SearchIndex } from "./storage/search-index.js";
import { isLikelyAudio } from "./transcription/prepare-audio.js";
import {
  enqueueTranscription,
  isProcessingStale,
  cancelTranscription,
  isTranscriptionActive,
  type ProcessingDeps,
} from "./transcription/process-recording.js";
import { enqueueMeetingNotes } from "./notes/process-notes.js";
import { requestLog } from "./middleware/request-log.js";
import { answerMeetingQuestion } from "./ask/answer-meeting-question.js";
import {
  buildAskContextForMessages,
  parseAskMessages,
} from "./ask/parse-ask-request.js";
import { parseUserIdHeader } from "./storage/user-id.js";
import type { UserStoreRegistry } from "./storage/user-store-registry.js";

type AppVariables = {
  userId: string;
  store: RecordingStore;
  searchIndex: SearchIndex;
};

interface AppDeps extends ProcessingDeps {
  userRegistry: UserStoreRegistry;
  apiToken?: string;
  maxUploadBytes?: number;
  defaultCaptureMode?: import("@cognium/meet-shared").AudioCaptureMode;
  askEnabled: boolean;
  askModel: string;
}

export function createApp(deps: AppDeps) {
  const app = new Hono<{ Variables: AppVariables }>();

  app.use(
    "*",
    cors({
      origin: (origin) => origin ?? "*",
      allowHeaders: ["Authorization", "Content-Type", COGNIUM_USER_ID_HEADER],
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    }),
  );

  app.use("*", requestLog());

  app.use("*", async (c, next) => {
    if (c.req.path === "/health") {
      await next();
      return;
    }
    if (!deps.apiToken) {
      await next();
      return;
    }
    const auth = c.req.header("Authorization");
    if (auth !== `Bearer ${deps.apiToken}`) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.use("/v1/*", async (c, next) => {
    const parsed = parseUserIdHeader(c.req.header(COGNIUM_USER_ID_HEADER));
    if (!parsed.ok) {
      return c.json({ error: "Missing or invalid X-Cognium-User-Id" }, 400);
    }
    const userStores = await deps.userRegistry.forUser(parsed.userId);
    c.set("userId", parsed.userId);
    c.set("store", userStores.store);
    c.set("searchIndex", userStores.searchIndex);
    await next();
  });

  app.post("/v1/ask", async (c) => {
    if (!deps.askEnabled) {
      return c.json({ error: "Meeting Q&A is disabled on this server" }, 503);
    }

    const store = c.get("store");
    const searchIndex = c.get("searchIndex");

    let body: { question?: string; recordingId?: string; messages?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid request body" }, 400);
    }

    const messages = parseAskMessages(body);
    if (!messages) {
      return c.json({ error: "Missing question or messages" }, 400);
    }

    const recordingId =
      typeof body.recordingId === "string" && body.recordingId.trim()
        ? body.recordingId.trim()
        : undefined;

    if (recordingId) {
      const meta = await store.getMeta(recordingId);
      if (!meta) {
        return c.json({ error: "Recording not found" }, 404);
      }
      if (meta.status !== "completed") {
        return c.json(
          { error: "Transcript not ready", status: meta.status },
          409,
        );
      }
    }

    const { context, citations, meetingCount } = await buildAskContextForMessages({
      store,
      searchIndex,
      messages,
      recordingId,
    });

    const result = await answerMeetingQuestion({
      apiKey: deps.openaiApiKey,
      model: deps.askModel,
      messages,
      context,
      citations,
    });

    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    console.log(
      `[ask] turns=${messages.length} question=${JSON.stringify((lastUser?.content ?? "").slice(0, 80))} meetings=${meetingCount} insufficient=${result.insufficientContext}`,
    );

    return c.json({
      answer: result.answer,
      insufficientContext: result.insufficientContext,
      citations: result.citations,
      meetingCount,
    });
  });

  const maxUploadBytes = deps.maxUploadBytes ?? 150 * 1024 * 1024;

  app.post(
    "/v1/recordings",
    bodyLimit({
      maxSize: maxUploadBytes,
      onError: (c) =>
        c.json(
          {
            error: "Payload too large",
            detail: `Maximum upload size is ${maxUploadBytes} bytes`,
          },
          413,
        ),
    }),
    async (c) => {
      const store = c.get("store");
      const userId = c.get("userId");
      const contentType = c.req.header("content-type") ?? "";
      let buffer: Buffer;
      let micBuffer: Buffer | undefined;
      let meetingTitle: string | undefined;
      let startedAt: string;
      let durationMs: number | undefined;
      let transcriptionModel = deps.defaultTranscriptionModel;
      let captureMode = deps.defaultCaptureMode ?? "mixed";

      if (contentType.includes("multipart/form-data")) {
        const form = await c.req.parseBody();
        const audio = form.audio;
        const micAudio = form.micAudio;

        if (!(audio instanceof File)) {
          return c.json({ error: "Missing audio file" }, 400);
        }

        meetingTitle =
          typeof form.meetingTitle === "string" ? form.meetingTitle : undefined;
        startedAt =
          typeof form.startedAt === "string"
            ? form.startedAt
            : new Date().toISOString();
        durationMs =
          typeof form.durationMs === "string"
            ? Number.parseInt(form.durationMs, 10)
            : undefined;
        transcriptionModel = parseTranscriptionModel(
          form.transcriptionModel,
          deps.defaultTranscriptionModel,
        );
        captureMode = parseAudioCaptureMode(
          form.captureMode,
          deps.defaultCaptureMode ?? "mixed",
        );

        buffer = Buffer.from(await audio.arrayBuffer());

        if (micAudio instanceof File && micAudio.size > 0) {
          const candidate = Buffer.from(await micAudio.arrayBuffer());
          if (isLikelyAudio(candidate)) {
            micBuffer = candidate;
          }
        }
      } else {
        let body: {
          audioBase64?: string;
          meetingTitle?: string;
          startedAt?: string;
          durationMs?: number;
          transcriptionModel?: string;
          captureMode?: string;
        };
        try {
          body = await c.req.json();
        } catch {
          return c.json(
            { error: "Invalid request body", detail: "Expected JSON with audioBase64" },
            400,
          );
        }

        if (!body.audioBase64) {
          return c.json({ error: "Missing audioBase64" }, 400);
        }

        buffer = Buffer.from(body.audioBase64, "base64");
        meetingTitle = body.meetingTitle;
        startedAt = body.startedAt ?? new Date().toISOString();
        durationMs = body.durationMs;
        transcriptionModel = parseTranscriptionModel(
          body.transcriptionModel,
          deps.defaultTranscriptionModel,
        );
        captureMode = parseAudioCaptureMode(
          body.captureMode,
          deps.defaultCaptureMode ?? "mixed",
        );
      }

      if (!isLikelyAudio(buffer)) {
        return c.json(
          {
            error: "Invalid audio file",
            detail: `Expected WebM/WAV/Ogg audio, got ${buffer.length} bytes`,
          },
          400,
        );
      }

      const id = uuidv4();
      await store.saveAudio(id, buffer);
      if (micBuffer) {
        await store.saveMicAudio(id, micBuffer);
      }

      const meta: RecordingMeta = {
        id,
        meetingTitle,
        startedAt,
        durationMs: Number.isFinite(durationMs) ? durationMs : undefined,
        status: "processing",
        transcriptionModel,
        captureMode,
        processingStartedAt: new Date().toISOString(),
      };
      await store.saveMeta(meta);

      enqueueTranscription(deps, userId, id);

      console.log(
        `[api] recording created user=${userId} id=${id} bytes=${buffer.length} mic=${micBuffer?.length ?? 0} capture=${captureMode} model=${transcriptionModel} title=${meetingTitle ?? "(none)"}`,
      );

      return c.json({ id, status: meta.status }, 202);
    },
  );

  app.post("/v1/recordings/:id/retry", async (c) => {
    const store = c.get("store");
    const userId = c.get("userId");
    const id = c.req.param("id");
    const meta = await store.getMeta(id);
    if (!meta) {
      return c.json({ error: "Not found" }, 404);
    }

    if (meta.status === "completed") {
      return c.json({ id, status: meta.status });
    }

    if (!(await store.audioExists(id))) {
      return c.json(
        {
          error: "Audio no longer available",
          detail: "The original recording was deleted after a previous attempt",
        },
        410,
      );
    }

    let retryModel = meta.transcriptionModel ?? deps.defaultTranscriptionModel;
    try {
      const body = await c.req.json<{ transcriptionModel?: string }>();
      if (body.transcriptionModel) {
        retryModel = parseTranscriptionModel(
          body.transcriptionModel,
          deps.defaultTranscriptionModel,
        );
      }
    } catch {
      // empty body is fine — use stored model
    }

    await store.saveMeta({
      ...meta,
      status: "processing",
      error: undefined,
      transcriptionModel: retryModel,
      processingStartedAt: new Date().toISOString(),
      notesStatus: deps.notesEnabled ? "pending" : "skipped",
      notesError: undefined,
    });

    enqueueTranscription(deps, userId, id);
    console.log(`[api] transcription retry user=${userId} id=${id} model=${retryModel}`);
    return c.json({ id, status: "processing" }, 202);
  });

  app.get("/v1/recordings/:id", async (c) => {
    const store = c.get("store");
    const userId = c.get("userId");
    const id = c.req.param("id");
    const meta = await store.getMeta(id);
    if (!meta) {
      return c.json({ error: "Not found" }, 404);
    }

    if (isProcessingStale(meta)) {
      if (await store.audioExists(id)) {
        if (isTranscriptionActive(userId, id)) {
          return c.json(meta);
        }
        enqueueTranscription(deps, userId, id);
        return c.json({
          ...meta,
          status: "processing",
          error: undefined,
          progress: meta.progress ?? {
            phase: "preparing",
            label: "Resuming transcription…",
          },
        });
      }

      const failed: RecordingMeta = {
        ...meta,
        status: "failed",
        error: "Transcription timed out — audio is no longer available",
        processingStartedAt: undefined,
      };
      await store.saveMeta(failed);
      return c.json(failed);
    }

    return c.json(meta);
  });

  app.get("/v1/recordings/:id/transcript.txt", async (c) => {
    const store = c.get("store");
    const id = c.req.param("id");
    const meta = await store.getMeta(id);
    if (!meta) {
      return c.json({ error: "Not found" }, 404);
    }
    if (meta.status !== "completed") {
      return c.json({ error: "Transcript not ready", status: meta.status }, 409);
    }
    const txt = await store.readTranscriptTxt(id);
    if (!txt) {
      return c.json({ error: "Transcript missing" }, 404);
    }
    return c.text(txt, 200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${id}.txt"`,
    });
  });

  app.get("/v1/recordings/:id/transcript.json", async (c) => {
    const store = c.get("store");
    const id = c.req.param("id");
    const meta = await store.getMeta(id);
    if (!meta) {
      return c.json({ error: "Not found" }, 404);
    }
    if (meta.status !== "completed") {
      return c.json({ error: "Transcript not ready", status: meta.status }, 409);
    }
    const json = await store.readTranscriptJson(id);
    if (!json) {
      return c.json({ error: "Transcript missing" }, 404);
    }
    return c.json(json);
  });

  app.get("/v1/recordings/:id/notes.json", async (c) => {
    const store = c.get("store");
    const id = c.req.param("id");
    const meta = await store.getMeta(id);
    if (!meta) {
      return c.json({ error: "Not found" }, 404);
    }
    if (meta.notesStatus !== "completed") {
      return c.json(
        { error: "Meeting notes not ready", notesStatus: meta.notesStatus ?? "pending" },
        409,
      );
    }
    const notes = await store.readMeetingNotes(id);
    if (!notes) {
      return c.json({ error: "Meeting notes missing" }, 404);
    }
    return c.json(notes);
  });

  app.get("/v1/recordings/:id/notes.md", async (c) => {
    const store = c.get("store");
    const id = c.req.param("id");
    const meta = await store.getMeta(id);
    if (!meta) {
      return c.json({ error: "Not found" }, 404);
    }
    if (meta.notesStatus !== "completed") {
      return c.json(
        { error: "Meeting notes not ready", notesStatus: meta.notesStatus ?? "pending" },
        409,
      );
    }
    const md = await store.readMeetingNotesMd(id);
    if (!md) {
      return c.json({ error: "Meeting notes missing" }, 404);
    }
    return c.text(md, 200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${id}-notes.md"`,
    });
  });

  app.post("/v1/recordings/:id/notes", async (c) => {
    const store = c.get("store");
    const userId = c.get("userId");
    const id = c.req.param("id");
    const meta = await store.getMeta(id);
    if (!meta) {
      return c.json({ error: "Not found" }, 404);
    }
    if (meta.status !== "completed") {
      return c.json({ error: "Transcript not ready", status: meta.status }, 409);
    }
    if (!deps.notesEnabled) {
      return c.json({ error: "Meeting notes are disabled on this server" }, 503);
    }
    await store.saveMeta({
      ...meta,
      notesStatus: "pending",
      notesError: undefined,
    });
    enqueueMeetingNotes(deps, userId, id);
    return c.json({ id, notesStatus: "pending" }, 202);
  });

  app.delete("/v1/recordings/:id", async (c) => {
    const store = c.get("store");
    const searchIndex = c.get("searchIndex");
    const userId = c.get("userId");
    const id = c.req.param("id");
    const meta = await store.getMeta(id);
    if (!meta) {
      return c.json({ error: "Not found" }, 404);
    }

    cancelTranscription(userId, id);
    searchIndex.removeRecording(id);
    await store.deleteRecording(id);
    console.log(
      `[api] recording deleted user=${userId} id=${id} title=${meta.meetingTitle ?? "(none)"} status=${meta.status}`,
    );
    return c.body(null, 204);
  });

  return app;
}
