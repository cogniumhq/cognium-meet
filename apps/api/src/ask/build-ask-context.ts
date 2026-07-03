import type { MeetingNotes, RecordingMeta } from "@cognium/meet-shared";
import {
  formatMeetingNotesMarkdown,
  segmentsToPlainText,
} from "@cognium/meet-shared";
import type { RecordingStore } from "../storage/recording-store.js";
import type { SearchIndex } from "../storage/search-index.js";

export interface AskContextCitation {
  recordingId: string;
  meetingTitle?: string;
  startedAt: string;
  excerpt: string;
}

export interface AskContextResult {
  context: string;
  citations: AskContextCitation[];
  meetingCount: number;
}

const MAX_CONTEXT_CHARS = 90_000;
const MAX_MEETINGS = 5;
const PER_MEETING_TRANSCRIPT_CHARS = 14_000;

/** Scoped Ask (single recording): notes + transcript excerpt, not the full transcript. */
const SCOPED_MAX_CONTEXT_CHARS = 14_000;
const SCOPED_TRANSCRIPT_EXCERPT_CHARS = 8_000;

function compactNotes(notes: MeetingNotes): string {
  return formatMeetingNotesMarkdown(notes);
}

function excerpt(text: string, max = 220): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max)}…`;
}

/** Head + tail excerpt for long transcripts (scoped Ask). */
export function excerptTranscript(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }

  const marker = "\n\n[… middle of transcript omitted …]\n\n";
  const budget = maxChars - marker.length;
  const headChars = Math.floor(budget * 0.45);
  const tailChars = budget - headChars;

  return (
    `[Transcript excerpt — ${trimmed.length.toLocaleString()} characters total; beginning and end shown]\n` +
    trimmed.slice(0, headChars) +
    marker +
    trimmed.slice(-tailChars)
  );
}

async function pickRecordingIds(
  store: RecordingStore,
  searchIndex: SearchIndex,
  question: string,
  recordingId?: string,
): Promise<string[]> {
  if (recordingId) {
    const meta = await store.getMeta(recordingId);
    return meta?.status === "completed" ? [recordingId] : [];
  }

  const hits = searchIndex.search(question, MAX_MEETINGS);
  const ids = hits.map((h) => h.recordingId);
  if (ids.length >= MAX_MEETINGS) {
    return ids;
  }

  const metas = await store.listMetas();
  for (const meta of metas) {
    if (meta.status !== "completed") {
      continue;
    }
    if (!ids.includes(meta.id)) {
      ids.push(meta.id);
    }
    if (ids.length >= MAX_MEETINGS) {
      break;
    }
  }

  return ids;
}

async function formatMeetingBlock(
  store: RecordingStore,
  meta: RecordingMeta,
  opts: { transcriptLimit: number; scoped: boolean },
): Promise<{ block: string; excerpt: string } | null> {
  const title = meta.meetingTitle?.trim() || "Recording";
  const date = new Date(meta.startedAt).toISOString().slice(0, 10);
  const parts: string[] = [`### ${title} (${date})`, `recordingId: ${meta.id}`];

  let excerptSource = "";

  const notes =
    meta.notesStatus === "completed"
      ? await store.readMeetingNotes(meta.id)
      : null;
  if (notes) {
    parts.push("", compactNotes(notes));
    excerptSource = notes.summary;
  }

  const transcript = await store.readTranscriptJson(meta.id);
  if (transcript && transcript.segments.length > 0) {
    let text = segmentsToPlainText(transcript.segments);
    if (opts.scoped) {
      text = excerptTranscript(text, opts.transcriptLimit);
    } else if (text.length > opts.transcriptLimit) {
      text =
        `[Transcript truncated — showing last ${opts.transcriptLimit} characters]\n` +
        text.slice(-opts.transcriptLimit);
    }
    parts.push("", "## Transcript", text);
    if (!excerptSource) {
      excerptSource = text;
    }
  }

  if (parts.length <= 2) {
    return null;
  }

  return {
    block: parts.join("\n"),
    excerpt: excerpt(excerptSource),
  };
}

export async function buildAskContext(opts: {
  store: RecordingStore;
  searchIndex: SearchIndex;
  question: string;
  recordingId?: string;
}): Promise<AskContextResult> {
  const scoped = Boolean(opts.recordingId);
  const ids = await pickRecordingIds(
    opts.store,
    opts.searchIndex,
    opts.question,
    opts.recordingId,
  );

  if (ids.length === 0) {
    return { context: "", citations: [], meetingCount: 0 };
  }

  const perMeetingLimit = scoped
    ? SCOPED_TRANSCRIPT_EXCERPT_CHARS
    : PER_MEETING_TRANSCRIPT_CHARS;
  const maxContextChars = scoped ? SCOPED_MAX_CONTEXT_CHARS : MAX_CONTEXT_CHARS;

  const blocks: string[] = [];
  const citations: AskContextCitation[] = [];

  for (const id of ids) {
    const meta = await opts.store.getMeta(id);
    if (!meta || meta.status !== "completed") {
      continue;
    }

    const formatted = await formatMeetingBlock(opts.store, meta, {
      transcriptLimit: perMeetingLimit,
      scoped,
    });
    if (!formatted) {
      continue;
    }

    const nextContext = [...blocks, formatted.block].join("\n\n---\n\n");
    if (nextContext.length > maxContextChars && blocks.length > 0) {
      break;
    }

    blocks.push(formatted.block);
    if (!citations.some((c) => c.recordingId === id)) {
      citations.push({
        recordingId: id,
        meetingTitle: meta.meetingTitle,
        startedAt: meta.startedAt,
        excerpt: formatted.excerpt,
      });
    }
  }

  let context = blocks.join("\n\n---\n\n");
  if (context.length > maxContextChars) {
    context =
      `[Context trimmed to ${maxContextChars.toLocaleString()} characters]\n` +
      context.slice(0, maxContextChars);
  }

  return {
    context,
    citations,
    meetingCount: citations.length,
  };
}
