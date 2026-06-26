import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { v4 as uuidv4 } from "uuid";
import type { RecordingMeta } from "@cognium/meet-shared";
import type { TranscriptionProvider } from "./transcription/provider.js";
import { RecordingStore } from "./storage/recording-store.js";
import { isLikelyAudio } from "./transcription/prepare-audio.js";
import {
  enqueueTranscription,
  isProcessingStale,
  markRecordingFailed,
  processRecording,
  cancelTranscription,
  type ProcessingDeps,
} from "./transcription/process-recording.js";
import { requestLog } from "./middleware/request-log.js";

interface AppDeps extends ProcessingDeps {
  transcription: TranscriptionProvider;
  apiToken?: string;
  maxUploadBytes?: number;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: (origin) => origin ?? "*",
      allowHeaders: ["Authorization", "Content-Type"],
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
      const contentType = c.req.header("content-type") ?? "";
    let buffer: Buffer;
    let meetingTitle: string | undefined;
    let startedAt: string;
    let durationMs: number | undefined;

    if (contentType.includes("multipart/form-data")) {
      const form = await c.req.parseBody();
      const audio = form.audio;

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

      buffer = Buffer.from(await audio.arrayBuffer());
    } else {
      let body: {
        audioBase64?: string;
        meetingTitle?: string;
        startedAt?: string;
        durationMs?: number;
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
    await deps.store.saveAudio(id, buffer);

    const meta: RecordingMeta = {
      id,
      meetingTitle,
      startedAt,
      durationMs: Number.isFinite(durationMs) ? durationMs : undefined,
      status: "processing",
      processingStartedAt: new Date().toISOString(),
    };
    await deps.store.saveMeta(meta);

    enqueueTranscription(deps, id);

    console.log(
      `[api] recording created id=${id} bytes=${buffer.length} title=${meetingTitle ?? "(none)"}`,
    );

    return c.json({ id, status: meta.status }, 202);
    },
  );

  app.post("/v1/recordings/:id/retry", async (c) => {
    const id = c.req.param("id");
    const meta = await deps.store.getMeta(id);
    if (!meta) {
      return c.json({ error: "Not found" }, 404);
    }

    if (meta.status === "completed") {
      return c.json({ id, status: meta.status });
    }

    if (!(await deps.store.audioExists(id))) {
      return c.json(
        {
          error: "Audio no longer available",
          detail: "The original recording was deleted after a previous attempt",
        },
        410,
      );
    }

    await deps.store.saveMeta({
      ...meta,
      status: "processing",
      error: undefined,
      processingStartedAt: new Date().toISOString(),
    });

    enqueueTranscription(deps, id);
    console.log(`[api] transcription retry id=${id}`);
    return c.json({ id, status: "processing" }, 202);
  });

  app.get("/v1/recordings/:id", async (c) => {
    const id = c.req.param("id");
    const meta = await deps.store.getMeta(id);
    if (!meta) {
      return c.json({ error: "Not found" }, 404);
    }

    if (isProcessingStale(meta)) {
      if (await deps.store.audioExists(id)) {
        enqueueTranscription(deps, id);
        return c.json({
          ...meta,
          status: "processing",
          error: undefined,
        });
      }

      const failed: RecordingMeta = {
        ...meta,
        status: "failed",
        error: "Transcription timed out — audio is no longer available",
        processingStartedAt: undefined,
      };
      await deps.store.saveMeta(failed);
      return c.json(failed);
    }

    return c.json(meta);
  });

  app.get("/v1/recordings/:id/transcript.txt", async (c) => {
    const id = c.req.param("id");
    const meta = await deps.store.getMeta(id);
    if (!meta) {
      return c.json({ error: "Not found" }, 404);
    }
    if (meta.status !== "completed") {
      return c.json({ error: "Transcript not ready", status: meta.status }, 409);
    }
    const txt = await deps.store.readTranscriptTxt(id);
    if (!txt) {
      return c.json({ error: "Transcript missing" }, 404);
    }
    return c.text(txt, 200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${id}.txt"`,
    });
  });

  app.get("/v1/recordings/:id/transcript.json", async (c) => {
    const id = c.req.param("id");
    const meta = await deps.store.getMeta(id);
    if (!meta) {
      return c.json({ error: "Not found" }, 404);
    }
    if (meta.status !== "completed") {
      return c.json({ error: "Transcript not ready", status: meta.status }, 409);
    }
    const json = await deps.store.readTranscriptJson(id);
    if (!json) {
      return c.json({ error: "Transcript missing" }, 404);
    }
    return c.json(json);
  });

  app.delete("/v1/recordings/:id", async (c) => {
    const id = c.req.param("id");
    const meta = await deps.store.getMeta(id);
    if (!meta) {
      return c.json({ error: "Not found" }, 404);
    }

    cancelTranscription(id);
    await deps.store.deleteRecording(id);
    console.log(
      `[api] recording deleted id=${id} title=${meta.meetingTitle ?? "(none)"} status=${meta.status}`,
    );
    return c.body(null, 204);
  });

  return app;
}
