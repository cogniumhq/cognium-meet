import { execFile } from "node:child_process";
import { access, readdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** OpenAI Whisper file upload limit */
export const WHISPER_MAX_BYTES = 24 * 1024 * 1024;

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
  const mp3Path = mp3PathFor(inputPath);

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
      "48k",
      mp3Path,
    ]);
    await access(mp3Path);
    return mp3Path;
  } catch {
    return inputPath;
  }
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
