import type { MeetingLlmProvider, TranscriptResult } from "@cognium/meet-shared";
import { openAiMeetingModelUsesResponsesApi } from "@cognium/meet-shared";
import type { MeetingLlmConfig } from "../llm/create-meeting-llm.js";
import { createMeetingLlm, resolveMeetingLlmModel } from "../llm/create-meeting-llm.js";
import { createAxMeetingNotesExtractors } from "./meeting-notes-ax.js";
import { generateMeetingNotesWithMapReduce } from "./meeting-notes-mapreduce.js";
import { generateMeetingNotesWithOpenAiReasoning } from "./generate-meeting-notes-openai-reasoning.js";

export async function generateMeetingNotes(opts: {
  llmConfig: MeetingLlmConfig;
  llmProvider?: MeetingLlmProvider;
  model: string;
  recordingId: string;
  meetingTitle?: string;
  transcript: TranscriptResult;
}) {
  const model = resolveMeetingLlmModel(opts.llmConfig, opts.model, opts.llmProvider);
  const provider = opts.llmProvider ?? opts.llmConfig.provider;

  if (provider === "openai" && openAiMeetingModelUsesResponsesApi(model)) {
    if (!opts.llmConfig.openaiApiKey.trim()) {
      throw new Error("OpenAI API key is missing");
    }
    return generateMeetingNotesWithOpenAiReasoning({
      apiKey: opts.llmConfig.openaiApiKey,
      model,
      recordingId: opts.recordingId,
      meetingTitle: opts.meetingTitle,
      transcript: opts.transcript,
    });
  }

  const llm = createMeetingLlm(opts.llmConfig, opts.llmProvider, opts.model);
  const { extract, reduce } = createAxMeetingNotesExtractors(llm, model);

  return generateMeetingNotesWithMapReduce({
    recordingId: opts.recordingId,
    meetingTitle: opts.meetingTitle,
    llmModel: model,
    segments: opts.transcript.segments,
    extract,
    reduce,
    log: (message) => {
      console.log(`[notes] ${opts.recordingId} ${message}`);
    },
  });
}
