/**
 * whisper-1 only uses the final ~224 tokens of the prompt (OpenAI speech-to-text guide).
 * We approximate the limit with a character cap and keep the tail when truncating.
 *
 * Prompts must read like sample transcript text — not instructions or titles.
 * Whisper hallucinates prompt wording into the output, especially on silent audio.
 */
export const WHISPER_PROMPT_MAX_CHARS = 900;

export interface WhisperPromptInput {
  /** Plain text from the immediately preceding audio chunk. */
  previousChunkText?: string;
}

/** Strip auto-suffixes added by the extension on tab close / capture end. */
export function normalizeMeetingTitle(title: string): string {
  return title
    .replace(/\s*\(tab closed\)\s*$/i, "")
    .replace(/\s*\(capture ended\)\s*$/i, "")
    .trim();
}

function normalizeForEchoCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when segment text is just the tab/meeting title (a common prompt echo). */
export function isMeetingTitleEcho(text: string, meetingTitle?: string): boolean {
  if (!meetingTitle) {
    return false;
  }
  const cleaned = normalizeMeetingTitle(meetingTitle);
  const titleNorm = normalizeForEchoCompare(cleaned);
  const textNorm = normalizeForEchoCompare(text);
  if (!titleNorm || !textNorm) {
    return false;
  }
  return textNorm === titleNorm;
}

/**
 * Build a Whisper prompt for cross-chunk continuity only.
 * Meeting title is kept in recording metadata but not sent to Whisper — it gets echoed.
 * @see https://developers.openai.com/api/docs/guides/speech-to-text#prompting
 */
export function buildWhisperPrompt(input: WhisperPromptInput): string | undefined {
  const previous = input.previousChunkText?.trim();
  if (!previous) {
    // No prompt on the first chunk — reduces hallucinations on quiet lead-in audio.
    return undefined;
  }
  return truncateWhisperPrompt(previous);
}

export function truncateWhisperPrompt(prompt: string): string {
  if (prompt.length <= WHISPER_PROMPT_MAX_CHARS) {
    return prompt;
  }
  return prompt.slice(-WHISPER_PROMPT_MAX_CHARS);
}

export function chunkPlainText(segments: { text: string }[]): string {
  return segments
    .map((seg) => seg.text.trim())
    .filter(Boolean)
    .join(" ");
}

export interface FilterEchoOpts {
  prompt?: string;
  meetingTitle?: string;
}

/** Drop segments that echo prompts or the meeting/tab title. */
export function filterPromptEchoSegments<T extends { text: string }>(
  segments: T[],
  opts?: FilterEchoOpts,
): T[] {
  const banned = [
    "use proper punctuation and capitalization",
    "this is a recording of a meeting or call titled",
    "the following conversation is from a meeting titled",
    "hello, welcome to the meeting",
  ];

  return segments.filter((seg) => {
    const text = seg.text.trim();
    if (!text) {
      return false;
    }
    const lower = text.toLowerCase();
    if (banned.some((phrase) => lower.includes(phrase))) {
      return false;
    }
    if (isMeetingTitleEcho(text, opts?.meetingTitle)) {
      return false;
    }
    if (opts?.prompt) {
      const promptLower = opts.prompt.toLowerCase();
      if (promptLower.includes(lower) && lower.length >= 24) {
        return false;
      }
    }
    return true;
  });
}

/** Remove consecutive title-only segments at the start (Whisper silence hallucinations). */
export function stripLeadingTitleEchoes<T extends { text: string }>(
  segments: T[],
  meetingTitle?: string,
): T[] {
  if (!meetingTitle) {
    return segments;
  }
  let start = 0;
  while (
    start < segments.length &&
    isMeetingTitleEcho(segments[start]!.text, meetingTitle)
  ) {
    start++;
  }
  return segments.slice(start);
}
