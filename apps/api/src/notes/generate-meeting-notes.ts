import { ai, ax } from "@ax-llm/ax";
import type { MeetingNotes, TranscriptResult } from "@cognium/meet-shared";
import { segmentsToPlainText } from "@cognium/meet-shared";

const MAX_TRANSCRIPT_CHARS = 90_000;

const meetingNotesGen = ax(
  `meetingTitle:string, transcript:string -> summary:string, actionItems:string[], decisions:string[], openQuestions:string[]`,
  {
    description:
      "Extract structured meeting notes from a transcript. Action items should be specific and start with a verb. Decisions are firm conclusions reached. Open questions are unresolved topics.",
  },
);

export async function generateMeetingNotes(opts: {
  apiKey: string;
  model: string;
  recordingId: string;
  meetingTitle?: string;
  transcript: TranscriptResult;
}): Promise<MeetingNotes> {
  const llm = ai({ name: "openai", apiKey: opts.apiKey });

  let text = segmentsToPlainText(opts.transcript.segments);
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    text =
      `[Transcript truncated to the last ${MAX_TRANSCRIPT_CHARS} characters]\n\n` +
      text.slice(-MAX_TRANSCRIPT_CHARS);
  }

  const result = await meetingNotesGen.forward(
    llm,
    {
      meetingTitle: opts.meetingTitle?.trim() || "Meeting",
      transcript: text,
    },
    { model: opts.model },
  );

  return {
    recordingId: opts.recordingId,
    meetingTitle: opts.meetingTitle,
    generatedAt: new Date().toISOString(),
    summary: result.summary?.trim() || "No summary generated.",
    actionItems: normalizeList(result.actionItems),
    decisions: normalizeList(result.decisions),
    openQuestions: normalizeList(result.openQuestions),
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
