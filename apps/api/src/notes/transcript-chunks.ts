import type { TranscriptSegment } from "@cognium/meet-shared";
import { formatTimestamp, segmentsToPlainText } from "@cognium/meet-shared";

/** Above this length we map-reduce instead of a single LLM call. */
export const NOTES_SINGLE_PASS_MAX_CHARS = 90_000;

/** Target size per map step (segment-aligned). */
export const NOTES_CHUNK_TARGET_CHARS = 42_000;

export interface TranscriptChunk {
  index: number;
  total: number;
  segments: TranscriptSegment[];
  text: string;
  /** e.g. Part 2/4 (00:15:30–00:32:10) */
  label: string;
}

export function transcriptPlainTextLength(segments: TranscriptSegment[]): number {
  return segmentsToPlainText(segments).length;
}

export function shouldMapReduceTranscript(segments: TranscriptSegment[]): boolean {
  return transcriptPlainTextLength(segments) > NOTES_SINGLE_PASS_MAX_CHARS;
}

export function chunkTranscriptSegments(
  segments: TranscriptSegment[],
  targetChars = NOTES_CHUNK_TARGET_CHARS,
): TranscriptChunk[] {
  if (segments.length === 0) {
    return [];
  }

  const groups: TranscriptSegment[][] = [];
  let current: TranscriptSegment[] = [];
  let currentLen = 0;

  for (const seg of segments) {
    const line = segmentLine(seg);
    const lineLen = line.length + 1;

    if (current.length > 0 && currentLen + lineLen > targetChars) {
      groups.push(current);
      current = [];
      currentLen = 0;
    }

    current.push(seg);
    currentLen += lineLen;
  }

  if (current.length > 0) {
    groups.push(current);
  }

  const total = groups.length;
  return groups.map((group, index) => {
    const text = segmentsToPlainText(group);
    const start = group[0]?.start ?? 0;
    const end = group[group.length - 1]?.end ?? start;
    return {
      index,
      total,
      segments: group,
      text,
      label: `Part ${index + 1}/${total} (${formatTimestamp(start)}–${formatTimestamp(end)})`,
    };
  });
}

function segmentLine(seg: TranscriptSegment): string {
  const who = seg.speaker ? `${seg.speaker}: ` : "";
  return `[${formatTimestamp(seg.start)}] ${who}${seg.text.trim()}`;
}

export function formatChunkTranscriptInput(chunk: TranscriptChunk): string {
  return `Transcript segment: ${chunk.label}\n\n${chunk.text}`;
}
