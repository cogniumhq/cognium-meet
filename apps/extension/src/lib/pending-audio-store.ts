export interface PendingAudioMeta {
  mimeType: string;
  meetingTitle?: string;
  startedAt: string;
  durationMs: number;
  byteLength: number;
  createdAt: string;
}

const DB_NAME = "cognium-meet-pending";
const DB_VERSION = 1;
const STORE = "audio";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
  });
}

interface StoredPending {
  bytes: ArrayBuffer;
  meta: PendingAudioMeta;
}

export async function savePendingAudio(
  id: string,
  bytes: Uint8Array,
  meta: Omit<PendingAudioMeta, "byteLength" | "createdAt">,
): Promise<void> {
  const db = await openDb();
  const payload: StoredPending = {
    bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    meta: {
      ...meta,
      byteLength: bytes.length,
      createdAt: new Date().toISOString(),
    },
  };

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
    tx.objectStore(STORE).put(payload, id);
  });
}

export async function loadPendingAudio(
  id: string,
): Promise<{ bytes: Uint8Array; meta: PendingAudioMeta } | null> {
  const db = await openDb();
  const stored = await new Promise<StoredPending | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).get(id);
    request.onsuccess = () => resolve(request.result as StoredPending | undefined);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
    tx.oncomplete = () => db.close();
  });

  if (!stored) {
    return null;
  }

  return {
    bytes: new Uint8Array(stored.bytes),
    meta: stored.meta,
  };
}

export async function deletePendingAudio(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB delete failed"));
    tx.objectStore(STORE).delete(id);
  });
}

export async function downloadPendingAudio(id: string, filename: string): Promise<void> {
  const pending = await loadPendingAudio(id);
  if (!pending) {
    throw new Error("Local recording not found — it may have been uploaded or cleared");
  }

  const blob = new Blob([pending.bytes], { type: pending.meta.mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
