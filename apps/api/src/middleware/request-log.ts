import type { MiddlewareHandler } from "hono";

function recordingIdFromPath(path: string): string | undefined {
  const match = path.match(/^\/v1\/recordings\/([^/]+)/);
  return match?.[1];
}

export function requestLog(): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === "OPTIONS") {
      await next();
      return;
    }

    const started = Date.now();
    const method = c.req.method;
    const path = c.req.path;
    const contentLength = c.req.header("content-length");

    await next();

    const ms = Date.now() - started;
    const status = c.res.status;
    const recordingId = recordingIdFromPath(path);
    const parts = [
      `[api] ${method} ${path}`,
      String(status),
      `${ms}ms`,
    ];
    if (recordingId) {
      parts.push(`recording=${recordingId}`);
    }
    if (contentLength) {
      parts.push(`${contentLength}B`);
    }
    console.log(parts.join(" "));
  };
}
