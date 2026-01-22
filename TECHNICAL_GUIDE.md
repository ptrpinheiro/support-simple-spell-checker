# Lightweight Inline Spell Checking Chrome Extension (Embedded AI)

This guide describes how to build a lightweight, memory- and CPU-efficient Chrome extension that performs inline spell checking across arbitrary websites using an embedded AI model (no server calls). It assumes familiarity with Chrome extension APIs, WebAssembly, and modern front-end tooling.

## 1) Embedded AI Model: Selection and On-Device Runtime

### 1.1 Requirements for an Embedded Spell-Checking Model

A suitable embedded model should be:

- **Small footprint**: ideally <5–10 MB after compression/quantization.
- **Fast inference**: sub-10 ms per short token window for responsive UI.
- **Deterministic and stable**: avoid large generative models that can be unpredictable.
- **Token-level scoring**: able to rank candidate corrections for a word or phrase.
- **CPU-friendly**: WebAssembly or WebGPU-compatible runtime.

### 1.2 Recommended Model Types

1. **Character-level language models (LMs)**
   - Good for edit-distance-like scoring and ranking candidates.
   - Fast and small; ideal for edge inference.

2. **Masked language models (small)**
   - Provide context-sensitive corrections (“their” vs “there”).
   - Use a tiny transformer (distilled, quantized).

3. **Finite-state or neural hybrid**
   - Use a dictionary + language model scoring. The dictionary provides candidate generation; the LM ranks candidates using context.

### 1.3 Practical Model Recommendations

- **English-only**
  - **Compact character LM** (custom-trained, ~1–3 MB). Best for size and speed.
  - **Tiny masked LM** (distilled/quantized, ~5–10 MB). Better context sensitivity.

- **Multi-language (bonus)**
  - **Multilingual tiny transformer** (quantized) covering common European languages.
  - **Language-agnostic character LM** trained on mixed corpora for script-level support (Latin-centric). Keep separate per-script dictionaries.

### 1.4 Embedding and Running the Model

Use **WebAssembly** or **WebGPU** depending on your model size and expected performance:

- **WASM**: most compatible, good for <10 MB models.
- **WebGPU**: faster for larger models, but more complex and newer.

**Suggested approach:**

- Convert the model to **ONNX**.
- Use **onnxruntime-web** with WASM.
- Quantize to **int8** or **float16**.

**Example (pseudocode) model loader in a service worker or offscreen document:**

```js
import * as ort from 'onnxruntime-web';

let session;

export async function loadModel() {
  if (session) return session;
  session = await ort.InferenceSession.create('model.onnx', {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all'
  });
  return session;
}

export async function scoreCandidates(token, contextWindow, candidates) {
  const input = encode(token, contextWindow, candidates);
  const output = await session.run(input);
  return decodeScores(output);
}
```

## 2) Architecture Overview (Chrome Extension)

### 2.1 Core Components

- **Content script**: injects the spell checker into the page, monitors editable fields, renders UI.
- **Service worker**: manages model lifecycle and shared inference.
- **Offscreen document (optional)**: keeps model loaded without blocking service worker sleep.

### 2.2 Recommended Architecture

1. Content script detects text edits and sends token + context to background.
2. Background runs model inference and returns candidate corrections.
3. Content script renders inline suggestions.

**Key benefits:**

- Keeps heavy model out of the page context.
- Allows shared model across tabs.

## 3) Inline Spell Checking Strategy

### 3.1 Input Monitoring

Use `input`, `keyup`, and `selectionchange` events to track edits in:

- `contenteditable` elements
- `<input>` and `<textarea>`
- Rich-text editors (identify by role or known selectors)

**Example (content script):**

```js
document.addEventListener('input', (e) => {
  const target = e.target;
  if (!isEditable(target)) return;
  const { token, context } = extractTokenAndContext(target);
  chrome.runtime.sendMessage({ type: 'CHECK', token, context });
});
```

### 3.2 Inline UI and Suggestions

- Overlay a lightweight suggestion bubble near the caret.
- Provide keyboard navigation (Tab/Arrow/Enter) for accepted corrections.
- Avoid altering DOM structure when possible (use overlays rather than inline spans).

**Suggestion rendering tips:**

- Use a single shadow DOM root for UI isolation.
- Position using `getClientRects()` from selection ranges.
- Debounce updates (e.g., 150–250 ms) to avoid flicker.

## 4) Performance Optimization Tips

### 4.1 Model and Inference

- **Quantize** to int8 or float16.
- **Limit context** to a small window (e.g., ±20–50 chars).
- **Cache frequent results** (LRU for token+context pairs).
- **Batch requests** when user pauses typing.

### 4.2 Content Script Efficiency

- Throttle input listeners.
- Avoid expensive DOM traversal on every keystroke.
- Maintain a small set of tracked editable nodes.

### 4.3 CPU and Memory

- Keep model in shared memory (background/offscreen).
- Unload the model when idle for long periods.
- Avoid full-document scanning; only analyze active fields.

## 5) Model Selection Criteria and Comparison

| Criterion | Character LM | Tiny Masked LM | Hybrid (Dict + LM) |
|----------|---------------|----------------|---------------------|
| Size | ★★★★★ | ★★★ | ★★★★ |
| Speed | ★★★★★ | ★★★ | ★★★★ |
| Context Sensitivity | ★★ | ★★★★★ | ★★★★ |
| Multilingual Support | ★★★ | ★★★★ | ★★★★ |

**Recommendation:**
- Use a **hybrid dictionary + small LM** for best balance.
- For strict resource limits, use **character LM + dictionary**.

## 6) Extension Permissions & Security

### 6.1 Permissions

To access arbitrary websites, you likely need:

```json
{
  "manifest_version": 3,
  "name": "Inline Spell Checker",
  "permissions": ["scripting", "storage"],
  "host_permissions": ["<all_urls>"],
  "background": {"service_worker": "background.js"},
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"]
    }
  ]
}
```

**Notes:**

- Use `<all_urls>` only if necessary. Prefer narrower match patterns for privacy.
- Avoid `unsafe-eval` by using precompiled WASM.

### 6.2 Content Script Isolation

- Use isolated worlds (default) to avoid page interference.
- Communicate via `chrome.runtime.sendMessage` or `chrome.runtime.connect`.

## 7) Inline Integration Best Practices

- Do not modify user text unless they accept a suggestion.
- Preserve undo/redo stacks (use `document.execCommand('insertText')` or the editor’s APIs).
- Respect page-specific inputs (e.g., Gmail, Google Docs) by detecting rich editors and using their APIs.
- Provide a toggle UI to disable spell checking per site.

## 8) Example Flow: End-to-End

1. User types in a textarea.
2. Content script extracts current token + context.
3. Background model scores candidates.
4. Content script shows suggestion popup.
5. User accepts correction, content script inserts change.

**Minimal message handling pseudocode:**

```js
// background.js
chrome.runtime.onMessage.addListener(async (msg, sender, sendResponse) => {
  if (msg.type !== 'CHECK') return;
  const session = await loadModel();
  const suggestions = await scoreCandidates(msg.token, msg.context, msg.candidates);
  sendResponse({ suggestions });
  return true; // keep channel open
});
```

## 9) Packaging and Deployment Tips

- Bundle with a modern bundler (esbuild/rollup).
- Preload model files via `web_accessible_resources`.
- Enable `wasm` in CSP if required (`'wasm-unsafe-eval'` in MV3 if needed).

---

### Final Notes

A lightweight inline spell checker should emphasize **low-latency inference**, **minimal UI overhead**, and **safe DOM integration**. A hybrid dictionary + small LM approach offers the best balance of quality and performance for most production extensions.
