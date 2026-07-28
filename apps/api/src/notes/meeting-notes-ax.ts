import { ax } from "@ax-llm/ax";
import type { AxAIService } from "@ax-llm/ax";
import {
  MEETING_NOTES_EXTRACTION_RULES,
  MEETING_NOTES_MAP_CHUNK_RULES,
  MEETING_NOTES_REDUCE_RULES,
} from "./meeting-notes-prompt.js";
import type { RawMeetingNotesPayload } from "./normalize-meeting-notes.js";
import type { MeetingNotesExtractFn, MeetingNotesReduceFn } from "./meeting-notes-mapreduce.js";

const meetingNotesGen = ax(
  `meetingTitle:string, transcript:string -> summary:string, goals:string[], actionItems:json, roadmap:string[], decisions:string[], openQuestions:string[]`,
  {
    description: MEETING_NOTES_EXTRACTION_RULES,
  },
);

const meetingNotesMapGen = ax(
  `meetingTitle:string, transcript:string -> summary:string, goals:string[], actionItems:json, roadmap:string[], decisions:string[], openQuestions:string[]`,
  {
    description: MEETING_NOTES_MAP_CHUNK_RULES,
  },
);

const meetingNotesReduceGen = ax(
  `meetingTitle:string, partialNotesJson:string -> summary:string, goals:string[], actionItems:json, roadmap:string[], decisions:string[], openQuestions:string[]`,
  {
    description: MEETING_NOTES_REDUCE_RULES,
  },
);

export function createAxMeetingNotesExtractors(
  llm: AxAIService,
  model: string,
): { extract: MeetingNotesExtractFn; reduce: MeetingNotesReduceFn } {
  return {
    extract: async (input) => {
      const gen = input.mapChunk ? meetingNotesMapGen : meetingNotesGen;
      const result = await gen.forward(
        llm,
        {
          meetingTitle: input.meetingTitle,
          transcript: input.transcriptText,
        },
        { model },
      );
      return axResultToPayload(result);
    },
    reduce: async (input) => {
      const result = await meetingNotesReduceGen.forward(
        llm,
        {
          meetingTitle: input.meetingTitle,
          partialNotesJson: input.partialNotesJson,
        },
        { model },
      );
      return axResultToPayload(result);
    },
  };
}

function axResultToPayload(result: {
  summary?: string;
  goals?: unknown;
  actionItems?: unknown;
  roadmap?: unknown;
  decisions?: unknown;
  openQuestions?: unknown;
}): RawMeetingNotesPayload {
  return {
    summary: result.summary,
    goals: result.goals,
    actionItems: result.actionItems,
    roadmap: result.roadmap,
    decisions: result.decisions,
    openQuestions: result.openQuestions,
  };
}
