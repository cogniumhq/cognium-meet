import { COGNIUM_USER_ID_HEADER, OPENAI_API_KEY_HEADER } from "@cognium/meet-shared";
import { getOrCreateUserId, getOpenAiApiKey, getSettings } from "./storage.js";

export async function buildApiHeaders(
  extra?: Record<string, string>,
): Promise<Record<string, string>> {
  const [settings, userId, openaiApiKey] = await Promise.all([
    getSettings(),
    getOrCreateUserId(),
    getOpenAiApiKey(),
  ]);
  const headers: Record<string, string> = {
    [COGNIUM_USER_ID_HEADER]: userId,
    ...extra,
  };
  if (settings.apiToken) {
    headers.Authorization = `Bearer ${settings.apiToken}`;
  }
  if (openaiApiKey) {
    headers[OPENAI_API_KEY_HEADER] = openaiApiKey;
  }
  return headers;
}

export async function getApiUrl(): Promise<string> {
  const settings = await getSettings();
  return settings.apiUrl;
}
