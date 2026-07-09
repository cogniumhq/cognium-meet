import { ax } from "@ax-llm/ax";
import type {
  MeetingLlmProvider,
  MeetingNotes,
  TranscriptResult,
} from "@cognium/meet-shared";
import { segmentsToPlainText, openAiMeetingModelUsesResponsesApi } from "@cognium/meet-shared";
import type { MeetingLlmConfig } from "../llm/create-meeting-llm.js";
import { createMeetingLlm, resolveMeetingLlmModel } from "../llm/create-meeting-llm.js";
import { generateMeetingNotesWithOpenAiReasoning } from "./generate-meeting-notes-openai-reasoning.js";

const MAX_TRANSCRIPT_CHARS = 90_000;

const meetingNotesGen = ax(
  `meetingTitle:string, transcript:string -> summary:string, actionItems:string[], decisions:string[], openQuestions:string[]`,
  {
    description:
      "Extract structured meeting notes from a transcript. Action items should be specific and start with a verb. Decisions are firm conclusions reached. Open questions are unresolved topics.",
  },
);

export async function generateMeetingNotes(opts: {
  llmConfig: MeetingLlmConfig;
  llmProvider?: MeetingLlmProvider;
  model: string;
  recordingId: string;
  meetingTitle?: string;
  transcript: TranscriptResult;
}): Promise<MeetingNotes> {
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

  let text = segmentsToPlainText(opts.transcript.segments);
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    text =
      `[Transcript truncated to the last ${MAX_TRANSCRIPT_CHARS} characters]\n\n` +
      text.slice(-MAX_TRANSCRIPT_CHARS);
  }

  const result = await meetingNotesGen.forward(
    llm,
    {
      meetingTitle: opts.meetingTitle?.trim() || "Meeting",
      transcript: text,
    },
    {
      model,
    },
  );

  return {
    recordingId: opts.recordingId,
    meetingTitle: opts.meetingTitle,
    generatedAt: new Date().toISOString(),
    llmModel: model,
    summary: result.summary?.trim() || "No summary generated.",
    actionItems: normalizeList(result.actionItems),
    decisions: normalizeList(result.decisions),
    openQuestions: normalizeList(result.openQuestions),
  };
}

function normalizeList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}
