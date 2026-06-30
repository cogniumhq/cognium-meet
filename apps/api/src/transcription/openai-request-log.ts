import OpenAI from "openai";

export interface OpenAIPartLabel {
  index: number;
  total: number;
}

export function formatAudioBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

type HeaderLike =
  | Headers
  | Record<string, string | string[] | undefined>
  | undefined
  | null;

export function openaiRequestId(headers: HeaderLike): string | undefined {
  if (!headers) {
    return undefined;
  }
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get("x-request-id") ?? undefined;
  }
  if (typeof headers === "object") {
    const record = headers as Record<string, string | string[] | undefined>;
    const value =
      record["x-request-id"] ??
      record["X-Request-Id"] ??
      record["X-REQUEST-ID"];
    if (typeof value === "string") {
      return value;
    }
    if (Array.isArray(value)) {
      return value[0];
    }
  }
  return undefined;
}

function partSuffix(part?: OpenAIPartLabel): string {
  if (!part || part.total <= 1) {
    return "";
  }
  return ` part ${part.index + 1}/${part.total}`;
}

export function logOpenAIRequestStart(opts: {
  model: string;
  bytes: number;
  part?: OpenAIPartLabel;
  audioSeconds?: number;
}): void {
  const duration =
    opts.audioSeconds && opts.audioSeconds > 0
      ? ` ${Math.round(opts.audioSeconds)}s audio`
      : "";
  console.log(
    `[openai] request started model=${opts.model}${partSuffix(opts.part)}` +
      ` file=${formatAudioBytes(opts.bytes)}${duration}`,
  );
}

export function logOpenAIResponse(opts: {
  model: string;
  elapsedMs: number;
  requestId?: string;
  part?: OpenAIPartLabel;
  detail?: string;
}): void {
  const id = opts.requestId ? ` request-id=${opts.requestId}` : "";
  const extra = opts.detail ? ` ${opts.detail}` : "";
  console.log(
    `[openai] response received model=${opts.model}${partSuffix(opts.part)}` +
      ` elapsed=${(opts.elapsedMs / 1000).toFixed(1)}s${id}${extra}`,
  );
}

export function logOpenAIRequestFailed(opts: {
  model: string;
  elapsedMs: number;
  err: unknown;
  part?: OpenAIPartLabel;
}): void {
  const requestId =
    opts.err instanceof OpenAI.APIError
      ? opts.err.request_id ?? openaiRequestId(opts.err.headers)
      : undefined;
  const id = requestId ? ` request-id=${requestId}` : "";
  const message = opts.err instanceof Error ? opts.err.message : String(opts.err);
  console.error(
    `[openai] request failed model=${opts.model}${partSuffix(opts.part)}` +
      ` elapsed=${(opts.elapsedMs / 1000).toFixed(1)}s${id} error=${message}`,
  );
}
