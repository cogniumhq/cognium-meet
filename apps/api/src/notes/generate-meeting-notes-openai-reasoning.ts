import OpenAI from "openai";
import type { MeetingNotes, TranscriptResult } from "@cognium/meet-shared";
import { segmentsToPlainText } from "@cognium/meet-shared";

const MAX_TRANSCRIPT_CHARS = 90_000;

const MEETING_NOTES_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    actionItems: { type: "array", items: { type: "string" } },
    decisions: { type: "array", items: { type: "string" } },
    openQuestions: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "actionItems", "decisions", "openQuestions"],
  additionalProperties: false,
} as const;

export async function generateMeetingNotesWithOpenAiReasoning(opts: {
  apiKey: string;
  model: string;
  recordingId: string;
  meetingTitle?: string;
  transcript: TranscriptResult;
}): Promise<MeetingNotes> {
  const client = new OpenAI({ apiKey: opts.apiKey });

  let text = segmentsToPlainText(opts.transcript.segments);
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    text =
      `[Transcript truncated to the last ${MAX_TRANSCRIPT_CHARS} characters]\n\n` +
      text.slice(-MAX_TRANSCRIPT_CHARS);
  }

  const title = opts.meetingTitle?.trim() || "Meeting";
  const response = await client.responses.create({
    model: opts.model,
    reasoning: { effort: "low" },
    max_output_tokens: 8192,
    instructions: [
      "Extract structured meeting notes from the transcript.",
      "Action items must be specific, actionable, and start with a verb.",
      "Preserve exact numbers, ticket IDs, names, and deadlines mentioned in the transcript.",
      "Decisions are firm conclusions reached in the meeting.",
      "Open questions are unresolved topics that still need an answer.",
      "Do not invent owners, dates, or metrics that are not supported by the transcript.",
    ].join(" "),
    input: `Meeting title: ${title}\n\nTranscript:\n${text}`,
    text: {
      format: {
        type: "json_schema",
        name: "meeting_notes",
        strict: true,
        schema: MEETING_NOTES_SCHEMA,
      },
    },
  });

  const raw = response.output_text?.trim();
  if (!raw) {
    throw new Error("OpenAI returned empty meeting notes");
  }

  let parsed: {
    summary?: string;
    actionItems?: unknown;
    decisions?: unknown;
    openQuestions?: unknown;
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new Error("OpenAI returned invalid JSON for meeting notes");
  }

  return {
    recordingId: opts.recordingId,
    meetingTitle: opts.meetingTitle,
    generatedAt: new Date().toISOString(),
    llmModel: opts.model,
    summary: parsed.summary?.trim() || "No summary generated.",
    actionItems: normalizeList(parsed.actionItems),
    decisions: normalizeList(parsed.decisions),
    openQuestions: normalizeList(parsed.openQuestions),
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
