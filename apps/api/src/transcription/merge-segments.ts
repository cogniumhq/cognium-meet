import type { TranscriptSegment } from "@cognium/meet-shared";

export const SPEAKER_YOU = "You";
export const SPEAKER_OTHERS = "Others";

export function labelSegments(
  segments: Array<{ start: number; end: number; text: string }>,
  speaker: string,
): TranscriptSegment[] {
  return segments.map((seg) => ({
    start: seg.start,
    end: seg.end,
    text: seg.text,
    speaker,
  }));
}

/** Merge labeled tracks into one timeline sorted by start time. */
export function mergeSpeakerSegments(
  ...tracks: Array<{
    speaker: string;
    segments: Array<{ start: number; end: number; text: string }>;
  }>
): TranscriptSegment[] {
  const merged: TranscriptSegment[] = [];
  for (const track of tracks) {
    if (track.segments.length === 0) {
      continue;
    }
    merged.push(...labelSegments(track.segments, track.speaker));
  }
  merged.sort((a, b) => a.start - b.start || a.end - b.end);
  return merged;
}
