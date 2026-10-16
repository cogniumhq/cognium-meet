import type { MeetingLlmProvider } from "@cognium/meet-shared";
import { meetingAskTimeoutMessage } from "@cognium/meet-shared";
import { MeetingLlmTimeoutError } from "./meeting-llm-timeout.js";

function extractOllamaMissingModel(message: string): string | undefined {
  const match = message.match(/model ['"]([^'"]+)['"] not found/i);
  return match?.[1];
}

function messageFromBody(body: unknown): string | undefined {
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (!trimmed || trimmed.startsWith("[ReadableStream")) {
      return undefined;
    }
    try {
      return messageFromBody(JSON.parse(trimmed)) ?? trimmed.slice(0, 500);
    } catch {
      return trimmed.slice(0, 500);
    }
  }
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  // Ax status errors nest the HTTP body under responseBody.responseBody.
  if ("responseBody" in record) {
    return messageFromBody(record.responseBody);
  }
  // OpenAI / OpenRouter: { error: { message } }; Ollama: { error: "..." }.
  const error = record.error;
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }
  }
  if (typeof record.message === "string" && record.message.trim()) {
    return record.message.trim();
  }
  return undefined;
}

/** The provider's own error message (e.g. OpenAI's "Unsupported parameter: …"), if Ax captured it. */
export function providerErrorReason(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    if (typeof current === "object" && "responseBody" in current) {
      const reason = messageFromBody((current as { responseBody: unknown }).responseBody);
      if (reason) {
        return reason;
      }
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
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

  const reason = providerErrorReason(err);
  const detail = reason ?? message;
  const combined = `${message}\n${cause}\n${reason ?? ""}`;

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
    if (/400|bad request/i.test(combined)) {
      return `OpenAI rejected the request for model "${model}": ${detail}`;
    }
  }

  if (provider === "openrouter") {
    if (/401|unauthorized|invalid.*api.*key|user not found/i.test(combined)) {
      return "OpenRouter API key is missing or invalid. Add your key in extension Settings (Meeting AI → OpenRouter).";
    }
    if (/402|insufficient.?credits|payment required/i.test(combined)) {
      return "OpenRouter account has insufficient credits. Add credits at openrouter.ai or choose a free model.";
    }
    if (/model.*not found|does not exist|404/i.test(combined)) {
      return `OpenRouter model "${model}" is not available. Choose another model in extension Settings (use provider/model ids, e.g. openai/gpt-4o-mini).`;
    }
    if (/400|bad request/i.test(combined)) {
      return `OpenRouter rejected the request for model "${model}": ${detail}`;
    }
  }

  return detail || "Meeting AI request failed";
}
