import type { TranscriptResult } from "@cognium/meet-shared";

export interface TranscriptionProvider {
  transcribe(
    audioPath: string,
    opts?: { language?: string; meetingTitle?: string },
  ): Promise<TranscriptResult>;
}
