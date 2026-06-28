import type { TranscriptResult, TranscriptionProgress } from "@cognium/meet-shared";

export interface TranscriptionOptions {
  language?: string;
  meetingTitle?: string;
  onProgress?: (progress: TranscriptionProgress) => void | Promise<void>;
}

export interface TranscriptionProvider {
  transcribe(audioPath: string, opts?: TranscriptionOptions): Promise<TranscriptResult>;
}
