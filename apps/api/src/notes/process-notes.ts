import type { RecordingMeta } from "@cognium/meet-shared";
import { RecordingStore } from "../storage/recording-store.js";
import { generateMeetingNotes } from "./generate-meeting-notes.js";

export interface NotesProcessingDeps {
  store: RecordingStore;
  openaiApiKey: string;
  notesModel: string;
  notesEnabled: boolean;
}

const activeNotesJobs = new Set<string>();

export function enqueueMeetingNotes(deps: NotesProcessingDeps, id: string): void {
  if (!deps.notesEnabled) {
    return;
  }
  if (activeNotesJobs.has(id)) {
    return;
  }
  activeNotesJobs.add(id);
  void processMeetingNotes(deps, id).finally(() => {
    activeNotesJobs.delete(id);
  });
}

async function processMeetingNotes(deps: NotesProcessingDeps, id: string): Promise<void> {
  const meta = await deps.store.getMeta(id);
  if (!meta || meta.status !== "completed") {
    return;
  }

  const transcript = await deps.store.readTranscriptJson(id);
  if (!transcript || transcript.segments.length === 0) {
    await saveNotesMeta(deps.store, meta, {
      notesStatus: "failed",
      notesError: "Transcript is empty — cannot generate notes",
    });
    return;
  }

  await saveNotesMeta(deps.store, meta, {
    notesStatus: "processing",
    notesError: undefined,
  });

  console.log(`[notes] started id=${id} model=${deps.notesModel}`);

  try {
    const notes = await generateMeetingNotes({
      apiKey: deps.openaiApiKey,
      model: deps.notesModel,
      recordingId: id,
      meetingTitle: meta.meetingTitle,
      transcript,
    });

    await deps.store.saveMeetingNotes(id, notes);

    const latest = await deps.store.getMeta(id);
    if (!latest) {
      return;
    }

    await saveNotesMeta(deps.store, latest, {
      notesStatus: "completed",
      notesError: undefined,
    });

    console.log(
      `[notes] completed id=${id} actions=${notes.actionItems.length} decisions=${notes.decisions.length}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const latest = await deps.store.getMeta(id);
    if (latest) {
      await saveNotesMeta(deps.store, latest, {
        notesStatus: "failed",
        notesError: message,
      });
    }
    console.error(`[notes] failed id=${id} error=${message}`);
  }
}

async function saveNotesMeta(
  store: RecordingStore,
  meta: RecordingMeta,
  patch: Pick<RecordingMeta, "notesStatus" | "notesError">,
): Promise<void> {
  await store.saveMeta({ ...meta, ...patch });
}
