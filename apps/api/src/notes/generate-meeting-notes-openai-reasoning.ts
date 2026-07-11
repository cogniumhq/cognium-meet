import OpenAI from "openai";
import type { TranscriptResult } from "@cognium/meet-shared";
import { segmentsToPlainText } from "@cognium/meet-shared";
import { MEETING_NOTES_EXTRACTION_RULES } from "./meeting-notes-prompt.js";
import {
  buildMeetingNotes,
  MEETING_NOTES_SCHEMA,
  type RawMeetingNotesPayload,
} from "./normalize-meeting-notes.js";

const MAX_TRANSCRIPT_CHARS = 90_000;

export async function generateMeetingNotesWithOpenAiReasoning(opts: {
  apiKey: string;
  model: string;
  recordingId: string;
  meetingTitle?: string;
  transcript: TranscriptResult;
}) {
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
    instructions: MEETING_NOTES_EXTRACTION_RULES,
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

  let parsed: RawMeetingNotesPayload;
  try {
    parsed = JSON.parse(raw) as RawMeetingNotesPayload;
  } catch {
    throw new Error("OpenAI returned invalid JSON for meeting notes");
  }

  return buildMeetingNotes({
    recordingId: opts.recordingId,
    meetingTitle: opts.meetingTitle,
    llmModel: opts.model,
    parsed,
  });
}
