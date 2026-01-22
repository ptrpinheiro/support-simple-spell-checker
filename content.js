const debounce = (fn, delay) => {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
};

const suggestionState = {
  activeElement: null,
  range: null,
  word: null,
  suggestions: []
};

const defaultOptions = {
  enabled: true,
  language: 'en-US',
  customWords: '',
  allowlist: ''
};

let currentOptions = { ...defaultOptions };

const uiRoot = document.createElement('div');
const shadow = uiRoot.attachShadow({ mode: 'open' });
const bubble = document.createElement('div');
const style = document.createElement('style');

style.textContent = `
  .bubble {
    position: fixed;
    z-index: 2147483647;
    background: #111827;
    color: #f9fafb;
    padding: 6px 10px;
    border-radius: 6px;
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.2);
    font-size: 12px;
    display: none;
    max-width: 240px;
    flex-wrap: wrap;
    gap: 6px;
  }
  .bubble button {
    background: transparent;
    border: none;
    color: inherit;
    cursor: pointer;
    margin: 0;
    padding: 0;
    font: inherit;
  }
  .bubble button:hover {
    text-decoration: underline;
  }
`;

bubble.className = 'bubble';
shadow.append(style, bubble);
document.documentElement.appendChild(uiRoot);

async function loadOptions() {
  try {
    const stored = await chrome.storage.sync.get(defaultOptions);
    currentOptions = { ...defaultOptions, ...stored };
  } catch {
    currentOptions = { ...defaultOptions };
  }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') return;
  const updated = { ...currentOptions };
  Object.keys(changes).forEach((key) => {
    updated[key] = changes[key].newValue;
  });
  currentOptions = updated;
});

loadOptions();

function isEditable(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  if (target.tagName === 'TEXTAREA') return true;
  if (target.tagName === 'INPUT') {
    return target.type === 'text' || target.type === 'search';
  }
  return false;
}

function isAllowedForHost(hostname, allowlist) {
  if (!allowlist) return true;
  const entries = allowlist
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) return true;
  return entries.some((entry) => hostname === entry || hostname.endsWith(`.${entry}`));
}

function getWordMatch(text, regex) {
  return text.match(regex);
}

function getWordFromInput(target) {
  const position = target.selectionStart ?? 0;
  const value = target.value ?? '';
  const left = value.slice(0, position);
  const right = value.slice(position);
  const leftMatch = getWordMatch(left, /[\p{L}]+$/u);
  const rightMatch = getWordMatch(right, /^[\p{L}]+/u);
  const word = `${leftMatch ? leftMatch[0] : ''}${rightMatch ? rightMatch[0] : ''}`;
  const start = position - (leftMatch ? leftMatch[0].length : 0);
  const end = position + (rightMatch ? rightMatch[0].length : 0);
  return { word, start, end };
}

function getWordFromContentEditable(target) {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!target.contains(range.startContainer)) return null;
  const text = range.startContainer.textContent ?? '';
  const offset = range.startOffset;
  const left = text.slice(0, offset);
  const right = text.slice(offset);
  const leftMatch = getWordMatch(left, /[\p{L}]+$/u);
  const rightMatch = getWordMatch(right, /^[\p{L}]+/u);
  const word = `${leftMatch ? leftMatch[0] : ''}${rightMatch ? rightMatch[0] : ''}`;
  const startOffset = offset - (leftMatch ? leftMatch[0].length : 0);
  const endOffset = offset + (rightMatch ? rightMatch[0].length : 0);
  const wordRange = range.cloneRange();
  wordRange.setStart(range.startContainer, startOffset);
  wordRange.setEnd(range.startContainer, endOffset);
  return { word, range: wordRange };
}

function positionBubble(rect) {
  bubble.style.left = `${rect.left + window.scrollX}px`;
  bubble.style.top = `${rect.bottom + window.scrollY + 6}px`;
}

function hideBubble() {
  bubble.style.display = 'none';
  bubble.textContent = '';
}

function showSuggestions(rect, suggestions) {
  bubble.innerHTML = '';
  suggestions.forEach((suggestion) => {
    const button = document.createElement('button');
    button.textContent = suggestion;
    button.addEventListener('click', () => applySuggestion(suggestion));
    bubble.appendChild(button);
  });
  bubble.style.display = suggestions.length ? 'flex' : 'none';
  if (rect) positionBubble(rect);
}

function applySuggestion(suggestion) {
  const target = suggestionState.activeElement;
  if (!target) return;
  if (target.isContentEditable && suggestionState.range) {
    const range = suggestionState.range;
    range.deleteContents();
    range.insertNode(document.createTextNode(suggestion));
    hideBubble();
    return;
  }
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
    const { start, end } = suggestionState.range;
    target.setRangeText(suggestion, start, end, 'end');
    hideBubble();
  }
}

function handleSpellcheckResult(result) {
  if (!result || result.isCorrect) {
    hideBubble();
    return;
  }
  suggestionState.suggestions = result.suggestions;
  if (suggestionState.activeElement?.isContentEditable && suggestionState.range) {
    const rect = suggestionState.range.getBoundingClientRect();
    showSuggestions(rect, result.suggestions);
    return;
  }
  if (suggestionState.activeElement) {
    const rect = suggestionState.activeElement.getBoundingClientRect();
    showSuggestions(rect, result.suggestions);
  }
}

const requestSpellcheck = debounce((target) => {
  if (!target) return;
  if (!currentOptions.enabled) {
    hideBubble();
    return;
  }
  if (!isAllowedForHost(window.location.hostname, currentOptions.allowlist)) {
    hideBubble();
    return;
  }
  if (target.isContentEditable) {
    const wordData = getWordFromContentEditable(target);
    if (!wordData || !wordData.word) {
      hideBubble();
      return;
    }
    suggestionState.activeElement = target;
    suggestionState.range = wordData.range;
    suggestionState.word = wordData.word;
    chrome.runtime.sendMessage(
      { type: 'SPELLCHECK', token: wordData.word },
      handleSpellcheckResult
    );
    return;
  }

  const wordData = getWordFromInput(target);
  if (!wordData.word) {
    hideBubble();
    return;
  }
  suggestionState.activeElement = target;
  suggestionState.range = { start: wordData.start, end: wordData.end };
  suggestionState.word = wordData.word;
  chrome.runtime.sendMessage(
    { type: 'SPELLCHECK', token: wordData.word },
    handleSpellcheckResult
  );
}, 200);

function onInput(event) {
  const target = event.target;
  if (!isEditable(target)) return;
  requestSpellcheck(target);
}

document.addEventListener('input', onInput, true);
document.addEventListener('keyup', onInput, true);
document.addEventListener('click', () => hideBubble());
