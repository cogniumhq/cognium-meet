import { DEFAULT_OLLAMA_URL } from "@cognium/meet-shared";
import { buildApiHeaders, getApiUrl } from "./api-headers.js";

/** List installed Ollama models via the API (avoids browser CORS to Ollama). */
export async function listOllamaModelsFromUrl(
  url: string = DEFAULT_OLLAMA_URL,
): Promise<string[]> {
  const apiUrl = await getApiUrl();
  const headers = await buildApiHeaders();
  const params = new URLSearchParams({
    ollamaUrl: url.trim() || DEFAULT_OLLAMA_URL,
  });
  const response = await fetch(`${apiUrl}/v1/ollama/models?${params}`, { headers });
  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: string };
      detail = body.error ?? "";
    } catch {
      detail = await response.text();
    }
    throw new Error(
      detail || `Failed to list Ollama models (${response.status})`,
    );
  }
  const data = (await response.json()) as { models?: string[] };
  return data.models ?? [];
}

export function isOllamaModelInstalled(
  installed: readonly string[],
  requested: string,
): boolean {
  const req = requested.trim().toLowerCase();
  if (!req) {
    return false;
  }
  return installed.some((name) => {
    const n = name.toLowerCase();
    if (n === req) {
      return true;
    }
    const base = n.split(":")[0];
    return base === req || n.startsWith(`${req}:`);
  });
}

/** Prefer a saved model when installed; otherwise first installed or fallback. */
export function pickOllamaModel(
  installed: readonly string[],
  saved: string | undefined,
  fallback: string,
): string {
  if (saved && isOllamaModelInstalled(installed, saved)) {
    return saved;
  }
  if (installed.length > 0) {
    return installed[0];
  }
  return saved?.trim() || fallback;
}
