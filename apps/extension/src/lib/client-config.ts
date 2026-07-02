import type { ExtensionSettings, MeetingAskRequest } from "@cognium/meet-shared";
import {
  DEFAULT_MAX_UPLOAD_MB,
  DEFAULT_MEETING_LLM_MODEL,
  DEFAULT_MEETING_LLM_PROVIDER,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_URL,
  maxUploadBytesFromMb,
} from "@cognium/meet-shared";

export function meetingSettingsFormFields(
  settings: ExtensionSettings,
): Record<string, string> {
  return {
    meetingLlmProvider: settings.meetingLlmProvider ?? DEFAULT_MEETING_LLM_PROVIDER,
    meetingNotesEnabled: String(settings.meetingNotesEnabled !== false),
    meetingLlmModel: settings.meetingLlmModel ?? DEFAULT_MEETING_LLM_MODEL,
    ollamaUrl: settings.ollamaUrl ?? DEFAULT_OLLAMA_URL,
    ollamaModel: settings.ollamaModel ?? DEFAULT_OLLAMA_MODEL,
    deleteAudioAfterTranscription: String(
      settings.deleteAudioAfterTranscription !== false,
    ),
    maxUploadMb: String(settings.maxUploadMb ?? DEFAULT_MAX_UPLOAD_MB),
  };
}

export function meetingAskPayload(settings: ExtensionSettings): Pick<
  MeetingAskRequest,
  "llmProvider" | "meetingLlmModel" | "ollamaUrl" | "ollamaModel"
> {
  return {
    llmProvider: settings.meetingLlmProvider ?? DEFAULT_MEETING_LLM_PROVIDER,
    meetingLlmModel: settings.meetingLlmModel ?? DEFAULT_MEETING_LLM_MODEL,
    ollamaUrl: settings.ollamaUrl ?? DEFAULT_OLLAMA_URL,
    ollamaModel: settings.ollamaModel ?? DEFAULT_OLLAMA_MODEL,
  };
}

export function maxUploadBytesForSettings(settings: ExtensionSettings): number {
  return maxUploadBytesFromMb(settings.maxUploadMb ?? DEFAULT_MAX_UPLOAD_MB);
}

export function isMeetingAskEnabled(settings: ExtensionSettings): boolean {
  return settings.meetingAskEnabled !== false;
}

export function isMeetingNotesEnabled(settings: ExtensionSettings): boolean {
  return settings.meetingNotesEnabled !== false;
}

export function isDeleteAudioAfterTranscription(settings: ExtensionSettings): boolean {
  return settings.deleteAudioAfterTranscription !== false;
}
