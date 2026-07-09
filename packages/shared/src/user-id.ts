/** Namespace UUID for deterministic Cognium user ids (RFC 4122 name-based). */
export const COGNIUM_USER_ID_NAMESPACE = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Stable UUID v5 derived from a Google email or Chrome profile account key. */
export async function cogniumUserIdFromAccountKey(accountKey: string): Promise<string> {
  const normalized = accountKey.trim().toLowerCase();
  if (!normalized) {
    throw new Error("Account key is required");
  }

  const namespaceBytes = uuidToBytes(COGNIUM_USER_ID_NAMESPACE);
  const nameBytes = new TextEncoder().encode(normalized);
  const combined = new Uint8Array(namespaceBytes.length + nameBytes.length);
  combined.set(namespaceBytes);
  combined.set(nameBytes, namespaceBytes.length);

  const hashBuf = await crypto.subtle.digest("SHA-1", combined);
  const hash = new Uint8Array(hashBuf);
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  return bytesToUuid(hash.subarray(0, 16));
}
