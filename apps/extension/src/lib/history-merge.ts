import type { StoredRecording } from "./storage.js";

/**
 * Max number of server-only entries kept in local history. Entries that exist only on
 * this device (saved / upload failed / in-flight, or anything with local audio) are never
 * evicted by this cap — dropping them would hide recordings that are nowhere else.
 */
export const MAX_SERVER_HISTORY_ENTRIES = 50;

/** Statuses whose entry may not (yet) be on the server and must survive merges. */
const LOCAL_OR_IN_FLIGHT_STATUSES = new Set(["saved", "upload_failed", "uploading", "processing"]);

/** True when an entry must never be dropped from history by a merge or cap. */
export function isProtectedHistoryEntry(item: StoredRecording): boolean {
  return Boolean(item.localAudioId) || LOCAL_OR_IN_FLIGHT_STATUSES.has(item.status);
}

function startedAtMs(item: StoredRecording): number {
  const ms = Date.parse(item.startedAt);
  return Number.isFinite(ms) ? ms : 0;
}

/** Newest first; stable for equal timestamps. */
export function sortHistory(history: StoredRecording[]): StoredRecording[] {
  return history
    .map((item, index) => ({ item, index }))
    .sort((a, b) => startedAtMs(b.item) - startedAtMs(a.item) || a.index - b.index)
    .map(({ item }) => item);
}

/** Keeps the first occurrence of each id. */
export function dedupeHistory(history: StoredRecording[]): StoredRecording[] {
  const seen = new Set<string>();
  return history.filter((item) => {
    if (seen.has(item.id)) {
      return false;
    }
    seen.add(item.id);
    return true;
  });
}

/** Caps only unprotected (server-only) entries; protected entries are always kept. */
export function capHistory(
  history: StoredRecording[],
  maxServerEntries = MAX_SERVER_HISTORY_ENTRIES,
): StoredRecording[] {
  let serverCount = 0;
  return history.filter((item) => {
    if (isProtectedHistoryEntry(item)) {
      return true;
    }
    serverCount += 1;
    return serverCount <= maxServerEntries;
  });
}

/** Normalizes a list: de-dupe by id (first wins), newest first, cap server-only entries. */
export function normalizeHistory(
  history: StoredRecording[],
  maxServerEntries = MAX_SERVER_HISTORY_ENTRIES,
): StoredRecording[] {
  return capHistory(sortHistory(dedupeHistory(history)), maxServerEntries);
}

/** Inserts or replaces an entry (by id) without evicting local-only entries. */
export function upsertHistoryEntry(
  history: StoredRecording[],
  entry: StoredRecording,
  maxServerEntries = MAX_SERVER_HISTORY_ENTRIES,
): StoredRecording[] {
  return normalizeHistory([entry, ...history], maxServerEntries);
}

/**
 * Merges the server's recording list into local history.
 * - Server entries win for server-owned fields, but keep the local `localAudioId` link.
 * - Local entries the server does not know about (saved, upload_failed, uploading,
 *   processing, or with local audio) are always kept.
 * - Only server-only entries are capped.
 */
export function mergeServerHistory(
  local: StoredRecording[],
  remote: StoredRecording[],
  maxServerEntries = MAX_SERVER_HISTORY_ENTRIES,
): StoredRecording[] {
  const localById = new Map(local.map((item) => [item.id, item]));
  const remoteIds = new Set(remote.map((item) => item.id));

  const serverEntries = remote.map((item) => {
    const existing = localById.get(item.id);
    return existing?.localAudioId ? { ...item, localAudioId: existing.localAudioId } : item;
  });
  const localOnly = local.filter(
    (item) => !remoteIds.has(item.id) && isProtectedHistoryEntry(item),
  );

  return normalizeHistory([...serverEntries, ...localOnly], maxServerEntries);
}

/** Pending-audio metadata needed to rebuild a history entry (mirrors PendingAudioMeta). */
export interface OrphanAudioInfo {
  id: string;
  meetingTitle?: string;
  startedAt?: string;
  durationMs?: number;
  createdAt?: string;
  hasMicAudio?: boolean;
}

/** Ids of pending-audio records referenced by history (via localAudioId or id). */
export function referencedLocalAudioIds(history: StoredRecording[]): Set<string> {
  const ids = new Set<string>();
  for (const item of history) {
    ids.add(item.id);
    if (item.localAudioId) {
      ids.add(item.localAudioId);
    }
  }
  return ids;
}

/** Tolerance when matching an orphan blob to an uploaded recording by start time. */
const ORPHAN_MATCH_TOLERANCE_MS = 5000;

/**
 * Adds history entries for pending audio that no entry references. Idempotent:
 * already-referenced ids are skipped. An orphan whose start time matches an existing
 * entry without local audio (an upload whose local link was lost) is re-linked to it
 * instead of creating a duplicate; otherwise a `saved` entry is added.
 */
export function addOrphanedAudioToHistory(
  history: StoredRecording[],
  orphans: OrphanAudioInfo[],
  now = new Date(),
): { history: StoredRecording[]; added: number; linked: number } {
  const referenced = referencedLocalAudioIds(history);
  let next = [...history];
  let added = 0;
  let linked = 0;

  for (const orphan of orphans) {
    if (referenced.has(orphan.id)) {
      continue;
    }
    const startedAt = orphan.startedAt ?? orphan.createdAt ?? now.toISOString();
    const orphanStart = Date.parse(startedAt);

    const matchIndex = Number.isFinite(orphanStart)
      ? next.findIndex(
          (item) =>
            !item.localAudioId &&
            !LOCAL_OR_IN_FLIGHT_STATUSES.has(item.status) &&
            Math.abs(startedAtMs(item) - orphanStart) <= ORPHAN_MATCH_TOLERANCE_MS,
        )
      : -1;

    if (matchIndex >= 0) {
      next[matchIndex] = { ...next[matchIndex], localAudioId: orphan.id };
      linked += 1;
    } else {
      next.push({
        id: orphan.id,
        meetingTitle: orphan.meetingTitle,
        startedAt,
        durationMs: orphan.durationMs,
        status: "saved",
        createdAt: orphan.createdAt ?? now.toISOString(),
        localAudioId: orphan.id,
        hasMicAudio: orphan.hasMicAudio,
      });
      added += 1;
    }
    referenced.add(orphan.id);
  }

  if (added === 0 && linked === 0) {
    return { history, added, linked };
  }
  next = normalizeHistory(next);
  return { history: next, added, linked };
}
