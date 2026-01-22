const defaultOptions = {
  enabled: true,
  language: "en-US",
  customWords: "",
  allowlist: ""
};

const status = document.getElementById("status");
const form = document.getElementById("options-form");
const enabledInput = document.getElementById("enabled");
const languageInput = document.getElementById("language");
const customWordsInput = document.getElementById("customWords");
const allowlistInput = document.getElementById("allowlist");

const showStatus = (message) => {
  status.textContent = message;
  window.clearTimeout(showStatus.timeoutId);
  showStatus.timeoutId = window.setTimeout(() => {
    status.textContent = "";
  }, 2000);
};

const restoreOptions = async () => {
  const stored = await chrome.storage.sync.get(defaultOptions);
  enabledInput.checked = stored.enabled;
  languageInput.value = stored.language;
  customWordsInput.value = stored.customWords;
  allowlistInput.value = stored.allowlist;
};

const saveOptions = async (event) => {
  event.preventDefault();

  await chrome.storage.sync.set({
    enabled: enabledInput.checked,
    language: languageInput.value,
    customWords: customWordsInput.value.trim(),
    allowlist: allowlistInput.value.trim()
  });

  showStatus("Options saved!");
};

document.addEventListener("DOMContentLoaded", restoreOptions);
form.addEventListener("submit", saveOptions);
