chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

const defaultOptions = {
  enabled: true,
  language: 'en-US',
  customWords: '',
  allowlist: ''
};

const modelCache = new Map();
let currentOptions = { ...defaultOptions };

function getModelUrl(language) {
  if (language === 'pt-PT') {
    return chrome.runtime.getURL('models/pt.json');
  }
  return chrome.runtime.getURL('models/model.json');
}

async function loadModel(language) {
  const modelUrl = getModelUrl(language);
  if (!modelCache.has(modelUrl)) {
    const modelPromise = fetch(modelUrl)
      .then((response) => response.json())
      .then((data) => {
        return {
          dictionary: new Set(data.dictionary.map((word) => word.toLowerCase())),
          frequencies: data.frequencies ?? {},
          bigramScores: data.bigramScores ?? {}
        };
      });
    modelCache.set(modelUrl, modelPromise);
  }
  return modelCache.get(modelUrl);
}

function parseCustomWords(customWords) {
  return new Set(
    customWords
      .split(',')
      .map((word) => word.trim().toLowerCase())
      .filter(Boolean)
  );
}

function isAllowlisted(url, allowlist) {
  if (!url) return true;
  if (!allowlist) return true;
  let hostname = '';
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  const entries = allowlist
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) return true;
  return entries.some((entry) => hostname === entry || hostname.endsWith(`.${entry}`));
}

async function loadOptions() {
  const stored = await chrome.storage.sync.get(defaultOptions);
  currentOptions = { ...defaultOptions, ...stored };
  return currentOptions;
}

async function updateBadgeForTab(tabId, url) {
  const options = currentOptions;
  const isActive = options.enabled && isAllowlisted(url, options.allowlist);
  await chrome.action.setBadgeText({ tabId, text: isActive ? 'ON' : '' });
  if (isActive) {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#10b981' });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  loadOptions().then(async () => {
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs.map((tab) => updateBadgeForTab(tab.id, tab.url))
    );
  });
});

chrome.runtime.onStartup.addListener(() => {
  loadOptions().then(async () => {
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs.map((tab) => updateBadgeForTab(tab.id, tab.url))
    );
  });
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId);
  await updateBadgeForTab(tabId, tab.url);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    updateBadgeForTab(tabId, tab.url);
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') return;
  Object.keys(changes).forEach((key) => {
    currentOptions[key] = changes[key].newValue;
  });
  chrome.tabs.query({}).then((tabs) => {
    tabs.forEach((tab) => updateBadgeForTab(tab.id, tab.url));
  });
});

loadOptions();

function scoreWord(word, bigramScores) {
  const normalized = word.toLowerCase();
  if (normalized.length < 2) return 0;
  let score = 0;
  for (let i = 0; i < normalized.length - 1; i += 1) {
    const bigram = normalized.slice(i, i + 2);
    score += bigramScores[bigram] ?? -1.5;
  }
  return score;
}

function editDistanceOne(word) {
  const letters = 'abcdefghijklmnopqrstuvwxyzáàâãäéêëíïóôõöúüç';
  const splits = [];
  for (let i = 0; i <= word.length; i += 1) {
    splits.push([word.slice(0, i), word.slice(i)]);
  }
  const deletes = splits
    .filter(([, right]) => right)
    .map(([left, right]) => `${left}${right.slice(1)}`);
  const transposes = splits
    .filter(([, right]) => right.length > 1)
    .map(([left, right]) => `${left}${right[1]}${right[0]}${right.slice(2)}`);
  const replaces = splits
    .filter(([, right]) => right)
    .flatMap(([left, right]) =>
      letters.split('').map((char) => `${left}${char}${right.slice(1)}`)
    );
  const inserts = splits.flatMap(([left, right]) =>
    letters.split('').map((char) => `${left}${char}${right}`)
  );
  return new Set([...deletes, ...transposes, ...replaces, ...inserts]);
}

function rankCandidates(token, candidates, model, customWords) {
  const scored = [];
  for (const candidate of candidates) {
    const isKnown = model.dictionary.has(candidate) || customWords.has(candidate);
    if (!isKnown) continue;
    const frequency = model.frequencies[candidate] ?? 1;
    const score = scoreWord(candidate, model.bigramScores);
    scored.push({ candidate, score: score + Math.log(frequency) });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((entry) => entry.candidate);
}

async function suggestCorrections(token) {
  const options = currentOptions.enabled ? currentOptions : await loadOptions();
  if (!options.enabled) {
    return { isCorrect: true, suggestions: [] };
  }
  const model = await loadModel(options.language);
  const normalized = token.toLowerCase();
  const customWords = parseCustomWords(options.customWords);
  if (!normalized || model.dictionary.has(normalized) || customWords.has(normalized)) {
    return { isCorrect: true, suggestions: [] };
  }
  const candidates = editDistanceOne(normalized);
  const suggestions = rankCandidates(normalized, candidates, model, customWords);
  return { isCorrect: suggestions.length === 0, suggestions };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'SPELLCHECK') return false;
  suggestCorrections(message.token)
    .then((result) => {
      sendResponse({
        token: message.token,
        ...result
      });
    })
    .catch(() => sendResponse({ token: message.token, isCorrect: true, suggestions: [] }));
  return true;
});
