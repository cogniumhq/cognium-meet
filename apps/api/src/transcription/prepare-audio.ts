import { execFile } from "node:child_process";
import { access, readdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** OpenAI audio file upload limit */
export const WHISPER_MAX_BYTES = 24 * 1024 * 1024;

/** OpenAI gpt-4o-transcribe-diarize max input duration (seconds). */
export const DIARIZE_MAX_SECONDS = 1400;
/** Split longer recordings below the API limit (20 min segments). */
export const DIARIZE_SEGMENT_SECONDS = 20 * 60;
export const DIARIZE_TIMEOUT_MIN_MS = 30 * 60 * 1000;
export const DIARIZE_TIMEOUT_MAX_MS = 90 * 60 * 1000;

export async function getAudioDurationSeconds(inputPath: string): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      inputPath,
    ]);
    const seconds = Number.parseFloat(stdout.trim());
    return Number.isFinite(seconds) ? seconds : undefined;
  } catch {
    return undefined;
  }
}

export function diarizeTimeoutMs(durationSeconds?: number): number {
  // ~4× realtime, clamped — 15 min audio → 60 min timeout.
  const estimated = (durationSeconds ?? 15 * 60) * 4 * 1000;
  return Math.min(
    DIARIZE_TIMEOUT_MAX_MS,
    Math.max(DIARIZE_TIMEOUT_MIN_MS, estimated),
  );
}

export function isLikelyAudio(buffer: Buffer): boolean {
  if (buffer.length < 16) {
    return false;
  }

  // Reject accidental "[object Object]" uploads
  if (
    buffer[0] === 0x5b &&
    buffer[1] === 0x6f &&
    buffer[2] === 0x62 &&
    buffer[3] === 0x6a
  ) {
    return false;
  }

  if (
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  ) {
    return true;
  }

  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46
  ) {
    return true;
  }

  if (
    buffer[0] === 0x4f &&
    buffer[1] === 0x67 &&
    buffer[2] === 0x67 &&
    buffer[3] === 0x53
  ) {
    return true;
  }

  return false;
}

function mp3PathFor(inputPath: string): string {
  return inputPath.replace(/\.[^.]+$/i, ".mp3");
}

export async function prepareAudioForWhisper(inputPath: string): Promise<string> {
  return prepareAudioMp3(inputPath, "48k");
}

async function prepareAudioMp3(inputPath: string, bitrate: string): Promise<string> {
  const suffix = bitrate.replace(/k$/i, "k");
  const mp3Path = inputPath.replace(/\.[^.]+$/i, `.${suffix}.mp3`);

  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inputPath,
      "-ar",
      "16000",
      "-ac",
      "1",
      "-b:a",
      bitrate,
      mp3Path,
    ]);
    await access(mp3Path);
    return mp3Path;
  } catch {
    return inputPath;
  }
}

/**
 * Single MP3 for diarize. Re-encodes at lower bitrates if over the upload limit.
 * Long recordings are split into ≤20 min parts in splitAudioForDiarize().
 */
export async function prepareAudioForDiarize(
  inputPath: string,
): Promise<{ path: string; cleanup: string[] }> {
  const cleanup: string[] = [];
  const bitrates = ["48k", "32k", "24k"] as const;

  for (const bitrate of bitrates) {
    const prepared = await prepareAudioMp3(inputPath, bitrate);
    if (prepared === inputPath) {
      throw new Error(
        "ffmpeg failed to compress audio — ensure ffmpeg and ffprobe are installed",
      );
    }
    cleanup.push(prepared);

    let size = 0;
    try {
      size = (await stat(prepared)).size;
    } catch {
      continue;
    }

    if (size <= WHISPER_MAX_BYTES) {
      return { path: prepared, cleanup };
    }

    console.log(
      `[transcription] diarize prep ${bitrate} → ${(size / 1024 / 1024).toFixed(1)} MB, retrying lower bitrate`,
    );
  }

  throw new Error(
    "Audio file too large for diarization after compression — try a shorter recording",
  );
}

/** Split prepared MP3 into ≤20 min parts when over the diarize model limit (1400s). */
export async function splitAudioForDiarize(
  preparedPath: string,
): Promise<{ paths: string[]; cleanup: string[] }> {
  const duration = await getAudioDurationSeconds(preparedPath);
  if (!duration || duration <= DIARIZE_SEGMENT_SECONDS) {
    return { paths: [preparedPath], cleanup: [] };
  }

  const dir = dirname(preparedPath);
  const stem = basename(preparedPath).replace(/\.[^.]+$/i, "");
  const segmentPattern = join(dir, `${stem}_dz_%03d.mp3`);

  await execFileAsync("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    preparedPath,
    "-f",
    "segment",
    "-segment_time",
    String(DIARIZE_SEGMENT_SECONDS),
    "-reset_timestamps",
    "1",
    "-c",
    "copy",
    segmentPattern,
  ]);

  const prefix = `${stem}_dz_`;
  const files = (await readdir(dir))
    .filter((name) => name.startsWith(prefix) && name.endsWith(".mp3"))
    .sort()
    .map((name) => join(dir, name));

  if (files.length === 0) {
    return { paths: [preparedPath], cleanup: [] };
  }

  for (const file of files) {
    const partDuration = await getAudioDurationSeconds(file);
    if (partDuration && partDuration > DIARIZE_MAX_SECONDS) {
      throw new Error(
        `Diarize segment too long (${Math.round(partDuration)}s) — ffmpeg split failed`,
      );
    }
  }

  console.log(
    `[transcription] diarize: split ${Math.round(duration)}s audio into ${files.length} parts`,
  );

  return { paths: files, cleanup: files };
}

export async function prepareAudioChunksForWhisper(
  inputPath: string,
): Promise<{ paths: string[]; cleanup: string[] }> {
  const prepared = await prepareAudioForWhisper(inputPath);
  const cleanup: string[] = prepared !== inputPath ? [prepared] : [];

  let size = 0;
  try {
    size = (await stat(prepared)).size;
  } catch {
    return { paths: [inputPath], cleanup: [] };
  }

  if (size <= WHISPER_MAX_BYTES) {
    return { paths: [prepared], cleanup };
  }

  const dir = dirname(prepared);
  const stem = basename(prepared).replace(/\.[^.]+$/i, "");
  const segmentPattern = join(dir, `${stem}_part_%03d.mp3`);

  await execFileAsync("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    prepared,
    "-f",
    "segment",
    "-segment_time",
    "600",
    "-c",
    "copy",
    segmentPattern,
  ]);

  const prefix = `${stem}_part_`;
  const files = (await readdir(dir))
    .filter((name) => name.startsWith(prefix) && name.endsWith(".mp3"))
    .sort()
    .map((name) => join(dir, name));

  if (files.length === 0) {
    return { paths: [prepared], cleanup };
  }

  cleanup.push(...files);
  return { paths: files, cleanup };
}

export async function cleanupPreparedAudio(paths: string[]): Promise<void> {
  for (const path of paths) {
    await unlink(path).catch(() => {});
  }
}

export function whisperFilename(audioPath: string): string {
  if (audioPath.endsWith(".mp3")) {
    return "recording.mp3";
  }
  if (audioPath.endsWith(".wav")) {
    return "recording.wav";
  }
  return "recording.webm";
}

export function whisperMimeType(audioPath: string): string {
  if (audioPath.endsWith(".mp3")) {
    return "audio/mpeg";
  }
  if (audioPath.endsWith(".wav")) {
    return "audio/wav";
  }
  return "audio/webm";
}

export function tempTranscodedPath(recordingsDir: string, id: string): string {
  return join(recordingsDir, `${id}.mp3`);
}
