export type MessageType =
  | "START_RECORDING"
  | "STOP_RECORDING"
  | "GET_STATUS"
  | "OFFSCREEN_START"
  | "OFFSCREEN_STOP"
  | "OFFSCREEN_READY"
  | "RECORDING_STARTED"
  | "RECORDING_STOPPED"
  | "RECORDING_ERROR";

export const OFFSCREEN_TARGET = "offscreen" as const;

export function isOffscreenMessage(
  message: { type?: string; target?: string },
): boolean {
  return (
    message.target === OFFSCREEN_TARGET ||
    message.type === "OFFSCREEN_START" ||
    message.type === "OFFSCREEN_STOP"
  );
}

export interface RecordingState {
  isRecording: boolean;
  tabId?: number;
  startedAt?: number;
  meetingTitle?: string;
  lastError?: string;
}
