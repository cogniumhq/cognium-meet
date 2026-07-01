import type { RecordingMeta } from "@cognium/meet-shared";
import type { RecordingStore } from "../storage/recording-store.js";
import type { UserStoreRegistry } from "../storage/user-store-registry.js";
import { generateMeetingNotes } from "./generate-meeting-notes.js";

export interface NotesProcessingDeps {
  userRegistry: UserStoreRegistry;
  openaiApiKey: string;
  notesModel: string;
  notesEnabled: boolean;
}

const activeNotesJobs = new Set<string>();

function notesJobKey(userId: string, id: string): string {
  return `${userId}:${id}`;
}

export function enqueueMeetingNotes(
  deps: NotesProcessingDeps,
  userId: string,
  id: string,
): void {
  if (!deps.notesEnabled) {
    return;
  }
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

  console.log(`[notes] started user=${userId} id=${id} model=${deps.notesModel}`);

  try {
    const notes = await generateMeetingNotes({
      apiKey: deps.openaiApiKey,
      model: deps.notesModel,
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
      `[notes] completed user=${userId} id=${id} actions=${notes.actionItems.length} decisions=${notes.decisions.length}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
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
