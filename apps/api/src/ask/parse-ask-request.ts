import type { MeetingAskMessage } from "@cognium/meet-shared";
import { meetingAskRetrievalQuery } from "@cognium/meet-shared";
import type { RecordingStore } from "../storage/recording-store.js";
import type { SearchIndex } from "../storage/search-index.js";
import { buildAskContext, type AskContextResult } from "./build-ask-context.js";

export function parseAskMessages(body: {
  question?: string;
  messages?: unknown;
}): MeetingAskMessage[] | null {
  if (Array.isArray(body.messages)) {
    const messages: MeetingAskMessage[] = [];
    for (const item of body.messages) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const row = item as Record<string, unknown>;
      const role = row.role;
      const content = typeof row.content === "string" ? row.content.trim() : "";
      if ((role !== "user" && role !== "assistant") || !content) {
        continue;
      }
      messages.push({ role, content });
    }
    return messages.some((m) => m.role === "user") ? messages : null;
  }

  const question = body.question?.trim();
  if (question) {
    return [{ role: "user", content: question }];
  }

  return null;
}

export async function buildAskContextForMessages(opts: {
  store: RecordingStore;
  searchIndex: SearchIndex;
  messages: MeetingAskMessage[];
  recordingId?: string;
}): Promise<AskContextResult> {
  return buildAskContext({
    store: opts.store,
    searchIndex: opts.searchIndex,
    question: meetingAskRetrievalQuery(opts.messages),
    recordingId: opts.recordingId,
  });
}
