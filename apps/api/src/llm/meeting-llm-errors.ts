import type { MeetingLlmProvider } from "@cognium/meet-shared";
import { meetingAskTimeoutMessage } from "@cognium/meet-shared";
import { MeetingLlmTimeoutError } from "./meeting-llm-timeout.js";

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
  if (err instanceof MeetingLlmTimeoutError) {
    return err.message;
  }

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
    if (/took too long|timed out|timeout/i.test(combined)) {
      return meetingAskTimeoutMessage("ollama");
    }
  }

  if (provider === "openai") {
    if (/401|invalid.*api.*key|incorrect api key/i.test(combined)) {
      return "OpenAI API key is missing or invalid. Add your key in extension Settings.";
    }
    if (/model.*not found|does not exist/i.test(combined)) {
      return `OpenAI model "${model}" is not available for your API key. Choose another model in extension Settings.`;
    }
    if (/400|bad request/i.test(combined) && /gpt-5\.5/i.test(model)) {
      return `OpenAI rejected GPT-5.5 (${message}). Try gpt-4o or gpt-4.1, or confirm your API key has GPT-5.5 access.`;
    }
    if (/400|bad request/i.test(combined)) {
      return `OpenAI rejected the request for model "${model}": ${message}`;
    }
  }

  return message || "Meeting AI request failed";
}
