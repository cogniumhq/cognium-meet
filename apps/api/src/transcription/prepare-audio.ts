import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

export async function prepareAudioForWhisper(inputPath: string): Promise<string> {
  const wavPath = inputPath.replace(/\.webm$/i, ".wav");

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
      "-c:a",
      "pcm_s16le",
      wavPath,
    ]);
    await access(wavPath);
    return wavPath;
  } catch {
    return inputPath;
  }
}

export function whisperFilename(audioPath: string): string {
  return audioPath.endsWith(".wav") ? "recording.wav" : "recording.webm";
}

export function whisperMimeType(audioPath: string): string {
  return audioPath.endsWith(".wav") ? "audio/wav" : "audio/webm";
}

export function tempTranscodedPath(recordingsDir: string, id: string): string {
  return join(recordingsDir, `${id}.wav`);
}
