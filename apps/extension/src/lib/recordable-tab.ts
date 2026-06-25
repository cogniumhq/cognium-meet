const BLOCKED_URL_PREFIXES = [
  "chrome://",
  "chrome-extension://",
  "edge://",
  "about:",
  "devtools://",
  "view-source:",
];

export function isRecordableTabUrl(url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  if (BLOCKED_URL_PREFIXES.some((prefix) => url.startsWith(prefix))) {
    return false;
  }
  return url.startsWith("http://") || url.startsWith("https://");
}

export function tabRecordingTitle(tab: {
  title?: string;
  url?: string;
}): string {
  const title = tab.title?.trim();
  if (title) {
    return title;
  }
  if (tab.url) {
    try {
      return new URL(tab.url).hostname;
    } catch {
      // ignore invalid URL
    }
  }
  return "Tab recording";
}
