import type { TranscriptSegment } from "@cognium/meet-shared";
import { segmentsToPlainText } from "@cognium/meet-shared";
import {
  buildMeetingNotes,
  type RawMeetingNotesPayload,
} from "./normalize-meeting-notes.js";
import {
  chunkTranscriptSegments,
  formatChunkTranscriptInput,
  shouldMapReduceTranscript,
} from "./transcript-chunks.js";

export interface MeetingNotesExtractFn {
  (input: {
    meetingTitle: string;
    transcriptText: string;
    mapChunk: boolean;
  }): Promise<RawMeetingNotesPayload>;
}

export interface MeetingNotesReduceFn {
  (input: {
    meetingTitle: string;
    partialNotesJson: string;
  }): Promise<RawMeetingNotesPayload>;
}

export async function generateMeetingNotesWithMapReduce(opts: {
  recordingId: string;
  meetingTitle?: string;
  llmModel: string;
  segments: TranscriptSegment[];
  extract: MeetingNotesExtractFn;
  reduce: MeetingNotesReduceFn;
  log?: (message: string) => void;
}) {
  const title = opts.meetingTitle?.trim() || "Meeting";
  const log = opts.log ?? (() => {});

  if (!shouldMapReduceTranscript(opts.segments)) {
    const text = segmentsToPlainText(opts.segments);
    const parsed = await opts.extract({
      meetingTitle: title,
      transcriptText: text,
      mapChunk: false,
    });
    return buildMeetingNotes({
      recordingId: opts.recordingId,
      meetingTitle: opts.meetingTitle,
      llmModel: opts.llmModel,
      parsed,
    });
  }

  const chunks = chunkTranscriptSegments(opts.segments);
  log(
    `map-reduce ${chunks.length} chunks (${segmentsToPlainText(opts.segments).length} chars)`,
  );

  const partials: RawMeetingNotesPayload[] = [];
  for (const chunk of chunks) {
    log(`map chunk ${chunk.index + 1}/${chunk.total} ${chunk.label}`);
    const parsed = await opts.extract({
      meetingTitle: title,
      transcriptText: formatChunkTranscriptInput(chunk),
      mapChunk: true,
    });
    partials.push(parsed);
  }

  const partialNotesJson = JSON.stringify(
    partials.map((notes, index) => ({
      segment: chunks[index]?.label ?? `Part ${index + 1}`,
      ...notes,
    })),
  );

  log(`reduce ${partials.length} partial note sets`);
  const merged = await opts.reduce({
    meetingTitle: title,
    partialNotesJson,
  });

  return buildMeetingNotes({
    recordingId: opts.recordingId,
    meetingTitle: opts.meetingTitle,
    llmModel: opts.llmModel,
    parsed: merged,
  });
}
