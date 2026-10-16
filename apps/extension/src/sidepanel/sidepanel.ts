import { getSettings } from "../lib/storage.js";
import { isMeetingAskEnabled } from "../lib/client-config.js";
import { initAskPanel } from "../lib/ask-panel.js";
import { initTranscriptViewer } from "../lib/transcript-viewer.js";

const askView = document.getElementById("ask-view") as HTMLDivElement;
const askWrap = document.getElementById("meeting-ask-wrap") as HTMLDivElement;
const askDisabled = document.getElementById("ask-disabled") as HTMLParagraphElement;
const transcriptView = document.getElementById("transcript-view") as HTMLDivElement;
const transcriptBackBtn = document.getElementById("transcript-back-btn") as HTMLButtonElement;
const transcriptCopyBtn = document.getElementById("transcript-copy-btn") as HTMLButtonElement;

const transcriptViewer = initTranscriptViewer({
  onCopied: (error) => {
    transcriptCopyBtn.textContent = error ? "Copy failed" : "Copied";
    window.setTimeout(() => {
      transcriptCopyBtn.textContent = "Copy";
    }, 1500);
  },
});

function showAskView(): void {
  transcriptView.classList.add("hidden");
  askView.classList.remove("hidden");
  transcriptViewer.reset();
}

async function applyAskEnabled(): Promise<void> {
  const enabled = isMeetingAskEnabled(await getSettings());
  askWrap.classList.toggle("hidden", !enabled);
  askDisabled.classList.toggle("hidden", enabled);
}

async function init(): Promise<void> {
  transcriptBackBtn.addEventListener("click", () => showAskView());
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === "sync") {
      void applyAskEnabled();
    }
  });
  await applyAskEnabled();
  await initAskPanel({
    onOpenCitation: (item) => {
      askView.classList.add("hidden");
      transcriptView.classList.remove("hidden");
      void transcriptViewer.open(item);
    },
  });
}

void init();
