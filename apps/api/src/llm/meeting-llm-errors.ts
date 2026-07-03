import type { MeetingLlmProvider } from "@cognium/meet-shared";

function extractOllamaMissingModel(message: string): string | undefined {
  const match = message.match(/model ['"]([^'"]+)['"] not found/i);
  return match?.[1];
}

/** Turn Ax / provider errors into a short message for API clients. */
export function formatMeetingLlmError(
  err: unknown,
  provider: MeetingLlmProvider,
  model: string,
): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause =
    err instanceof Error && "cause" in err && err.cause instanceof Error
      ? err.cause.message
      : "";

  const combined = `${message}\n${cause}`;

  if (provider === "ollama") {
    const missing = extractOllamaMissingModel(combined) ?? model;
    if (/not found|404/i.test(combined)) {
      return `Ollama model "${missing}" is not installed. Run \`ollama pull ${missing}\` or pick an installed model in extension Settings.`;
    }
    if (/ECONNREFUSED|fetch failed|unreachable/i.test(combined)) {
      return `Cannot reach Ollama. Check that it is running and the Ollama URL in extension Settings is correct.`;
    }
  }

  if (provider === "openai") {
    if (/401|invalid.*api.*key|incorrect api key/i.test(combined)) {
      return "OpenAI API key is missing or invalid. Add your key in extension Settings.";
    }
    if (/model.*not found|does not exist/i.test(combined)) {
      return `OpenAI model "${model}" is not available for your API key. Choose another model in extension Settings.`;
    }
  }

  return message || "Meeting AI request failed";
}
