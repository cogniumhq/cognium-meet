const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * Short, human date for lists: "Today, 10:09 AM", "Yesterday, 9:09 AM",
 * "Mon, 9:09 AM" (this week), "Oct 3, 9:09 AM", or "Oct 3, 2025" (older years).
 */
export function formatRelativeDateTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const daysAgo = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);

  if (daysAgo === 0) {
    return `Today, ${time}`;
  }
  if (daysAgo === 1) {
    return `Yesterday, ${time}`;
  }
  if (daysAgo > 1 && daysAgo < 7) {
    return `${date.toLocaleDateString(undefined, { weekday: "short" })}, ${time}`;
  }
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
