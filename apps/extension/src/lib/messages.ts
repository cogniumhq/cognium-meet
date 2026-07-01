export const OFFSCREEN_TARGET = "offscreen" as const;

const OFFSCREEN_TYPES = new Set([
  "OFFSCREEN_START",
  "OFFSCREEN_STOP",
  "OFFSCREEN_FLUSH",
  "OFFSCREEN_ABORT",
  "OFFSCREEN_STATUS",
  "OFFSCREEN_LIST_DEVICES",
  "OFFSCREEN_REQUEST_MIC",
]);

export function isOffscreenMessage(
  message: { type?: string; target?: string },
): boolean {
  return (
    message.target === OFFSCREEN_TARGET ||
    (typeof message.type === "string" && OFFSCREEN_TYPES.has(message.type))
  );
}

export interface RecordingState {
  isRecording: boolean;
  tabId?: number;
  startedAt?: number;
  meetingTitle?: string;
  includedMic?: boolean;
  micLabel?: string;
  lastError?: string;
}
