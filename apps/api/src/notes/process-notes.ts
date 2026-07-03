import type { RecordingMeta } from "@cognium/meet-shared";
import {
  meetingLlmConfigFromFields,
  resolveMeetingLlmModel,
} from "../llm/create-meeting-llm.js";
import { formatMeetingLlmError } from "../llm/meeting-llm-errors.js";
import { ensureOllamaModelAvailable } from "../llm/ollama-client.js";
import type { RecordingStore } from "../storage/recording-store.js";
import type { UserStoreRegistry } from "../storage/user-store-registry.js";
import { recordingMeetingSettings } from "../parse-client-settings.js";
import { requireOpenAiApiKey } from "../resolve-openai-key.js";
import { generateMeetingNotes } from "./generate-meeting-notes.js";

export interface NotesProcessingDeps {
  userRegistry: UserStoreRegistry;
  /** Server fallback when the client does not send a key. */
  openaiApiKey?: string;
}

const activeNotesJobs = new Set<string>();

function notesJobKey(userId: string, id: string): string {
  return `${userId}:${id}`;
}

export function isNotesJobActive(userId: string, id: string): boolean {
  return activeNotesJobs.has(notesJobKey(userId, id));
}

export function shouldGenerateMeetingNotes(meta: RecordingMeta): boolean {
  if (meta.status !== "completed" || meta.meetingNotesEnabled === false) {
    return false;
  }
  const status = meta.notesStatus;
  return status === "pending" || status === "processing" || status === undefined;
}

export async function resumePendingMeetingNotes(deps: NotesProcessingDeps): Promise<void> {
  const userIds = await deps.userRegistry.listUserIds();
  for (const userId of userIds) {
    const { store } = await deps.userRegistry.forUser(userId);
    const completed = await store.listMetasByStatus("completed");
    for (const meta of completed) {
      if (!shouldGenerateMeetingNotes(meta)) {
        continue;
      }
      if (isNotesJobActive(userId, meta.id)) {
        continue;
      }
      console.log(`Resuming meeting notes for user=${userId} id=${meta.id}`);
      enqueueMeetingNotes(deps, userId, meta.id);
    }
  }
}

export function enqueueMeetingNotes(
  deps: NotesProcessingDeps,
  userId: string,
  id: string,
): void {
  const key = notesJobKey(userId, id);
  if (activeNotesJobs.has(key)) {
    return;
  }
  activeNotesJobs.add(key);
  void processMeetingNotes(deps, userId, id).finally(() => {
    activeNotesJobs.delete(key);
  });
}

async function processMeetingNotes(
  deps: NotesProcessingDeps,
  userId: string,
  id: string,
): Promise<void> {
  const { store, searchIndex } = await deps.userRegistry.forUser(userId);
  const meta = await store.getMeta(id);
  if (!meta || meta.status !== "completed") {
    return;
  }

  if (meta.meetingNotesEnabled === false) {
    await saveNotesMeta(store, meta, {
      notesStatus: "skipped",
      notesError: undefined,
    });
    return;
  }

  const transcript = await store.readTranscriptJson(id);
  if (!transcript || transcript.segments.length === 0) {
    await saveNotesMeta(store, meta, {
      notesStatus: "failed",
      notesError: "Transcript is empty — cannot generate notes",
    });
    return;
  }

  await saveNotesMeta(store, meta, {
    notesStatus: "processing",
    notesError: undefined,
  });

  const clientSettings = recordingMeetingSettings(meta);
  const llmProvider = clientSettings.meetingLlmProvider;
  let openaiKey: string | undefined;
  if (llmProvider === "openai") {
    try {
      openaiKey = requireOpenAiApiKey({
        storedKey: meta.openaiApiKey,
        serverKey: deps.openaiApiKey,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await saveNotesMeta(store, meta, {
        notesStatus: "failed",
        notesError: message,
      });
      return;
    }
  }
  const llmConfig = meetingLlmConfigFromFields(openaiKey ?? "", {
    meetingLlmProvider: clientSettings.meetingLlmProvider,
    ollamaUrl: clientSettings.ollamaUrl,
    ollamaModel: clientSettings.ollamaModel,
  });
  const notesModel = resolveMeetingLlmModel(
    llmConfig,
    clientSettings.meetingLlmModel,
    llmProvider,
  );
  console.log(
    `[notes] started user=${userId} id=${id} provider=${llmProvider} model=${notesModel}`,
  );

  if (llmProvider === "ollama") {
    try {
      await ensureOllamaModelAvailable(clientSettings.ollamaUrl, notesModel);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await saveNotesMeta(store, meta, {
        notesStatus: "failed",
        notesError: message,
      });
      console.error(`[notes] failed user=${userId} id=${id} error=${message}`);
      return;
    }
  }

  try {
    const notes = await generateMeetingNotes({
      llmConfig,
      llmProvider,
      model: notesModel,
      recordingId: id,
      meetingTitle: meta.meetingTitle,
      transcript,
    });

    await store.saveMeetingNotes(id, notes);

    const latest = await store.getMeta(id);
    if (!latest) {
      return;
    }

    searchIndex.indexNotes(id, latest.meetingTitle, latest.startedAt, notes);

    await saveNotesMeta(store, latest, {
      notesStatus: "completed",
      notesError: undefined,
    });

    console.log(
      `[notes] completed user=${userId} id=${id} provider=${llmProvider} actions=${notes.actionItems.length} decisions=${notes.decisions.length}`,
    );
  } catch (err) {
    const message = formatMeetingLlmError(err, llmProvider, notesModel);
    const latest = await store.getMeta(id);
    if (latest) {
      await saveNotesMeta(store, latest, {
        notesStatus: "failed",
        notesError: message,
      });
    }
    console.error(`[notes] failed user=${userId} id=${id} error=${message}`);
  }
}

async function saveNotesMeta(
  store: RecordingStore,
  meta: RecordingMeta,
  patch: Pick<RecordingMeta, "notesStatus" | "notesError">,
): Promise<void> {
  await store.saveMeta({ ...meta, ...patch });
}
