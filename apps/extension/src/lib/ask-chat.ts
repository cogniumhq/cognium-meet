import type { MeetingAskMessage } from "@cognium/meet-shared";

/** Drop a trailing failed assistant turn so the same user question can be retried. */
export function messagesForAskRetry(
  messages: MeetingAskMessage[],
): MeetingAskMessage[] | null {
  if (messages.length === 0) {
    return null;
  }

  const trimmed = [...messages];
  const last = trimmed[trimmed.length - 1];
  if (last.role === "assistant" && last.isError) {
    trimmed.pop();
  }

  if (trimmed.length === 0 || trimmed[trimmed.length - 1]?.role !== "user") {
    return null;
  }

  return trimmed;
}

export function canRetryAsk(
  messages: MeetingAskMessage[],
  pending: boolean,
): boolean {
  return !pending && messagesForAskRetry(messages) !== null;
}
