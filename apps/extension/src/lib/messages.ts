export type MessageType =
  | "START_RECORDING"
  | "STOP_RECORDING"
  | "GET_STATUS"
  | "OFFSCREEN_START"
  | "OFFSCREEN_STOP"
  | "OFFSCREEN_ABORT"
  | "OFFSCREEN_STATUS"
  | "OFFSCREEN_LIST_DEVICES"
  | "OFFSCREEN_DEVICES"
  | "OFFSCREEN_READY"
  | "RECORDING_STARTED"
  | "RECORDING_STOPPED"
  | "RECORDING_ERROR";

export const OFFSCREEN_TARGET = "offscreen" as const;

const OFFSCREEN_TYPES = new Set([
  "OFFSCREEN_START",
  "OFFSCREEN_STOP",
  "OFFSCREEN_ABORT",
  "OFFSCREEN_STATUS",
  "OFFSCREEN_LIST_DEVICES",
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
