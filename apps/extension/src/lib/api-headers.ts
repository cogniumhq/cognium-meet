import { COGNIUM_USER_ID_HEADER } from "@cognium/meet-shared";
import { getOrCreateUserId, getSettings } from "./storage.js";

export async function buildApiHeaders(
  extra?: Record<string, string>,
): Promise<Record<string, string>> {
  const [settings, userId] = await Promise.all([getSettings(), getOrCreateUserId()]);
  const headers: Record<string, string> = {
    [COGNIUM_USER_ID_HEADER]: userId,
    ...extra,
  };
  if (settings.apiToken) {
    headers.Authorization = `Bearer ${settings.apiToken}`;
  }
  return headers;
}

export async function getApiUrl(): Promise<string> {
  const settings = await getSettings();
  return settings.apiUrl;
}
