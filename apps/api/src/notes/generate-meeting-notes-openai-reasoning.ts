import OpenAI from "openai";
import {
  formatMeetingActionItem,
  type MeetingNotes,
  type TranscriptResult,
} from "@cognium/meet-shared";
import { segmentsToPlainText } from "@cognium/meet-shared";
import { MEETING_NOTES_EXTRACTION_RULES } from "./meeting-notes-prompt.js";

const MAX_TRANSCRIPT_CHARS = 90_000;
const MAX_GOALS = 6;
const MAX_ACTION_ITEMS = 12;
const MAX_ROADMAP = 8;
const MAX_DECISIONS = 8;
const MAX_OPEN_QUESTIONS = 6;

const MEETING_NOTES_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    goals: {
      type: "array",
      items: { type: "string" },
      maxItems: MAX_GOALS,
    },
    actionItems: {
      type: "array",
      maxItems: MAX_ACTION_ITEMS,
      items: {
        type: "object",
        properties: {
          owner: { type: "string" },
          task: { type: "string" },
        },
        required: ["owner", "task"],
        additionalProperties: false,
      },
    },
    roadmap: {
      type: "array",
      items: { type: "string" },
      maxItems: MAX_ROADMAP,
    },
    decisions: {
      type: "array",
      items: { type: "string" },
      maxItems: MAX_DECISIONS,
    },
    openQuestions: {
      type: "array",
      items: { type: "string" },
      maxItems: MAX_OPEN_QUESTIONS,
    },
  },
  required: ["summary", "goals", "actionItems", "roadmap", "decisions", "openQuestions"],
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

  let parsed: {
    summary?: string;
    goals?: unknown;
    actionItems?: unknown;
    roadmap?: unknown;
    decisions?: unknown;
    openQuestions?: unknown;
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new Error("OpenAI returned invalid JSON for meeting notes");
  }

  const goals = capList(dedupeStrings(normalizeList(parsed.goals)), MAX_GOALS);
  const actionItems = capList(
    dedupeStrings(normalizeActionItems(parsed.actionItems)),
    MAX_ACTION_ITEMS,
  );
  const roadmap = capList(dedupeStrings(normalizeList(parsed.roadmap)), MAX_ROADMAP);
  const decisions = capList(
    dedupeAgainst(
      dedupeStrings(normalizeList(parsed.decisions)),
      [...goals, ...actionItems, ...roadmap],
    ),
    MAX_DECISIONS,
  );
  const openQuestions = capList(
    dedupeStrings(normalizeList(parsed.openQuestions)),
    MAX_OPEN_QUESTIONS,
  );

  return {
    recordingId: opts.recordingId,
    meetingTitle: opts.meetingTitle,
    generatedAt: new Date().toISOString(),
    llmModel: opts.model,
    summary: parsed.summary?.trim() || "No summary generated.",
    goals: goals.length > 0 ? goals : undefined,
    actionItems,
    roadmap: roadmap.length > 0 ? roadmap : undefined,
    decisions,
    openQuestions,
  };
}

function normalizeActionItems(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: string[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as { owner?: unknown; task?: unknown };
    const task = typeof record.task === "string" ? record.task.trim() : "";
    if (!task) {
      continue;
    }
    const owner =
      typeof record.owner === "string" && record.owner.trim()
        ? record.owner.trim()
        : "Team";
    const formatted = formatMeetingActionItem({ owner, task });
    if (formatted) {
      items.push(formatted);
    }
  }
  return items;
}

function normalizeList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

function capList(items: string[], max: number): string[] {
  return items.slice(0, max);
}

function dedupeStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = normalizeKey(item);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(item);
  }
  return out;
}

function dedupeAgainst(items: string[], blocklist: string[]): string[] {
  const blocked = new Set(blocklist.map(normalizeKey));
  return items.filter((item) => !blocked.has(normalizeKey(item)));
}

function normalizeKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\*\*/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
