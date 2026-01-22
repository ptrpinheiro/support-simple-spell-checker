const MODEL_URL = chrome.runtime.getURL('models/model.json');

let modelPromise;

async function loadModel() {
  if (!modelPromise) {
    modelPromise = fetch(MODEL_URL)
      .then((response) => response.json())
      .then((data) => {
        return {
          dictionary: new Set(data.dictionary.map((word) => word.toLowerCase())),
          frequencies: data.frequencies ?? {},
          bigramScores: data.bigramScores ?? {}
        };
      });
  }
  return modelPromise;
}

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
  const letters = 'abcdefghijklmnopqrstuvwxyz';
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

function rankCandidates(token, candidates, model) {
  const scored = [];
  for (const candidate of candidates) {
    if (!model.dictionary.has(candidate)) continue;
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
  const model = await loadModel();
  const normalized = token.toLowerCase();
  if (!normalized || model.dictionary.has(normalized)) {
    return { isCorrect: true, suggestions: [] };
  }
  const candidates = editDistanceOne(normalized);
  const suggestions = rankCandidates(normalized, candidates, model);
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
