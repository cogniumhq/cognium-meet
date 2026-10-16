import type { TranscriptResult, TranscriptSegment } from "@cognium/meet-shared";
import { formatTimestamp, segmentsToPlainText } from "@cognium/meet-shared";
import { fetchTranscript } from "./upload.js";
import type { StoredRecording } from "./storage.js";

/**
 * Transcript viewer shared by the popup and the Ask side panel. Expects the
 * `transcript-*` element ids from the page markup.
 */
export interface TranscriptViewer {
  open(item: StoredRecording, initialQuery?: string): Promise<void>;
  reset(): void;
}

export function initTranscriptViewer(opts: {
  onCopied?: (error?: string) => void;
}): TranscriptViewer {
  const transcriptTitle = document.getElementById("transcript-title") as HTMLHeadingElement;
  const transcriptSearch = document.getElementById("transcript-search") as HTMLInputElement;
  const transcriptCopyBtn = document.getElementById("transcript-copy-btn") as HTMLButtonElement;
  const transcriptBody = document.getElementById("transcript-body") as HTMLDivElement;

  let currentTranscript: TranscriptResult | undefined;

  transcriptSearch.addEventListener("input", () => {
    if (currentTranscript) {
      renderTranscriptSegments(currentTranscript.segments, transcriptSearch.value);
    }
  });
  transcriptCopyBtn.addEventListener("click", () => void copyTranscript());

  function renderTranscriptSegments(segments: TranscriptSegment[], query: string): void {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? segments.filter(
          (seg) =>
            seg.text.toLowerCase().includes(q) ||
            seg.speaker?.toLowerCase().includes(q),
        )
      : segments;

    transcriptBody.innerHTML = "";
    if (filtered.length === 0) {
      const empty = document.createElement("p");
      empty.className = "transcript-empty";
      empty.textContent = q ? "No matches" : "Transcript is empty";
      transcriptBody.appendChild(empty);
      return;
    }

    for (const seg of filtered) {
      const row = document.createElement("div");
      row.className = "transcript-segment";

      const meta = document.createElement("div");
      meta.className = "transcript-segment-meta";
      const speaker = seg.speaker ? ` · ${seg.speaker}` : "";
      meta.textContent = `${formatTimestamp(seg.start)}${speaker}`;

      const text = document.createElement("div");
      text.className = "transcript-segment-text";
      text.innerHTML = highlightText(seg.text.trim(), query);

      row.appendChild(meta);
      row.appendChild(text);
      transcriptBody.appendChild(row);
    }
  }

  async function open(item: StoredRecording, initialQuery = ""): Promise<void> {
    transcriptTitle.textContent = item.meetingTitle ?? "Recording";
    transcriptSearch.value = initialQuery;
    currentTranscript = undefined;
    transcriptBody.innerHTML = "";
    const loading = document.createElement("p");
    loading.className = "transcript-loading";
    loading.textContent = "Loading transcript…";
    transcriptBody.appendChild(loading);
    transcriptCopyBtn.disabled = true;

    try {
      const transcript = await fetchTranscript(item.id);
      currentTranscript = transcript;
      renderTranscriptSegments(transcript.segments, initialQuery);
      transcriptCopyBtn.disabled = false;
    } catch (err) {
      transcriptBody.innerHTML = "";
      const error = document.createElement("p");
      error.className = "transcript-error";
      error.textContent = err instanceof Error ? err.message : String(err);
      transcriptBody.appendChild(error);
    }
  }

  async function copyTranscript(): Promise<void> {
    if (!currentTranscript) {
      return;
    }
    try {
      await navigator.clipboard.writeText(segmentsToPlainText(currentTranscript.segments));
      opts.onCopied?.();
    } catch (err) {
      opts.onCopied?.(err instanceof Error ? err.message : String(err));
    }
  }

  return {
    open,
    reset: () => {
      currentTranscript = undefined;
    },
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function highlightText(text: string, query: string): string {
  const escaped = escapeHtml(text);
  const q = query.trim();
  if (!q) {
    return escaped;
  }
  const pattern = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return escaped.replace(new RegExp(pattern, "gi"), (match) => `<mark>${match}</mark>`);
}
