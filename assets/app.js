"use strict";

const STORAGE_KEY = "summary-html-desk.drafts.v1";
const SETTINGS_KEY = "summary-html-desk.settings.v1";
const DB_NAME = "summary-html-desk";
const DB_VERSION = 1;
const MAX_PROMPT_SOURCE_CHARS = 80000;
const MAX_BINARY_FILE_BYTES = 18 * 1024 * 1024;

const state = {
  drafts: [],
  activeId: null,
  db: null,
  settings: {
    proxyEndpoint: ""
  },
  draftSearch: "",
  activeSourceTab: "text",
  saveTimer: null,
  toastTimer: null,
  volatileFiles: new Map()
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const dom = {
  draftTitleInput: $("#draftTitleInput"),
  draftSelect: $("#draftSelect"),
  draftSearchInput: $("#draftSearchInput"),
  backendEndpointInput: $("#backendEndpointInput"),
  editorPasswordInput: $("#editorPasswordInput"),
  saveBackendButton: $("#saveBackendButton"),
  pullBackendButton: $("#pullBackendButton"),
  pushBackendButton: $("#pushBackendButton"),
  syncStatus: $("#syncStatus"),
  newDraftButton: $("#newDraftButton"),
  deleteDraftButton: $("#deleteDraftButton"),
  exportDraftsButton: $("#exportDraftsButton"),
  importDraftsInput: $("#importDraftsInput"),
  saveStatus: $("#saveStatus"),
  sourceCount: $("#sourceCount"),
  sourceChars: $("#sourceChars"),
  textSourceTitleInput: $("#textSourceTitleInput"),
  textSourceInput: $("#textSourceInput"),
  addTextSourceButton: $("#addTextSourceButton"),
  linkUrlInput: $("#linkUrlInput"),
  linkNotesInput: $("#linkNotesInput"),
  addLinkSourceButton: $("#addLinkSourceButton"),
  fileSourceInput: $("#fileSourceInput"),
  sourceList: $("#sourceList"),
  languageSelect: $("#languageSelect"),
  shapeSelect: $("#shapeSelect"),
  paragraphCountInput: $("#paragraphCountInput"),
  toneSelect: $("#toneSelect"),
  includeLinksCheckbox: $("#includeLinksCheckbox"),
  buildPromptButton: $("#buildPromptButton"),
  copyPromptButton: $("#copyPromptButton"),
  promptOutput: $("#promptOutput"),
  proxyEndpointInput: $("#proxyEndpointInput"),
  saveProxyButton: $("#saveProxyButton"),
  runProxyButton: $("#runProxyButton"),
  llmResultInput: $("#llmResultInput"),
  copyResultButton: $("#copyResultButton"),
  refreshHtmlButton: $("#refreshHtmlButton"),
  copyHtmlButton: $("#copyHtmlButton"),
  downloadHtmlButton: $("#downloadHtmlButton"),
  htmlOutput: $("#htmlOutput"),
  preview: $("#preview"),
  toggleDirectionButton: $("#toggleDirectionButton"),
  toast: $("#toast")
};

function createId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createDraft(title = "Untitled summary") {
  const now = new Date().toISOString();
  return {
    id: createId(),
    title,
    sources: [],
    language: "Hebrew",
    shape: "paragraphs",
    paragraphCount: 3,
    tone: "neutral",
    includeLinks: true,
    prompt: "",
    result: "",
    html: "",
    direction: "auto",
    createdAt: now,
    updatedAt: now
  };
}

function activeDraft() {
  return state.drafts.find((draft) => draft.id === state.activeId) || state.drafts[0];
}

async function loadState() {
  state.db = await openDatabase();
  await migrateLocalStorageDrafts();

  const savedDrafts = await idbGetAll("drafts");
  state.drafts = savedDrafts.map(normalizeDraft).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const savedSettings = await idbGet("settings", "app-settings");
  if (savedSettings?.value && typeof savedSettings.value === "object") {
    state.settings = { ...state.settings, ...savedSettings.value };
  }

  const active = await idbGet("settings", "active-id");
  state.activeId = active?.value || state.drafts[0]?.id || null;

  if (!state.drafts.length) {
    const draft = createDraft("CMS summary");
    state.drafts.push(draft);
    state.activeId = draft.id;
    await saveState();
  }
}

function normalizeDraft(draft) {
  const fresh = createDraft();
  return {
    ...fresh,
    ...draft,
    sources: Array.isArray(draft.sources) ? draft.sources.map(normalizeSource) : []
  };
}

function normalizeSource(source) {
  return {
    id: source.id || createId(),
    type: source.type || "text",
    title: source.title || "Source",
    url: source.url || "",
    text: source.text || "",
    filename: source.filename || "",
    mimeType: source.mimeType || "",
    size: Number(source.size || 0),
    textAvailable: Boolean(source.textAvailable || source.text),
    fileAvailable: Boolean(source.fileAvailable || source.fileStored),
    fileStored: Boolean(source.fileStored),
    remoteFilePath: source.remoteFilePath || "",
    createdAt: source.createdAt || new Date().toISOString()
  };
}

function saveStateSoon() {
  window.clearTimeout(state.saveTimer);
  dom.saveStatus.textContent = "Saving...";
  state.saveTimer = window.setTimeout(() => {
    saveState().catch((error) => {
      console.error("Save failed", error);
      dom.saveStatus.textContent = "Save failed";
      showToast("Could not save to browser database.");
    });
  }, 250);
}

async function saveState() {
  if (!state.db) return;
  await Promise.all([
    ...state.drafts.map((draft) => idbPut("drafts", draftForStorage(draft))),
    idbPut("settings", { key: "active-id", value: state.activeId }),
    idbPut("settings", { key: "app-settings", value: state.settings })
  ]);
  dom.saveStatus.textContent = "Saved to browser database";
}

function draftForStorage(draft) {
  return {
    ...draft,
    sources: draft.sources.map((source) => ({
      ...source,
      fileAvailable: Boolean(source.fileStored),
      fileStored: Boolean(source.fileStored)
    }))
  };
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("drafts")) {
        db.createObjectStore("drafts", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("files")) {
        db.createObjectStore("files", { keyPath: "sourceId" });
      }
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open database."));
  });
}

function idbStore(storeName, mode = "readonly") {
  return state.db.transaction(storeName, mode).objectStore(storeName);
}

function idbGet(storeName, key) {
  return idbRequest(idbStore(storeName).get(key));
}

function idbGetAll(storeName) {
  return idbRequest(idbStore(storeName).getAll());
}

function idbPut(storeName, value) {
  return idbRequest(idbStore(storeName, "readwrite").put(value));
}

function idbDelete(storeName, key) {
  return idbRequest(idbStore(storeName, "readwrite").delete(key));
}

function idbClear(storeName) {
  return idbRequest(idbStore(storeName, "readwrite").clear());
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Database request failed."));
  });
}

async function migrateLocalStorageDrafts() {
  const existing = await idbGetAll("drafts");
  if (existing.length) return;

  try {
    const savedDrafts = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    if (savedDrafts && Array.isArray(savedDrafts.drafts) && savedDrafts.drafts.length) {
      state.drafts = savedDrafts.drafts.map(normalizeDraft);
      state.activeId = savedDrafts.activeId || state.drafts[0].id;
      if (settings && typeof settings === "object") {
        state.settings = { ...state.settings, ...settings };
      }
      await saveState();
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(SETTINGS_KEY);
    }
  } catch (error) {
    console.warn("Could not migrate localStorage drafts", error);
  }
}

function bindEvents() {
  dom.newDraftButton.addEventListener("click", () => {
    const draft = createDraft("CMS summary");
    state.drafts.unshift(draft);
    state.activeId = draft.id;
    render();
    saveStateSoon();
  });

  dom.deleteDraftButton.addEventListener("click", async () => {
    if (state.drafts.length === 1) {
      showToast("Keep at least one draft.");
      return;
    }
    const draft = activeDraft();
    if (!window.confirm(`Delete "${draft.title}"?`)) return;
    await deleteDraftFiles(draft);
    await idbDelete("drafts", draft.id);
    state.drafts = state.drafts.filter((item) => item.id !== draft.id);
    state.activeId = state.drafts[0].id;
    render();
    saveStateSoon();
  });

  dom.draftSelect.addEventListener("change", () => {
    state.activeId = dom.draftSelect.value;
    render();
    saveStateSoon();
  });

  dom.draftSearchInput.addEventListener("input", () => {
    state.draftSearch = dom.draftSearchInput.value.trim().toLowerCase();
    renderDraftSelect();
  });

  dom.draftTitleInput.addEventListener("input", () => {
    const draft = activeDraft();
    draft.title = dom.draftTitleInput.value.trimStart() || "Untitled summary";
    touchDraft(draft);
    renderDraftSelect();
    saveStateSoon();
  });

  dom.exportDraftsButton.addEventListener("click", exportDrafts);
  dom.importDraftsInput.addEventListener("change", importDrafts);
  dom.saveBackendButton.addEventListener("click", saveBackendSettings);
  dom.pullBackendButton.addEventListener("click", pullBackendSync);
  dom.pushBackendButton.addEventListener("click", pushBackendSync);

  $$(".tab-button").forEach((button) => {
    button.addEventListener("click", () => switchSourceTab(button.dataset.sourceTab));
  });

  dom.addTextSourceButton.addEventListener("click", addTextSource);
  dom.addLinkSourceButton.addEventListener("click", addLinkSource);
  dom.fileSourceInput.addEventListener("change", async () => {
    await addFiles(Array.from(dom.fileSourceInput.files || []));
    dom.fileSourceInput.value = "";
  });

  ["dragenter", "dragover"].forEach((eventName) => {
    document.addEventListener(eventName, (event) => {
      event.preventDefault();
    });
  });
  document.addEventListener("drop", async (event) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer?.files || []);
    if (files.length) await addFiles(files);
  });

  [
    dom.languageSelect,
    dom.shapeSelect,
    dom.paragraphCountInput,
    dom.toneSelect,
    dom.includeLinksCheckbox
  ].forEach((control) => control.addEventListener("change", updateDraftOptions));

  dom.buildPromptButton.addEventListener("click", () => {
    updatePrompt();
    showToast("Prompt rebuilt.");
  });
  dom.copyPromptButton.addEventListener("click", () => copyText(dom.promptOutput.value, "Prompt copied."));
  dom.saveProxyButton.addEventListener("click", saveProxyEndpoint);
  dom.runProxyButton.addEventListener("click", runProxySummary);

  dom.llmResultInput.addEventListener("input", () => {
    const draft = activeDraft();
    draft.result = dom.llmResultInput.value;
    touchDraft(draft);
    updateHtml();
    saveStateSoon();
  });

  dom.copyResultButton.addEventListener("click", () => copyText(dom.llmResultInput.value, "Result copied."));
  dom.refreshHtmlButton.addEventListener("click", () => {
    updateHtml();
    showToast("HTML refreshed.");
  });
  dom.copyHtmlButton.addEventListener("click", () => copyText(dom.htmlOutput.value, "HTML copied."));
  dom.downloadHtmlButton.addEventListener("click", downloadHtml);
  dom.toggleDirectionButton.addEventListener("click", togglePreviewDirection);
}

function switchSourceTab(tab) {
  state.activeSourceTab = tab;
  $$(".tab-button").forEach((button) => {
    const active = button.dataset.sourceTab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  $$("[data-source-panel]").forEach((panel) => {
    const active = panel.dataset.sourcePanel === tab;
    panel.hidden = !active;
    panel.classList.toggle("active", active);
  });
}

function updateDraftOptions() {
  const draft = activeDraft();
  draft.language = dom.languageSelect.value;
  draft.shape = dom.shapeSelect.value;
  draft.paragraphCount = clamp(Number(dom.paragraphCountInput.value || 3), 1, 8);
  draft.tone = dom.toneSelect.value;
  draft.includeLinks = dom.includeLinksCheckbox.checked;
  touchDraft(draft);
  updatePrompt();
  saveStateSoon();
}

function touchDraft(draft) {
  draft.updatedAt = new Date().toISOString();
}

function addTextSource() {
  const text = normalizeWhitespace(dom.textSourceInput.value);
  if (!text) {
    showToast("Add source text first.");
    return;
  }
  const title = dom.textSourceTitleInput.value.trim() || deriveTitle(text);
  const draft = activeDraft();
  draft.sources.push({
    id: createId(),
    type: "text",
    title,
    text,
    url: "",
    filename: "",
    mimeType: "text/plain",
    size: text.length,
    textAvailable: true,
    fileAvailable: false,
    createdAt: new Date().toISOString()
  });
  dom.textSourceTitleInput.value = "";
  dom.textSourceInput.value = "";
  touchDraft(draft);
  updatePrompt();
  renderSources();
  saveStateSoon();
}

function addLinkSource() {
  const url = dom.linkUrlInput.value.trim();
  if (!url) {
    showToast("Add a URL first.");
    return;
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    showToast("The URL is not valid.");
    return;
  }
  const notes = normalizeWhitespace(dom.linkNotesInput.value);
  const draft = activeDraft();
  draft.sources.push({
    id: createId(),
    type: "link",
    title: deriveLinkTitle(parsed),
    url: parsed.href,
    text: notes,
    filename: "",
    mimeType: "",
    size: notes.length,
    textAvailable: Boolean(notes),
    fileAvailable: false,
    createdAt: new Date().toISOString()
  });
  dom.linkUrlInput.value = "";
  dom.linkNotesInput.value = "";
  touchDraft(draft);
  updatePrompt();
  renderSources();
  saveStateSoon();
}

async function addFiles(files) {
  if (!files.length) return;
  const draft = activeDraft();

  for (const file of files) {
    const source = {
      id: createId(),
      type: "file",
      title: file.name,
      url: "",
      text: "",
      filename: file.name,
      mimeType: file.type || guessMimeType(file.name),
      size: file.size,
      textAvailable: false,
      fileAvailable: false,
      fileStored: false,
      createdAt: new Date().toISOString()
    };

    try {
      await storeSourceFile(source, file, draft.id);
      source.fileStored = true;
      source.fileAvailable = true;
    } catch (error) {
      console.warn(`Could not store ${file.name}`, error);
      showToast(`Could not store ${file.name}.`);
    }

    if (isTextFile(file)) {
      const text = await file.text();
      source.text = normalizeWhitespace(stripHtmlIfNeeded(text, file.name, file.type));
      source.textAvailable = Boolean(source.text);
    } else if (file.size <= MAX_BINARY_FILE_BYTES) {
      source.fileAvailable = true;
      state.volatileFiles.set(source.id, {
        filename: file.name,
        mimeType: source.mimeType,
        fileData: await fileToDataUrl(file)
      });
    }

    draft.sources.push(source);
  }

  touchDraft(draft);
  updatePrompt();
  renderSources();
  saveStateSoon();
  showToast(`${files.length} file${files.length === 1 ? "" : "s"} added.`);
}

async function removeSource(id) {
  const draft = activeDraft();
  draft.sources = draft.sources.filter((source) => source.id !== id);
  state.volatileFiles.delete(id);
  await idbDelete("files", id);
  touchDraft(draft);
  updatePrompt();
  renderSources();
  saveStateSoon();
}

async function storeSourceFile(source, file, draftId) {
  await idbPut("files", {
    sourceId: source.id,
    draftId,
    filename: file.name,
    mimeType: source.mimeType,
    size: file.size,
    blob: file,
    storedAt: new Date().toISOString()
  });
}

async function getSourceFile(sourceId) {
  return idbGet("files", sourceId);
}

async function deleteDraftFiles(draft) {
  await Promise.all((draft.sources || []).map((source) => idbDelete("files", source.id)));
}

async function downloadSourceFile(source) {
  if (source.type === "link" && source.url) {
    window.open(source.url, "_blank", "noopener");
    return;
  }

  const stored = await getSourceFile(source.id);
  if (stored?.blob) {
    downloadBlob(stored.blob, stored.filename || source.filename || "source-file", stored.mimeType || source.mimeType || "application/octet-stream");
    return;
  }

  if (source.remoteFilePath) {
    if (!backendEndpoint()) {
      showToast("Save a backend endpoint to download the shared origin file.");
      return;
    }
    const item = await backendPost({
      action: "getSourceFile",
      remoteFilePath: source.remoteFilePath
    });
    if (item?.fileData) {
      downloadBlob(
        base64ToBlob(item.fileData, source.mimeType || item.mimeType || guessMimeType(source.filename || item.filename || source.remoteFilePath)),
        source.filename || item.filename || "source-file",
        source.mimeType || item.mimeType || guessMimeType(source.filename || item.filename || source.remoteFilePath)
      );
      return;
    }
  }

  if (!stored?.blob) {
    showToast("Original file is not stored in this browser.");
    return;
  }
}

function render() {
  const draft = activeDraft();
  renderDraftSelect();
  dom.draftTitleInput.value = draft.title;
  dom.draftSearchInput.value = state.draftSearch;
  dom.languageSelect.value = draft.language;
  dom.shapeSelect.value = draft.shape;
  dom.paragraphCountInput.value = draft.paragraphCount;
  dom.toneSelect.value = draft.tone;
  dom.includeLinksCheckbox.checked = draft.includeLinks;
  dom.promptOutput.value = draft.prompt || buildPrompt(draft);
  dom.proxyEndpointInput.value = state.settings.proxyEndpoint || "";
  dom.backendEndpointInput.value = state.settings.proxyEndpoint || "";
  dom.llmResultInput.value = draft.result || "";
  dom.htmlOutput.value = draft.html || "";
  dom.preview.dir = draft.direction || "auto";
  renderSources();
  updateHtml(false);
}

function renderDraftSelect() {
  const currentValue = dom.draftSelect.value;
  const query = state.draftSearch;
  const sortedDrafts = [...state.drafts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const visibleDrafts = query
    ? sortedDrafts.filter((draft) => {
      const haystack = `${draft.title} ${draft.result} ${draft.sources.map((source) => `${source.title} ${source.url}`).join(" ")}`.toLowerCase();
      return haystack.includes(query);
    })
    : sortedDrafts;
  const draftsForOptions = visibleDrafts.some((draft) => draft.id === state.activeId)
    ? visibleDrafts
    : [activeDraft(), ...visibleDrafts.filter((draft) => draft.id !== state.activeId)];

  dom.draftSelect.replaceChildren(
    ...draftsForOptions.map((draft) => {
      const option = document.createElement("option");
      option.value = draft.id;
      option.textContent = `${draft.title || "Untitled summary"} · ${draft.sources.length} sources`;
      return option;
    })
  );
  dom.draftSelect.value = state.activeId || currentValue;
}

function renderSources() {
  const draft = activeDraft();
  const sourceChars = draft.sources.reduce((total, source) => total + (source.text || "").length, 0);
  dom.sourceCount.textContent = String(draft.sources.length);
  dom.sourceChars.textContent = formatCompactNumber(sourceChars);

  if (!draft.sources.length) {
    const empty = document.createElement("div");
    empty.className = "source-item";
    const content = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = "No sources yet";
    const meta = document.createElement("p");
    meta.textContent = "Add text, a link, or a file.";
    content.append(title, meta);
    empty.append(content);
    dom.sourceList.replaceChildren(empty);
    return;
  }

  dom.sourceList.replaceChildren(
    ...draft.sources.map((source) => {
      const item = document.createElement("div");
      item.className = "source-item";

      const content = document.createElement("div");
      const kind = document.createElement("span");
      kind.className = "source-kind";
      kind.textContent = source.type;
      const title = document.createElement("h3");
      title.textContent = source.title || source.filename || source.url || "Source";
      const meta = document.createElement("p");
      meta.textContent = sourceMeta(source);
      content.append(kind, title, meta);

      const actions = document.createElement("div");
      actions.className = "source-actions";

      if (source.url || source.fileStored) {
        const origin = document.createElement("button");
        origin.type = "button";
        origin.className = "icon-button";
        origin.title = source.url ? "Open origin link" : "Download origin file";
        origin.setAttribute("aria-label", origin.title);
        origin.textContent = source.url ? "↗" : "⇩";
        origin.addEventListener("click", () => downloadSourceFile(source));
        actions.append(origin);
      }

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "icon-button danger";
      remove.title = "Remove source";
      remove.setAttribute("aria-label", `Remove ${source.title}`);
      remove.textContent = "×";
      remove.addEventListener("click", () => removeSource(source.id));
      actions.append(remove);

      item.append(content, actions);
      return item;
    })
  );
}

function sourceMeta(source) {
  const pieces = [];
  if (source.url) pieces.push(source.url);
  if (source.filename) pieces.push(formatBytes(source.size));
  if (source.textAvailable) pieces.push(`${formatCompactNumber((source.text || "").length)} chars`);
  if (source.fileStored) pieces.push("origin file stored");
  if (source.remoteFilePath) pieces.push("origin file in GitHub");
  if ((source.fileAvailable || state.volatileFiles.has(source.id)) && !source.fileStored) pieces.push("backend file ready");
  if (!source.textAvailable && !source.fileAvailable && !state.volatileFiles.has(source.id)) {
    if (source.type === "link") {
      pieces.push("document URL only");
    } else if (source.type === "file") {
      pieces.push("re-upload for backend");
    } else {
      pieces.push("no extracted text");
    }
  }
  return pieces.join(" · ");
}

function updatePrompt() {
  const draft = activeDraft();
  draft.prompt = buildPrompt(draft);
  dom.promptOutput.value = draft.prompt;
  touchDraft(draft);
}

function buildPrompt(draft) {
  const language = draft.language === "same" ? "the same language as the strongest source material" : draft.language;
  const shapeMap = {
    paragraphs: `${draft.paragraphCount} concise HTML paragraphs`,
    "heading-paragraphs": "one short <h2> heading followed by concise HTML paragraphs",
    "brief-list": "one short <h2> heading followed by a compact <ul> list"
  };
  const toneMap = {
    neutral: "neutral and factual",
    academic: "careful, evidence-aware, and academic",
    plain: "plain, direct, and readable"
  };

  const instructions = [
    "You are preparing copy for a content management system.",
    `Write in ${language}.`,
    `Use a ${toneMap[draft.tone] || "neutral and factual"} tone.`,
    `Return ${shapeMap[draft.shape] || shapeMap.paragraphs}.`,
    "Return only clean HTML. Allowed tags: <p>, <h2>, <h3>, <ul>, <ol>, <li>, <strong>, <em>, <a>, and <blockquote>.",
    "Do not include Markdown fences, CSS, inline styles, tables, footnotes, or commentary.",
    "Preserve important names, dates, numbers, and causal claims. Do not invent facts.",
    "Most sources and summaries are in Hebrew. Keep Hebrew names, titles, dates, and institutional terms accurate.",
    "If a source is a public document URL, open/read the document before summarizing when your environment allows it.",
    "If a source is only a URL and you cannot access it, say that the URL needs source text rather than guessing.",
    draft.includeLinks ? "Keep useful links as <a href=\"...\">...</a> when they directly support the summary." : "Do not include links unless the URL itself is central to the summary."
  ];

  const sourceText = draft.sources.length ? draft.sources.map(formatSourceForPrompt).join("\n\n") : "No sources have been added yet.";
  const clipped = clipText(sourceText, MAX_PROMPT_SOURCE_CHARS);
  return `${instructions.join("\n")}\n\nSources:\n${clipped}`;
}

function formatSourceForPrompt(source, index) {
  const heading = [`[Source ${index + 1}: ${source.title || "Untitled"}]`];
  if (source.url) heading.push(`URL: ${source.url}`);
  if (source.filename) heading.push(`File: ${source.filename} (${formatBytes(source.size)})`);
  if (source.textAvailable && source.text) {
    return `${heading.join("\n")}\nTEXT:\n${source.text}`;
  }
  if (source.fileAvailable || state.volatileFiles.has(source.id)) {
    return `${heading.join("\n")}\nFILE ATTACHMENT: use the uploaded PDF, Word, or binary document content.`;
  }
  return `${heading.join("\n")}\nTEXT: not available in this browser draft.`;
}

async function runProxySummary() {
  const draft = activeDraft();
  if (!backendEndpoint()) {
    showToast("Save a backend endpoint first.");
    return;
  }
  updatePrompt();
  dom.runProxyButton.disabled = true;
  dom.runProxyButton.querySelector("span:last-child").textContent = "Running";

  try {
    const payload = await backendPost({
      action: "summarize",
      title: draft.title,
      options: {
        language: draft.language,
        shape: draft.shape,
        paragraphCount: draft.paragraphCount,
        tone: draft.tone,
        includeLinks: draft.includeLinks
      },
      prompt: draft.prompt,
      sources: await Promise.all(draft.sources.map(sourceForProxy))
    });

    const text = payload.html || payload.text || "";
    if (!text) throw new Error("Proxy response did not include text.");
    draft.result = text;
    dom.llmResultInput.value = text;
    touchDraft(draft);
    updateHtml();
    saveStateSoon();
    showToast("LLM result added.");
  } catch (error) {
    showToast(error.message || "Proxy request failed.");
  } finally {
    dom.runProxyButton.disabled = false;
    dom.runProxyButton.querySelector("span:last-child").textContent = "Run LLM";
  }
}

async function sourceForProxy(source) {
  const file = state.volatileFiles.get(source.id);
  const stored = source.fileStored ? await getSourceFile(source.id) : null;
  const fileData = file?.fileData || (stored?.blob && stored.blob.size <= MAX_BINARY_FILE_BYTES
    ? await fileToDataUrl(stored.blob)
    : "");
  return {
    id: source.id,
    type: source.type,
    title: source.title,
    url: source.url,
    text: source.text,
    filename: source.filename,
    mimeType: source.mimeType,
    size: source.size,
    remoteFilePath: source.remoteFilePath || "",
    fileData
  };
}

function backendEndpoint() {
  return (dom.backendEndpointInput.value.trim() || state.settings.proxyEndpoint || "").trim();
}

function editorPassword() {
  return dom.editorPasswordInput.value;
}

async function backendPost(payload) {
  const endpoint = backendEndpoint();
  if (!endpoint) throw new Error("Save a backend endpoint first.");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Editor-Password": editorPassword()
    },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Backend returned ${response.status}`);
  }
  return data;
}

async function saveBackendSettings() {
  const endpoint = dom.backendEndpointInput.value.trim();
  if (endpoint) {
    try {
      new URL(endpoint);
    } catch {
      showToast("Backend endpoint URL is not valid.");
      return;
    }
  }
  state.settings.proxyEndpoint = endpoint;
  dom.proxyEndpointInput.value = endpoint;
  await saveState();
  setSyncStatus("Backend endpoint saved. Editor password is not stored.");
  showToast(endpoint ? "Backend endpoint saved." : "Backend endpoint cleared.");
}

async function pushBackendSync() {
  if (!backendEndpoint()) {
    showToast("Save a backend endpoint first.");
    return;
  }

  setSyncBusy(true, "Pushing shared data...");
  try {
    await saveState();
    let uploadedFiles = 0;
    for (const draft of state.drafts) {
      for (const source of draft.sources) {
        if (source.type !== "file" || !source.fileStored) continue;
        const stored = await getSourceFile(source.id);
        if (!stored?.blob) continue;
        const saved = await backendPost({
          action: "saveSourceFile",
          source: sourceForRemoteFile(source),
          fileData: await fileToDataUrl(stored.blob)
        });
        source.remoteFilePath = saved.remoteFilePath || source.remoteFilePath || "";
        uploadedFiles += 1;
      }
      touchDraft(draft);
    }

    const payload = {
      version: 1,
      app: "summary-html-desk",
      updatedAt: new Date().toISOString(),
      drafts: state.drafts.map(draftForRemote)
    };
    await backendPost({
      action: "saveSharedState",
      payload
    });
    await saveState();
    setSyncStatus(`Pushed ${state.drafts.length} summaries and ${uploadedFiles} origin files.`);
    showToast("Shared drafts pushed.");
  } catch (error) {
    setSyncStatus(error.message || "Push failed.");
    showToast(error.message || "Push failed.");
  } finally {
    setSyncBusy(false);
  }
}

async function pullBackendSync() {
  if (!backendEndpoint()) {
    showToast("Save a backend endpoint first.");
    return;
  }

  if (state.drafts.length && !window.confirm("Replace local draft list with the shared backend version? Unsynced local edits may be lost.")) {
    return;
  }

  setSyncBusy(true, "Pulling shared data...");
  try {
    const payload = await backendPost({ action: "loadSharedState" });
    if (!payload || !Array.isArray(payload.drafts)) throw new Error("Shared drafts file is invalid.");

    state.drafts = payload.drafts.map(normalizeDraft).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    state.activeId = state.drafts[0]?.id || null;
    state.volatileFiles.clear();

    await idbClear("drafts");
    await idbClear("files");
    await saveState();
    render();
    setSyncStatus(`Pulled ${state.drafts.length} shared summaries.`);
    showToast("Shared drafts pulled.");
  } catch (error) {
    setSyncStatus(error.message || "Pull failed.");
    showToast(error.message || "Pull failed.");
  } finally {
    setSyncBusy(false);
  }
}

function draftForRemote(draft) {
  return {
    ...draft,
    sources: draft.sources.map((source) => ({
      ...source,
      fileStored: false,
      fileAvailable: Boolean(source.remoteFilePath),
      remoteFilePath: source.remoteFilePath || ""
    }))
  };
}

function sourceForRemoteFile(source) {
  return {
    id: source.id,
    title: source.title,
    filename: source.filename,
    mimeType: source.mimeType,
    size: source.size,
    remoteFilePath: source.remoteFilePath || ""
  };
}

function setSyncBusy(isBusy, message = "") {
  dom.pullBackendButton.disabled = isBusy;
  dom.pushBackendButton.disabled = isBusy;
  dom.saveBackendButton.disabled = isBusy;
  if (message) setSyncStatus(message);
}

function setSyncStatus(message) {
  dom.syncStatus.textContent = message;
}

function updateHtml(shouldSave = true) {
  const draft = activeDraft();
  const html = makeCmsHtml(dom.llmResultInput.value || draft.result || "");
  draft.html = html;
  dom.htmlOutput.value = html;
  dom.preview.innerHTML = html || "<p></p>";
  if (shouldSave) {
    touchDraft(draft);
    saveStateSoon();
  }
}

function makeCmsHtml(input) {
  const cleaned = stripMarkdownFence(input).trim();
  if (!cleaned) return "";
  if (looksLikeHtml(cleaned)) {
    return sanitizeHtml(cleaned);
  }
  return markdownishToHtml(cleaned);
}

function looksLikeHtml(value) {
  return /<(p|h[1-6]|ul|ol|li|blockquote|strong|em|a|br)\b/i.test(value);
}

function sanitizeHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  return Array.from(template.content.childNodes).map(sanitizeNode).join("").trim();
}

function sanitizeNode(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    return escapeHtml(node.textContent || "");
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }

  const tagMap = {
    h1: "h2",
    h2: "h2",
    h3: "h3",
    h4: "h3",
    h5: "h3",
    h6: "h3",
    p: "p",
    ul: "ul",
    ol: "ol",
    li: "li",
    strong: "strong",
    b: "strong",
    em: "em",
    i: "em",
    a: "a",
    blockquote: "blockquote",
    br: "br"
  };
  const tag = tagMap[node.tagName.toLowerCase()];
  const children = Array.from(node.childNodes).map(sanitizeNode).join("");
  if (!tag) return children;
  if (tag === "br") return "<br>";
  if (tag === "a") {
    const href = sanitizeHref(node.getAttribute("href") || "");
    if (!href) return children;
    return `<a href="${escapeAttribute(href)}">${children}</a>`;
  }
  return `<${tag}>${children}</${tag}>`;
}

function markdownishToHtml(text) {
  const blocks = text.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  const html = [];

  for (const block of blocks) {
    const lines = block.split(/\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) continue;

    if (/^#{1,6}\s+/.test(lines[0])) {
      const rawLevel = (lines[0].match(/^#+/) || ["##"])[0].length;
      const tag = rawLevel <= 2 ? "h2" : "h3";
      html.push(`<${tag}>${formatInline(lines[0].replace(/^#{1,6}\s+/, ""))}</${tag}>`);
      continue;
    }

    if (lines.every((line) => /^[-*]\s+/.test(line))) {
      const items = lines.map((line) => `<li>${formatInline(line.replace(/^[-*]\s+/, ""))}</li>`).join("");
      html.push(`<ul>${items}</ul>`);
      continue;
    }

    if (lines.every((line) => /^\d+[.)]\s+/.test(line))) {
      const items = lines.map((line) => `<li>${formatInline(line.replace(/^\d+[.)]\s+/, ""))}</li>`).join("");
      html.push(`<ol>${items}</ol>`);
      continue;
    }

    if (lines.every((line) => /^>\s?/.test(line))) {
      const quote = lines.map((line) => line.replace(/^>\s?/, "")).join(" ");
      html.push(`<blockquote>${formatInline(quote)}</blockquote>`);
      continue;
    }

    html.push(`<p>${formatInline(lines.join(" "))}</p>`);
  }

  return html.join("\n");
}

function formatInline(value) {
  let escaped = escapeHtml(value);
  escaped = escaped.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
    const href = sanitizeHref(url.replace(/&amp;/g, "&"));
    return href ? `<a href="${escapeAttribute(href)}">${label}</a>` : label;
  });
  escaped = escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  escaped = escaped.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return escaped;
}

function stripMarkdownFence(value) {
  return value.replace(/^```(?:html)?\s*/i, "").replace(/\s*```$/i, "");
}

function sanitizeHref(href) {
  const trimmed = href.trim();
  if (!trimmed) return "";
  if (/^(https?:|mailto:|tel:|#|\/)/i.test(trimmed)) return trimmed;
  return "";
}

async function saveProxyEndpoint() {
  const value = dom.proxyEndpointInput.value.trim();
  if (value) {
    try {
      new URL(value);
    } catch {
      showToast("Endpoint URL is not valid.");
      return;
    }
  }
  state.settings.proxyEndpoint = value;
  dom.backendEndpointInput.value = value;
  await saveState();
  showToast(value ? "Endpoint saved." : "Endpoint cleared.");
}

function togglePreviewDirection() {
  const draft = activeDraft();
  const current = dom.preview.dir || "auto";
  const next = current === "auto" ? "rtl" : current === "rtl" ? "ltr" : "auto";
  draft.direction = next;
  dom.preview.dir = next;
  saveStateSoon();
  showToast(`Preview direction: ${next}`);
}

function exportDrafts() {
  const payload = {
    exportedAt: new Date().toISOString(),
    app: "summary-html-desk",
    version: 1,
    drafts: state.drafts
  };
  downloadBlob(
    JSON.stringify(payload, null, 2),
    `summary-html-desk-${new Date().toISOString().slice(0, 10)}.json`,
    "application/json"
  );
}

async function importDrafts() {
  const file = dom.importDraftsInput.files?.[0];
  dom.importDraftsInput.value = "";
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    if (!payload || !Array.isArray(payload.drafts)) throw new Error("Invalid draft export.");
    const imported = payload.drafts.map(importedDraftCopy);
    state.drafts = [...imported, ...state.drafts];
    state.activeId = imported[0]?.id || state.activeId;
    if (!state.activeId) throw new Error("The export did not contain drafts.");
    render();
    saveStateSoon();
    showToast(`${imported.length} draft${imported.length === 1 ? "" : "s"} imported.`);
  } catch (error) {
    showToast(error.message || "Import failed.");
  }
}

function importedDraftCopy(draft) {
  const copy = normalizeDraft({
    ...draft,
    id: createId(),
    title: `${draft.title || "Imported summary"}`
  });
  copy.sources = copy.sources.map((source) => ({
    ...source,
    id: createId(),
    fileAvailable: false,
    fileStored: false
  }));
  touchDraft(copy);
  return copy;
}

function downloadHtml() {
  const draft = activeDraft();
  const html = dom.htmlOutput.value || "";
  const documentHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(draft.title)}</title>
</head>
<body>
${html}
</body>
</html>
`;
  downloadBlob(documentHtml, `${slugify(draft.title)}.html`, "text/html");
}

function downloadBlob(content, filename, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function copyText(text, successMessage) {
  if (!text) {
    showToast("Nothing to copy.");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  showToast(successMessage);
}

function showToast(message) {
  window.clearTimeout(state.toastTimer);
  dom.toast.textContent = message;
  dom.toast.classList.add("visible");
  state.toastTimer = window.setTimeout(() => dom.toast.classList.remove("visible"), 2600);
}

function isTextFile(file) {
  const name = file.name.toLowerCase();
  return (
    file.type.startsWith("text/") ||
    /\.(txt|md|markdown|html|htm|csv|json|xml|yaml|yml|rtf)$/i.test(name)
  );
}

function stripHtmlIfNeeded(text, filename, mimeType) {
  if (!/\.html?$/i.test(filename) && mimeType !== "text/html") return text;
  const template = document.createElement("template");
  template.innerHTML = text;
  return template.content.textContent || "";
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Could not read file."));
    reader.readAsDataURL(file);
  });
}

function blobToBase64(blob) {
  return fileToDataUrl(blob).then((dataUrl) => dataUrl.split(",")[1] || "");
}

function base64ToBlob(content, mimeType) {
  const clean = stripBase64Whitespace(content);
  const binary = atob(clean);
  const chunks = [];
  for (let index = 0; index < binary.length; index += 8192) {
    const slice = binary.slice(index, index + 8192);
    const bytes = new Uint8Array(slice.length);
    for (let byteIndex = 0; byteIndex < slice.length; byteIndex += 1) {
      bytes[byteIndex] = slice.charCodeAt(byteIndex);
    }
    chunks.push(bytes);
  }
  return new Blob(chunks, { type: mimeType || "application/octet-stream" });
}

function utf8ToBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192) {
    binary += String.fromCharCode(...bytes.slice(index, index + 8192));
  }
  return btoa(binary);
}

function base64ToUtf8(value) {
  const binary = atob(stripBase64Whitespace(value));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

function stripBase64Whitespace(value) {
  return String(value || "").replace(/\s/g, "");
}

function guessMimeType(filename) {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (lower.endsWith(".doc")) return "application/msword";
  if (lower.endsWith(".pptx")) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  return "application/octet-stream";
}

function normalizeWhitespace(text) {
  return text.replace(/\r\n?/g, "\n").replace(/\t/g, "  ").trim();
}

function deriveTitle(text) {
  const firstLine = text.split(/\n/).map((line) => line.trim()).find(Boolean) || "Text source";
  return firstLine.length > 70 ? `${firstLine.slice(0, 67)}...` : firstLine;
}

function deriveLinkTitle(parsedUrl) {
  const lastPath = decodeURIComponent(parsedUrl.pathname.split("/").filter(Boolean).pop() || "");
  if (lastPath && /\.[a-z0-9]{2,8}$/i.test(lastPath)) {
    return lastPath.replace(/[-_]+/g, " ");
  }
  return parsedUrl.hostname.replace(/^www\./, "");
}

function clipText(text, maxLength) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n\n[Text clipped at ${formatCompactNumber(maxLength)} characters in this prompt. Add a backend endpoint or split the draft for full-source processing.]`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatCompactNumber(value) {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function slugify(value) {
  return (value || "summary")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "summary";
}

function cleanPathPart(value) {
  return String(value || "").trim().replace(/^\/+|\/+$/g, "");
}

function cleanBasePath(value) {
  return cleanPathPart(value).replace(/\/{2,}/g, "/");
}

function safeRemoteFilename(value) {
  const fallback = "source-file";
  const filename = String(value || fallback).trim() || fallback;
  const dotIndex = filename.lastIndexOf(".");
  const extension = dotIndex > 0 ? filename.slice(dotIndex).toLowerCase().replace(/[^a-z0-9.]/g, "") : "";
  const base = dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
  const safeBase = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70) || "source";
  return `${safeBase}${extension}`;
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  if (!["http:", "https:"].includes(window.location.protocol)) return;
  navigator.serviceWorker.register("./service-worker.js").catch((error) => {
    console.warn("Service worker registration failed", error);
  });
}

async function init() {
  try {
    await loadState();
    bindEvents();
    render();
    switchSourceTab(state.activeSourceTab);
    registerServiceWorker();
  } catch (error) {
    console.error("App failed to start", error);
    dom.saveStatus.textContent = "Database unavailable";
    showToast("The browser database is unavailable.");
  }
}

init();
