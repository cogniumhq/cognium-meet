import { formatMeetingActionItem, type MeetingNotes } from "@cognium/meet-shared";

export const MAX_GOALS = 6;
export const MAX_ACTION_ITEMS = 12;
export const MAX_ROADMAP = 8;
export const MAX_DECISIONS = 8;
export const MAX_OPEN_QUESTIONS = 6;

export const MEETING_NOTES_SCHEMA = {
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

export interface RawMeetingNotesPayload {
  summary?: string;
  goals?: unknown;
  actionItems?: unknown;
  roadmap?: unknown;
  decisions?: unknown;
  openQuestions?: unknown;
}

export function buildMeetingNotes(opts: {
  recordingId: string;
  meetingTitle?: string;
  llmModel?: string;
  parsed: RawMeetingNotesPayload;
}): MeetingNotes {
  const goals = capList(dedupeStrings(normalizeList(opts.parsed.goals)), MAX_GOALS);
  const actionItems = capList(
    dedupeStrings(normalizeActionItems(opts.parsed.actionItems)),
    MAX_ACTION_ITEMS,
  );
  const roadmap = capList(dedupeStrings(normalizeList(opts.parsed.roadmap)), MAX_ROADMAP);
  const decisions = capList(
    dedupeAgainst(
      dedupeStrings(normalizeList(opts.parsed.decisions)),
      [...goals, ...actionItems, ...roadmap],
    ),
    MAX_DECISIONS,
  );
  const openQuestions = capList(
    dedupeStrings(normalizeList(opts.parsed.openQuestions)),
    MAX_OPEN_QUESTIONS,
  );

  return {
    recordingId: opts.recordingId,
    meetingTitle: opts.meetingTitle,
    generatedAt: new Date().toISOString(),
    llmModel: opts.llmModel,
    summary: opts.parsed.summary?.trim() || "No summary generated.",
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
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      if (trimmed) {
        items.push(trimmed);
      }
      continue;
    }
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
