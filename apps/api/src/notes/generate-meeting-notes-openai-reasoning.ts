import OpenAI from "openai";
import type { TranscriptResult } from "@cognium/meet-shared";
import { createReasoningMeetingNotesExtractors } from "./meeting-notes-reasoning.js";
import { generateMeetingNotesWithMapReduce } from "./meeting-notes-mapreduce.js";

export async function generateMeetingNotesWithOpenAiReasoning(opts: {
  apiKey: string;
  model: string;
  recordingId: string;
  meetingTitle?: string;
  transcript: TranscriptResult;
}) {
  const client = new OpenAI({ apiKey: opts.apiKey });
  const { extract, reduce } = createReasoningMeetingNotesExtractors(client, opts.model);

  return generateMeetingNotesWithMapReduce({
    recordingId: opts.recordingId,
    meetingTitle: opts.meetingTitle,
    llmModel: opts.model,
    segments: opts.transcript.segments,
    extract,
    reduce,
    log: (message) => {
      console.log(`[notes] ${opts.recordingId} ${message}`);
    },
  });
}
