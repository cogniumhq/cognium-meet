import type { RecordingMeta } from "@cognium/meet-shared";
import {
  DEFAULT_DELETE_AUDIO_AFTER_TRANSCRIPTION,
  DEFAULT_MEETING_LLM_MODEL,
  DEFAULT_MEETING_LLM_PROVIDER,
  DEFAULT_MEETING_NOTES_ENABLED,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_URL,
  parseBooleanSetting,
  parseMaxUploadMb,
  parseMeetingLlmProvider,
  type MeetingLlmProvider,
} from "@cognium/meet-shared";

export interface ClientMeetingSettings {
  meetingLlmProvider: MeetingLlmProvider;
  meetingNotesEnabled: boolean;
  meetingLlmModel: string;
  ollamaUrl: string;
  ollamaModel: string;
  deleteAudioAfterTranscription: boolean;
  maxUploadMb: number;
}

export function parseClientMeetingSettings(
  source: Record<string, unknown>,
): ClientMeetingSettings {
  return {
    meetingLlmProvider: parseMeetingLlmProvider(source.meetingLlmProvider),
    meetingNotesEnabled: parseBooleanSetting(
      source.meetingNotesEnabled,
      DEFAULT_MEETING_NOTES_ENABLED,
    ),
    meetingLlmModel:
      typeof source.meetingLlmModel === "string" && source.meetingLlmModel.trim()
        ? source.meetingLlmModel.trim()
        : DEFAULT_MEETING_LLM_MODEL,
    ollamaUrl:
      typeof source.ollamaUrl === "string" && source.ollamaUrl.trim()
        ? source.ollamaUrl.trim()
        : DEFAULT_OLLAMA_URL,
    ollamaModel:
      typeof source.ollamaModel === "string" && source.ollamaModel.trim()
        ? source.ollamaModel.trim()
        : DEFAULT_OLLAMA_MODEL,
    deleteAudioAfterTranscription: parseBooleanSetting(
      source.deleteAudioAfterTranscription,
      DEFAULT_DELETE_AUDIO_AFTER_TRANSCRIPTION,
    ),
    maxUploadMb: parseMaxUploadMb(source.maxUploadMb),
  };
}

export function clientSettingsToRecordingFields(
  settings: ClientMeetingSettings,
): Pick<
  RecordingMeta,
  | "meetingLlmProvider"
  | "meetingNotesEnabled"
  | "meetingLlmModel"
  | "ollamaUrl"
  | "ollamaModel"
  | "deleteAudioAfterTranscription"
> {
  return {
    meetingLlmProvider: settings.meetingLlmProvider,
    meetingNotesEnabled: settings.meetingNotesEnabled,
    meetingLlmModel: settings.meetingLlmModel,
    ollamaUrl: settings.ollamaUrl,
    ollamaModel: settings.ollamaModel,
    deleteAudioAfterTranscription: settings.deleteAudioAfterTranscription,
  };
}

export function recordingMeetingSettings(meta: RecordingMeta): ClientMeetingSettings {
  return parseClientMeetingSettings({
    meetingLlmProvider: meta.meetingLlmProvider ?? DEFAULT_MEETING_LLM_PROVIDER,
    meetingNotesEnabled: meta.meetingNotesEnabled,
    meetingLlmModel: meta.meetingLlmModel,
    ollamaUrl: meta.ollamaUrl,
    ollamaModel: meta.ollamaModel,
    deleteAudioAfterTranscription: meta.deleteAudioAfterTranscription,
  });
}
