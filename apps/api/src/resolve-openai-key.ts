const OPENAI_KEY_REQUIRED =
  "OpenAI API key is required. Add your key in extension Settings or set OPENAI_API_KEY on the server.";

const OPENROUTER_KEY_REQUIRED =
  "OpenRouter API key is required. Add your key in extension Settings (Meeting AI → OpenRouter) or set OPENROUTER_API_KEY on the server.";

export function resolveOpenAiApiKey(opts: {
  requestKey?: string;
  storedKey?: string;
  serverKey?: string;
}): string | undefined {
  const request = opts.requestKey?.trim();
  if (request) {
    return request;
  }
  const stored = opts.storedKey?.trim();
  if (stored) {
    return stored;
  }
  const server = opts.serverKey?.trim();
  return server || undefined;
}

export function requireOpenAiApiKey(opts: {
  requestKey?: string;
  storedKey?: string;
  serverKey?: string;
}): string {
  const key = resolveOpenAiApiKey(opts);
  if (!key) {
    throw new Error(OPENAI_KEY_REQUIRED);
  }
  return key;
}

export function resolveOpenRouterApiKey(opts: {
  requestKey?: string;
  storedKey?: string;
  serverKey?: string;
}): string | undefined {
  return resolveOpenAiApiKey(opts);
}

export function requireOpenRouterApiKey(opts: {
  requestKey?: string;
  storedKey?: string;
  serverKey?: string;
}): string {
  const key = resolveOpenRouterApiKey(opts);
  if (!key) {
    throw new Error(OPENROUTER_KEY_REQUIRED);
  }
  return key;
}
