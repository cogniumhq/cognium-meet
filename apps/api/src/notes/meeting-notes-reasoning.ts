import OpenAI from "openai";
import {
  MEETING_NOTES_EXTRACTION_RULES,
  MEETING_NOTES_MAP_CHUNK_RULES,
  MEETING_NOTES_REDUCE_RULES,
} from "./meeting-notes-prompt.js";
import {
  MEETING_NOTES_SCHEMA,
  type RawMeetingNotesPayload,
} from "./normalize-meeting-notes.js";
import type { MeetingNotesExtractFn, MeetingNotesReduceFn } from "./meeting-notes-mapreduce.js";

export function createReasoningMeetingNotesExtractors(
  client: OpenAI,
  model: string,
): { extract: MeetingNotesExtractFn; reduce: MeetingNotesReduceFn } {
  return {
    extract: async (input) => {
      const instructions = input.mapChunk
        ? MEETING_NOTES_MAP_CHUNK_RULES
        : MEETING_NOTES_EXTRACTION_RULES;
      return callReasoningNotes(client, model, instructions, {
        meetingTitle: input.meetingTitle,
        body: `Meeting title: ${input.meetingTitle}\n\nTranscript:\n${input.transcriptText}`,
      });
    },
    reduce: async (input) => {
      return callReasoningNotes(client, model, MEETING_NOTES_REDUCE_RULES, {
        meetingTitle: input.meetingTitle,
        body: `Meeting title: ${input.meetingTitle}\n\nPartial notes JSON:\n${input.partialNotesJson}`,
      });
    },
  };
}

async function callReasoningNotes(
  client: OpenAI,
  model: string,
  instructions: string,
  input: { meetingTitle: string; body: string },
): Promise<RawMeetingNotesPayload> {
  const response = await client.responses.create({
    model,
    reasoning: { effort: "low" },
    max_output_tokens: 8192,
    instructions,
    input: input.body,
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

  try {
    return JSON.parse(raw) as RawMeetingNotesPayload;
  } catch {
    throw new Error("OpenAI returned invalid JSON for meeting notes");
  }
}
