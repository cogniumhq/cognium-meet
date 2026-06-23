export type MessageType =
  | "START_RECORDING"
  | "STOP_RECORDING"
  | "GET_STATUS"
  | "RECORDING_STARTED"
  | "RECORDING_STOPPED"
  | "RECORDING_ERROR"
  | "OFFSCREEN_START"
  | "OFFSCREEN_STOP"
  | "OFFSCREEN_READY";

export interface RecordingState {
  isRecording: boolean;
  tabId?: number;
  startedAt?: number;
  meetingTitle?: string;
  lastError?: string;
}

export interface StartRecordingMessage {
  type: "START_RECORDING";
  tabId: number;
  meetingTitle?: string;
}

export interface StopRecordingMessage {
  type: "STOP_RECORDING";
}

export interface GetStatusMessage {
  type: "GET_STATUS";
}

export interface OffscreenStartMessage {
  type: "OFFSCREEN_START";
  streamId: string;
}

export interface OffscreenStopMessage {
  type: "OFFSCREEN_STOP";
}

export interface RecordingStartedMessage {
  type: "RECORDING_STARTED";
  startedAt: number;
  meetingTitle?: string;
}

export interface RecordingStoppedMessage {
  type: "RECORDING_STOPPED";
  blob: Blob;
  durationMs: number;
  meetingTitle?: string;
  startedAt: number;
}

export interface RecordingErrorMessage {
  type: "RECORDING_ERROR";
  error: string;
}

export type BackgroundMessage =
  | StartRecordingMessage
  | StopRecordingMessage
  | GetStatusMessage;

export type OffscreenMessage = OffscreenStartMessage | OffscreenStopMessage;

export type BackgroundResponse =
  | RecordingState
  | RecordingStartedMessage
  | RecordingStoppedMessage
  | RecordingErrorMessage
  | { type: "OFFSCREEN_READY" };
