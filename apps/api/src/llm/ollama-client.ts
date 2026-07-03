import { normalizeOllamaUrl } from "./create-meeting-llm.js";

export function ollamaBaseUrl(url: string): string {
  return normalizeOllamaUrl(url).replace(/\/v1$/, "");
}

export async function listOllamaModels(url: string): Promise<string[]> {
  const base = ollamaBaseUrl(url);
  const response = await fetch(`${base}/api/tags`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error(`Ollama unreachable at ${base} (${response.status})`);
  }
  const data = (await response.json()) as { models?: Array<{ name?: string }> };
  return (data.models ?? [])
    .map((m) => m.name?.trim())
    .filter((name): name is string => Boolean(name));
}

/** True when `requested` matches an installed tag (e.g. mistral → mistral:latest). */
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

export async function ensureOllamaModelAvailable(
  url: string,
  model: string,
): Promise<void> {
  let installed: string[];
  try {
    installed = await listOllamaModels(url);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cannot reach Ollama at ${ollamaBaseUrl(url)}. Is it running? ${detail}`,
    );
  }

  if (isOllamaModelInstalled(installed, model)) {
    return;
  }

  const sample = installed.slice(0, 5).join(", ");
  const suffix = installed.length
    ? ` Installed models: ${sample}${installed.length > 5 ? ", …" : ""}.`
    : " No models are installed yet.";
  throw new Error(
    `Ollama model "${model}" is not installed. Run \`ollama pull ${model}\` or choose another model in extension Settings.${suffix}`,
  );
}
