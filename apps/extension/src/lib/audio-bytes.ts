export function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return blob.arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function normalizeAudioBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }

  if (typeof data === "string") {
    return base64ToBytes(data);
  }

  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (typeof record.audioBase64 === "string") {
      return base64ToBytes(record.audioBase64);
    }

    const numericKeys = Object.keys(record)
      .filter((key) => /^\d+$/.test(key))
      .map((key) => Number.parseInt(key, 10))
      .sort((a, b) => a - b);

    if (numericKeys.length > 0) {
      const bytes = new Uint8Array(numericKeys.length);
      for (let i = 0; i < numericKeys.length; i++) {
        bytes[i] = Number(record[String(numericKeys[i])]);
      }
      return bytes;
    }
  }

  throw new Error("Unsupported audio payload from recorder");
}

export function isLikelyAudio(buffer: Uint8Array): boolean {
  if (buffer.length < 16) {
    return false;
  }

  // Reject accidental "[object Object]" uploads
  if (
    buffer[0] === 0x5b &&
    buffer[1] === 0x6f &&
    buffer[2] === 0x62 &&
    buffer[3] === 0x6a
  ) {
    return false;
  }

  // WebM / Matroska (EBML)
  if (
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  ) {
    return true;
  }

  // Ogg
  if (
    buffer[0] === 0x4f &&
    buffer[1] === 0x67 &&
    buffer[2] === 0x67 &&
    buffer[3] === 0x53
  ) {
    return true;
  }

  // MP3 ID3
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
    return true;
  }

  // MP3 frame sync
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) {
    return true;
  }

  // WAV
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46
  ) {
    return true;
  }

  return false;
}
