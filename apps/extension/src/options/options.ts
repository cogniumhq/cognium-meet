import { getSettings, saveSettings } from "../lib/storage.js";

const form = document.getElementById("settings-form") as HTMLFormElement;
const apiUrlInput = document.getElementById("api-url") as HTMLInputElement;
const apiTokenInput = document.getElementById("api-token") as HTMLInputElement;
const saveStatus = document.getElementById("save-status") as HTMLParagraphElement;

void init();

async function init(): Promise<void> {
  const settings = await getSettings();
  apiUrlInput.value = settings.apiUrl;
  apiTokenInput.value = settings.apiToken;

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void save();
  });
}

async function save(): Promise<void> {
  await saveSettings({
    apiUrl: apiUrlInput.value.replace(/\/$/, ""),
    apiToken: apiTokenInput.value,
  });

  saveStatus.textContent = "Settings saved.";
  saveStatus.classList.remove("hidden");
  setTimeout(() => saveStatus.classList.add("hidden"), 2500);
}
