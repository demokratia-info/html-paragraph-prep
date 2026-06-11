"use strict";

const STORAGE_KEY = "summary-html-desk.drafts.v1";
const SETTINGS_KEY = "summary-html-desk.settings.v1";
const DB_NAME = "summary-html-desk";
const DB_VERSION = 1;
const DEFAULT_BACKEND_ENDPOINT = "https://summary-html-desk-openai.demokratia-info.workers.dev";
const PASSWORD_SESSION_KEY = "summary-html-desk.editor-password.session";
const PASSWORD_STORAGE_KEY = "summary-html-desk.editor-password.local";
const MAX_PROMPT_SOURCE_CHARS = 80000;
const MAX_BINARY_FILE_BYTES = 18 * 1024 * 1024;
const SHARED_REFRESH_INTERVAL_MS = 60 * 1000;
const VALID_STATUSES = new Set(["draft", "pending", "processing", "done", "error", "exported"]);
const STATUS_TEXT = {
  draft: {
    label: "Draft",
    detail: "Not sent for processing yet"
  },
  pending: {
    label: "Waiting",
    detail: "Saved and waiting for Codex"
  },
  processing: {
    label: "Processing",
    detail: "Codex is working on this item"
  },
  done: {
    label: "Ready",
    detail: "Summary text is ready to edit"
  },
  error: {
    label: "Needs Attention",
    detail: "Processing failed. Check the error message."
  },
  exported: {
    label: "Exported",
    detail: "HTML was copied for the CMS"
  }
};

const state = {
  drafts: [],
  activeId: null,
  db: null,
  settings: {
    proxyEndpoint: DEFAULT_BACKEND_ENDPOINT
  },
  draftSearch: "",
  draftStatusFilter: "all",
  activeSourceTab: "link",
  editorPassword: "",
  authenticated: false,
  saveTimer: null,
  autoRefreshTimer: null,
  syncBusy: false,
  toastTimer: null,
  volatileFiles: new Map()
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const dom = {
  loginScreen: $("#loginScreen"),
  loginForm: $("#loginForm"),
  loginPasswordInput: $("#loginPasswordInput"),
  loginButton: $("#loginButton"),
  loginError: $("#loginError"),
  appHeader: $("#appHeader"),
  app: $("#app"),
  logoutButton: $("#logoutButton"),
  draftTitleInput: $("#draftTitleInput"),
  draftSelect: $("#draftSelect"),
  draftSearchInput: $("#draftSearchInput"),
  draftStatusFilterInput: $("#draftStatusFilterInput"),
  draftBrowser: $("#draftBrowser"),
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
  statusBadge: $("#statusBadge"),
  statusUpdated: $("#statusUpdated"),
  modifiedTime: $("#modifiedTime"),
  processedTime: $("#processedTime"),
  exportedTime: $("#exportedTime"),
  sourceCount: $("#sourceCount"),
  sourceChars: $("#sourceChars"),
  textSourceTitleInput: $("#textSourceTitleInput"),
  textSourceInput: $("#textSourceInput"),
  addTextSourceButton: $("#addTextSourceButton"),
  linkUrlInput: $("#linkUrlInput"),
  linkNotesInput: $("#linkNotesInput"),
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
  errorBox: $("#errorBox"),
  errorText: $("#errorText"),
  clearErrorButton: $("#clearErrorButton"),
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
    status: "draft",
    queuedAt: "",
    processingStartedAt: "",
    processedAt: "",
    exportedAt: "",
    htmlCreatedAt: "",
    processingError: "",
    processingRunId: "",
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
  state.settings.proxyEndpoint = DEFAULT_BACKEND_ENDPOINT;

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
  const normalized = {
    ...fresh,
    ...draft,
    sources: Array.isArray(draft.sources) ? draft.sources.map(normalizeSource) : []
  };
  normalized.status = normalizeStatus(normalized.status);
  normalized.queuedAt = normalized.queuedAt || "";
  normalized.processingStartedAt = normalized.processingStartedAt || "";
  normalized.processedAt = normalized.processedAt || "";
  normalized.exportedAt = normalized.exportedAt || "";
  normalized.htmlCreatedAt = normalized.htmlCreatedAt || "";
  normalized.processingError = normalized.processingError || "";
  normalized.processingRunId = normalized.processingRunId || "";
  return normalized;
}

function normalizeStatus(status) {
  const value = String(status || "draft").trim();
  return VALID_STATUSES.has(value) ? value : "draft";
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
  dom.loginForm.addEventListener("submit", (event) => {
    event.preventDefault();
    loginWithPassword(dom.loginPasswordInput.value);
  });

  dom.logoutButton.addEventListener("click", logout);

  dom.newDraftButton.addEventListener("click", () => {
    const draft = createDraft("New paper");
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
    renderDraftBrowser();
  });

  dom.draftStatusFilterInput.addEventListener("change", () => {
    state.draftStatusFilter = dom.draftStatusFilterInput.value;
    renderDraftSelect();
    renderDraftBrowser();
  });

  dom.draftTitleInput.addEventListener("input", () => {
    const draft = activeDraft();
    draft.title = dom.draftTitleInput.value.trimStart() || "Untitled summary";
    touchDraft(draft);
    renderDraftSelect();
    renderDraftBrowser();
    saveStateSoon();
  });

  dom.exportDraftsButton.addEventListener("click", exportDrafts);
  dom.importDraftsInput.addEventListener("change", importDrafts);
  dom.saveBackendButton.addEventListener("click", saveBackendSettings);
  dom.pullBackendButton.addEventListener("click", pullBackendSync);
  dom.pushBackendButton.addEventListener("click", saveForProcessing);

  $$(".tab-button").forEach((button) => {
    button.addEventListener("click", () => switchSourceTab(button.dataset.sourceTab));
  });

  dom.addTextSourceButton.addEventListener("click", addTextSource);
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
    clearPersistentError();
    renderStatus();
    saveStateSoon();
    showToast("Default prompt added.");
  });
  dom.copyPromptButton.addEventListener("click", () => copyText(dom.promptOutput.value, "Prompt copied."));
  dom.promptOutput.addEventListener("input", () => {
    const draft = activeDraft();
    draft.prompt = dom.promptOutput.value;
    touchDraft(draft);
    renderStatus();
    saveStateSoon();
  });
  dom.saveProxyButton.addEventListener("click", saveProxyEndpoint);
  dom.runProxyButton.addEventListener("click", saveResultText);
  dom.clearErrorButton.addEventListener("click", clearPersistentError);

  dom.llmResultInput.addEventListener("input", () => {
    const draft = activeDraft();
    draft.result = dom.llmResultInput.value;
    if (draft.status === "exported") draft.status = "done";
    touchDraft(draft);
    renderStatus();
    saveStateSoon();
  });

  dom.copyResultButton.addEventListener("click", () => copyText(dom.llmResultInput.value, "Result copied."));
  dom.refreshHtmlButton.addEventListener("click", () => createHtmlFromResult());
  dom.copyHtmlButton.addEventListener("click", copyHtmlAndMarkExported);
  dom.downloadHtmlButton.addEventListener("click", downloadHtml);
  dom.toggleDirectionButton.addEventListener("click", togglePreviewDirection);
}

async function loginWithPassword(password) {
  const value = String(password || "").trim();
  if (!value) {
    showLoginError("Enter the editor password.");
    return;
  }

  dom.loginButton.disabled = true;
  dom.loginButton.querySelector("span:last-child").textContent = "Opening";
  hideLoginError();
  state.editorPassword = value;
  dom.editorPasswordInput.value = value;

  const loaded = await pullBackendSync({ skipConfirm: true, quiet: true });
  dom.loginButton.disabled = false;
  dom.loginButton.querySelector("span:last-child").textContent = "Open Workspace";

  if (!loaded) {
    state.editorPassword = "";
    dom.editorPasswordInput.value = "";
    forgetEditorPassword();
    showLoginError("The password did not open the shared workspace.");
    return;
  }

  rememberEditorPassword(value);
  showWorkspace();
  showToast("Shared workspace opened.");
}

function showWorkspace() {
  state.authenticated = true;
  dom.loginScreen.hidden = true;
  dom.appHeader.hidden = false;
  dom.app.hidden = false;
  startAutoRefresh();
  render();
}

function showLogin(message = "") {
  state.authenticated = false;
  stopAutoRefresh();
  dom.loginScreen.hidden = false;
  dom.appHeader.hidden = true;
  dom.app.hidden = true;
  if (message) showLoginError(message);
  window.setTimeout(() => dom.loginPasswordInput.focus(), 0);
}

function startAutoRefresh() {
  stopAutoRefresh();
  state.autoRefreshTimer = window.setInterval(() => {
    if (!state.authenticated || state.syncBusy) return;
    pullBackendSync({
      skipConfirm: true,
      quiet: true,
      mergeRemote: true,
      preserveFocusedField: true,
      background: true
    }).catch((error) => {
      console.warn("Background refresh failed", error);
    });
  }, SHARED_REFRESH_INTERVAL_MS);
}

function stopAutoRefresh() {
  if (!state.autoRefreshTimer) return;
  window.clearInterval(state.autoRefreshTimer);
  state.autoRefreshTimer = null;
}

function logout() {
  state.editorPassword = "";
  dom.editorPasswordInput.value = "";
  dom.loginPasswordInput.value = "";
  forgetEditorPassword();
  showLogin();
}

function rememberEditorPassword(value) {
  state.editorPassword = value;
  sessionStorage.setItem(PASSWORD_SESSION_KEY, value);
  try {
    localStorage.setItem(PASSWORD_STORAGE_KEY, value);
  } catch (error) {
    console.warn("Could not persist editor password", error);
  }
}

function savedEditorPassword() {
  if (state.editorPassword) return state.editorPassword;
  try {
    const persisted = localStorage.getItem(PASSWORD_STORAGE_KEY);
    if (persisted) return persisted;
  } catch (error) {
    console.warn("Could not read persisted editor password", error);
  }
  return sessionStorage.getItem(PASSWORD_SESSION_KEY) || "";
}

function forgetEditorPassword() {
  sessionStorage.removeItem(PASSWORD_SESSION_KEY);
  try {
    localStorage.removeItem(PASSWORD_STORAGE_KEY);
  } catch (error) {
    console.warn("Could not clear persisted editor password", error);
  }
}

function showLoginError(message) {
  dom.loginError.textContent = message;
  dom.loginError.hidden = false;
}

function hideLoginError() {
  dom.loginError.textContent = "";
  dom.loginError.hidden = true;
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

function syncLinkSourceFromInput() {
  const url = dom.linkUrlInput.value.trim();
  const draft = activeDraft();
  const existing = draft.sources.find((source) => source.type === "link");
  if (!url) {
    if (existing) {
      draft.sources = draft.sources.filter((source) => source.id !== existing.id);
    }
    return true;
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    showToast("The URL is not valid.");
    return false;
  }

  const title = draft.title.trim() || deriveLinkTitle(parsed);
  if (existing) {
    existing.title = title;
    existing.url = parsed.href;
    existing.text = "";
    existing.size = 0;
    existing.textAvailable = false;
  } else {
    draft.sources.push({
      id: createId(),
      type: "link",
      title,
      url: parsed.href,
      text: "",
      filename: "",
      mimeType: "",
      size: 0,
      textAvailable: false,
      fileAvailable: false,
      createdAt: new Date().toISOString()
    });
  }
  return true;
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
  renderDraftBrowser();
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
  renderDraftBrowser();
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
      showToast("The shared storage address is missing.");
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
  renderDraftBrowser();
  dom.draftTitleInput.value = draft.title;
  dom.draftSearchInput.value = state.draftSearch;
  dom.draftStatusFilterInput.value = state.draftStatusFilter;
  dom.languageSelect.value = draft.language;
  dom.shapeSelect.value = draft.shape;
  dom.paragraphCountInput.value = draft.paragraphCount;
  dom.toneSelect.value = draft.tone;
  dom.includeLinksCheckbox.checked = draft.includeLinks;
  dom.promptOutput.value = draft.prompt || buildPrompt(draft);
  dom.proxyEndpointInput.value = DEFAULT_BACKEND_ENDPOINT;
  dom.backendEndpointInput.value = DEFAULT_BACKEND_ENDPOINT;
  const primaryLink = draft.sources.find((source) => source.type === "link");
  dom.linkUrlInput.value = primaryLink?.url || "";
  dom.llmResultInput.value = draft.result || "";
  dom.llmResultInput.dir = "rtl";
  dom.htmlOutput.value = draft.html || "";
  dom.preview.dir = draft.direction || "auto";
  dom.preview.innerHTML = draft.html || "<p></p>";
  renderStatus();
  renderSources();
}

function renderStatus() {
  const draft = activeDraft();
  const status = normalizeStatus(draft.status);
  const text = STATUS_TEXT[status] || STATUS_TEXT.draft;
  dom.statusBadge.textContent = text.label;
  dom.statusBadge.className = `status-badge status-${status}`;
  dom.statusUpdated.textContent = draft.processingError && status === "error" ? draft.processingError : text.detail;
  dom.modifiedTime.textContent = formatDateTime(draft.updatedAt);
  dom.processedTime.textContent = draft.processedAt ? formatDateTime(draft.processedAt) : "Not yet";
  dom.exportedTime.textContent = draft.exportedAt ? formatDateTime(draft.exportedAt) : "Not yet";
}

function renderDraftSelect() {
  const currentValue = dom.draftSelect.value;
  const visibleDrafts = filteredDrafts();
  const draftsForOptions = visibleDrafts.some((draft) => draft.id === state.activeId)
    ? visibleDrafts
    : [activeDraft(), ...visibleDrafts.filter((draft) => draft.id !== state.activeId)];

  dom.draftSelect.replaceChildren(
    ...draftsForOptions.map((draft) => {
      const option = document.createElement("option");
      option.value = draft.id;
      option.textContent = `${draft.title || "Untitled summary"} · ${statusLabel(draft.status)} · ${draft.sources.length} sources`;
      return option;
    })
  );
  dom.draftSelect.value = state.activeId || currentValue;
}

function renderDraftBrowser() {
  const visibleDrafts = filteredDrafts();
  if (!visibleDrafts.length) {
    const empty = document.createElement("div");
    empty.className = "draft-card empty";
    empty.textContent = "No summaries match this view.";
    dom.draftBrowser.replaceChildren(empty);
    return;
  }

  dom.draftBrowser.replaceChildren(
    ...visibleDrafts.map((draft) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `draft-card ${draft.id === state.activeId ? "active" : ""}`;
      button.addEventListener("click", () => {
        state.activeId = draft.id;
        render();
        saveStateSoon();
      });

      const top = document.createElement("div");
      top.className = "draft-card-top";
      const title = document.createElement("strong");
      title.textContent = draft.title || "Untitled summary";
      const badge = document.createElement("span");
      badge.className = `status-badge status-${normalizeStatus(draft.status)}`;
      badge.textContent = statusLabel(draft.status);
      top.append(title, badge);

      const meta = document.createElement("p");
      meta.textContent = [
        `${draft.sources.length} source${draft.sources.length === 1 ? "" : "s"}`,
        `modified ${formatDateTime(draft.updatedAt)}`,
        draft.processedAt ? `processed ${formatDateTime(draft.processedAt)}` : "",
        draft.exportedAt ? `exported ${formatDateTime(draft.exportedAt)}` : ""
      ].filter(Boolean).join(" · ");

      const sources = document.createElement("p");
      sources.className = "draft-card-sources";
      sources.textContent = draftSourcePreview(draft);

      const snippet = document.createElement("p");
      snippet.className = "draft-card-snippet";
      snippet.textContent = draftSnippet(draft);

      button.append(top, meta, sources, snippet);
      return button;
    })
  );
}

function renderDraftNavigation() {
  renderDraftSelect();
  renderDraftBrowser();
}

function filteredDrafts() {
  const query = state.draftSearch;
  return [...state.drafts]
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .filter((draft) => draftMatchesStatusFilter(draft, state.draftStatusFilter))
    .filter((draft) => {
      if (!query) return true;
      return draftSearchHaystack(draft).includes(query);
    });
}

function draftMatchesStatusFilter(draft, filter) {
  const status = normalizeStatus(draft.status);
  if (!filter || filter === "all") return true;
  if (filter === "ready-export") {
    return Boolean(String(draft.result || "").trim())
      && status !== "pending"
      && status !== "processing"
      && status !== "exported";
  }
  return status === filter;
}

function draftSearchHaystack(draft) {
  const sourceText = draft.sources.map((source) => [
    source.title,
    source.url,
    source.filename,
    source.text
  ].filter(Boolean).join(" ")).join(" ");
  return [
    draft.title,
    draft.prompt,
    draft.result,
    draft.html,
    sourceText
  ].filter(Boolean).join(" ").toLowerCase();
}

function draftSourcePreview(draft) {
  if (!draft.sources.length) return "No sources yet";
  const names = draft.sources.slice(0, 3).map((source) => source.title || source.filename || source.url || "Source");
  const extra = draft.sources.length > names.length ? ` +${draft.sources.length - names.length} more` : "";
  return `Sources: ${names.join(", ")}${extra}`;
}

function draftSnippet(draft) {
  const text = normalizeWhitespace(draft.result || draft.sources.map((source) => source.text).filter(Boolean).join(" "));
  if (!text) return "No text yet";
  return text.length > 150 ? `${text.slice(0, 147)}...` : text;
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
    meta.textContent = "Add a URL or upload one or more files.";
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
      kind.textContent = source.type === "link" ? "url" : source.type;

      const titleLabel = document.createElement("label");
      titleLabel.className = "field compact";
      const titleCaption = document.createElement("span");
      titleCaption.textContent = "Title";
      const titleInput = document.createElement("input");
      titleInput.type = "text";
      titleInput.value = source.title || source.filename || source.url || "Source";
      titleInput.addEventListener("input", () => {
        source.title = titleInput.value.trimStart() || "Source";
        touchDraft(draft);
        updatePrompt();
        renderDraftSelect();
        renderDraftBrowser();
        saveStateSoon();
      });
      titleLabel.append(titleCaption, titleInput);

      const meta = document.createElement("p");
      meta.textContent = sourceMeta(source);
      content.append(kind, titleLabel);

      if (source.type === "link") {
        const urlLabel = document.createElement("label");
        urlLabel.className = "field compact";
        const urlCaption = document.createElement("span");
        urlCaption.textContent = "URL";
        const urlInput = document.createElement("input");
        urlInput.type = "url";
        urlInput.value = source.url || "";
        urlInput.addEventListener("input", () => {
          source.url = urlInput.value.trim();
          touchDraft(draft);
          updatePrompt();
          renderDraftBrowser();
          saveStateSoon();
        });
        urlLabel.append(urlCaption, urlInput);
        content.append(urlLabel);
      }

      content.append(meta);

      const actions = document.createElement("div");
      actions.className = "source-actions";

      if (source.url || source.fileStored || source.remoteFilePath) {
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
  if (source.remoteFilePath) pieces.push("origin file saved");
  if ((source.fileAvailable || state.volatileFiles.has(source.id)) && !source.fileStored) pieces.push("file ready to save");
  if (!source.textAvailable && !source.fileAvailable && !state.volatileFiles.has(source.id)) {
    if (source.type === "link") {
      pieces.push("document URL only");
    } else if (source.type === "file") {
      pieces.push("re-upload to save");
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
    paragraphs: `${draft.paragraphCount} concise paragraphs`,
    "heading-paragraphs": "one short heading followed by concise paragraphs",
    "brief-list": "one short heading followed by a compact bullet list"
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
    "Return only editable summary text. Do not return HTML.",
    "Use blank lines between paragraphs. For a list, use simple bullet lines.",
    "Do not include Markdown fences, CSS, inline styles, tables, footnotes, or commentary.",
    "Preserve important names, dates, numbers, and causal claims. Do not invent facts.",
    "Most sources and summaries are in Hebrew. Keep Hebrew names, titles, dates, and institutional terms accurate.",
    "If a source is a public document URL, open/read the document before summarizing when your environment allows it.",
    "If a source is only a URL and you cannot access it, say that the URL needs source text rather than guessing.",
    draft.includeLinks ? "Mention useful source links in plain text when they directly support the summary." : "Do not include links unless the URL itself is central to the summary."
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

async function saveForProcessing() {
  const draft = activeDraft();
  if (!syncLinkSourceFromInput()) return;

  if (!draft.sources.length) {
    showToast("Add at least one source first.");
    return;
  }

  draft.prompt = dom.promptOutput.value.trim() || buildPrompt(draft);
  dom.promptOutput.value = draft.prompt;
  draft.result = dom.llmResultInput.value;
  draft.html = dom.htmlOutput.value;
  draft.status = "pending";
  draft.queuedAt = new Date().toISOString();
  draft.processingStartedAt = "";
  draft.processingRunId = "";
  draft.processingError = "";
  touchDraft(draft);
  clearPersistentError();
  renderStatus();
  renderDraftNavigation();
  renderSources();
  saveStateSoon();

  await pushBackendSync({
    busyMessage: "Saving item for processing...",
    doneMessage: `"${draft.title}" is waiting for processing.`,
    toastMessage: "Saved for processing."
  });
}

async function saveResultText() {
  const draft = activeDraft();
  draft.result = dom.llmResultInput.value;
  if (draft.status === "exported") draft.status = "done";
  draft.processingError = "";
  touchDraft(draft);
  clearPersistentError();
  renderStatus();
  saveStateSoon();

  await pushBackendSync({
    busyMessage: "Saving text...",
    doneMessage: "Text saved.",
    toastMessage: "Text saved."
  });
}

function createHtmlFromResult(showMessage = true) {
  const draft = activeDraft();
  draft.result = dom.llmResultInput.value;
  const html = makeCmsHtml(draft.result || "");
  if (!html) {
    showToast("Add result text first.");
    return false;
  }

  draft.html = html;
  draft.htmlCreatedAt = new Date().toISOString();
  if (draft.status === "exported") draft.status = "done";
  dom.htmlOutput.value = html;
  dom.preview.innerHTML = html;
  touchDraft(draft);
  renderStatus();
  saveStateSoon();
  if (showMessage) showToast("HTML created.");
  return true;
}

async function copyHtmlAndMarkExported() {
  if (!dom.htmlOutput.value && !createHtmlFromResult(false)) return;
  const copied = await copyText(dom.htmlOutput.value, "HTML copied.");
  if (!copied) return;

  const draft = activeDraft();
  draft.html = dom.htmlOutput.value;
  draft.status = "exported";
  draft.exportedAt = new Date().toISOString();
  draft.processingError = "";
  clearPersistentError();
  renderStatus();
  renderDraftNavigation();
  await saveState();

  await pushBackendSync({
    busyMessage: "Saving export status...",
    doneMessage: "HTML copied and item marked exported.",
    toastMessage: "HTML copied and saved."
  });
}

async function runProxySummary() {
  const draft = activeDraft();
  if (!backendEndpoint()) {
    showPersistentError("Shared storage is not configured.");
    return;
  }
  updatePrompt();
  clearPersistentError();
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
    setSyncStatus("LLM result added.");
    showToast("LLM result added.");
  } catch (error) {
    const message = error.message || "LLM request failed.";
    showPersistentError(message);
    setSyncStatus(message);
    showToast("LLM request failed. See Last error.");
  } finally {
    dom.runProxyButton.disabled = false;
    dom.runProxyButton.querySelector("span:last-child").textContent = "Save Text";
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
  return DEFAULT_BACKEND_ENDPOINT;
}

function editorPassword() {
  return savedEditorPassword() || dom.editorPasswordInput.value;
}

async function backendPost(payload) {
  const endpoint = backendEndpoint();
  if (!endpoint) throw new Error("Shared storage is not configured.");

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
    const details = data.details?.error?.message || data.details?.message || "";
    const message = [data.error || `Shared storage returned ${response.status}`, details].filter(Boolean).join("\n\n");
    throw new Error(message);
  }
  return data;
}

async function saveBackendSettings() {
  state.settings.proxyEndpoint = DEFAULT_BACKEND_ENDPOINT;
  dom.proxyEndpointInput.value = DEFAULT_BACKEND_ENDPOINT;
  dom.backendEndpointInput.value = DEFAULT_BACKEND_ENDPOINT;
  await saveState();
  setSyncStatus("Shared storage saved. Editor password is not stored.");
  showToast("Shared storage saved.");
}

async function pushBackendSync(options = {}) {
  if (!backendEndpoint()) {
    showToast("Shared storage is not configured.");
    return false;
  }

  setSyncBusy(true, options.busyMessage || "Saving shared work...");
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
    setSyncStatus(options.doneMessage || `Saved ${state.drafts.length} items and ${uploadedFiles} origin files.`);
    showToast(options.toastMessage || "Saved.");
    return true;
  } catch (error) {
    setSyncStatus(error.message || "Save failed.");
    showToast(error.message || "Save failed.");
    return false;
  } finally {
    setSyncBusy(false);
  }
}

async function pullBackendSync(options = {}) {
  if (!backendEndpoint()) {
    if (!options.quiet) showToast("Shared storage is not configured.");
    return false;
  }

  if (!options.skipConfirm && state.drafts.length && !window.confirm("Refresh from the shared work list? Unsaved local edits may be lost.")) {
    return false;
  }

  const previousActiveId = state.activeId;
  setSyncBusy(true, options.background ? "" : "Refreshing shared work...");
  try {
    const payload = await backendPost({ action: "loadSharedState" });
    if (!payload || !Array.isArray(payload.drafts)) throw new Error("Shared drafts file is invalid.");

    const remoteDrafts = payload.drafts.map(normalizeDraft).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    state.drafts = options.mergeRemote ? mergeRemoteDrafts(remoteDrafts) : remoteDrafts;
    if (!state.drafts.length) {
      state.drafts = [createDraft("New paper")];
    }
    state.activeId = state.drafts.some((draft) => draft.id === previousActiveId)
      ? previousActiveId
      : state.drafts[0]?.id || null;
    if (!options.mergeRemote) state.volatileFiles.clear();

    await idbClear("drafts");
    if (!options.mergeRemote) await idbClear("files");
    await saveState();
    renderAfterSharedRefresh(Boolean(options.preserveFocusedField));
    if (!options.background) setSyncStatus(`Loaded ${state.drafts.length} shared items.`);
    if (!options.quiet) showToast("Shared work refreshed.");
    return true;
  } catch (error) {
    setSyncStatus(error.message || "Refresh failed.");
    if (!options.quiet) showToast(error.message || "Refresh failed.");
    return false;
  } finally {
    setSyncBusy(false);
  }
}

function mergeRemoteDrafts(remoteDrafts) {
  const localById = new Map(state.drafts.map((draft) => [draft.id, draft]));
  const remoteIds = new Set(remoteDrafts.map((draft) => draft.id));
  const merged = remoteDrafts.map((remoteDraft) => {
    const localDraft = localById.get(remoteDraft.id);
    if (!localDraft) return remoteDraft;
    if (remoteDraft.id !== state.activeId) return remoteDraft;
    return mergeActiveDraftFromRemote(localDraft, remoteDraft);
  });

  for (const localDraft of state.drafts) {
    if (!remoteIds.has(localDraft.id)) merged.push(localDraft);
  }

  return merged.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

function mergeActiveDraftFromRemote(localDraft, remoteDraft) {
  const merged = { ...localDraft };
  [
    "status",
    "queuedAt",
    "processingStartedAt",
    "processingRunId",
    "processingError",
    "processedAt",
    "exportedAt",
    "htmlCreatedAt"
  ].forEach((field) => {
    merged[field] = remoteDraft[field] || "";
  });

  if (shouldUseRemoteResult(localDraft, remoteDraft)) {
    merged.result = remoteDraft.result || "";
  }
  if (shouldUseRemoteHtml(localDraft, remoteDraft)) {
    merged.html = remoteDraft.html || "";
  }

  return normalizeDraft(merged);
}

function shouldUseRemoteResult(localDraft, remoteDraft) {
  const remoteResult = String(remoteDraft.result || "");
  if (!remoteResult.trim()) return false;
  if (remoteDraft.processedAt && remoteDraft.processedAt !== localDraft.processedAt) return true;
  const localStatus = normalizeStatus(localDraft.status);
  const remoteStatus = normalizeStatus(remoteDraft.status);
  return !String(localDraft.result || "").trim() || (
    ["pending", "processing"].includes(localStatus) && remoteStatus === "done"
  );
}

function shouldUseRemoteHtml(localDraft, remoteDraft) {
  const remoteHtml = String(remoteDraft.html || "");
  if (!remoteHtml.trim()) return false;
  if (remoteDraft.exportedAt && remoteDraft.exportedAt !== localDraft.exportedAt) return true;
  return !String(localDraft.html || "").trim();
}

function renderAfterSharedRefresh(preserveFocusedField) {
  if (!preserveFocusedField || !isWorkspaceFormFieldFocused()) {
    render();
    return;
  }

  renderDraftNavigation();
  renderStatus();
  renderSharedOutputFields();
}

function isWorkspaceFormFieldFocused() {
  const active = document.activeElement;
  return Boolean(active && dom.app.contains(active) && active.matches("input, textarea, select"));
}

function renderSharedOutputFields() {
  const draft = activeDraft();
  syncFieldUnlessFocused(dom.llmResultInput, draft.result || "");
  syncFieldUnlessFocused(dom.htmlOutput, draft.html || "");
  if (document.activeElement !== dom.htmlOutput) {
    dom.preview.innerHTML = draft.html || "<p></p>";
  }
}

function syncFieldUnlessFocused(field, value) {
  if (document.activeElement === field) return;
  field.value = value;
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
  state.syncBusy = isBusy;
  dom.pullBackendButton.disabled = isBusy;
  dom.pushBackendButton.disabled = isBusy;
  dom.saveBackendButton.disabled = isBusy;
  if (message) setSyncStatus(message);
}

function setSyncStatus(message) {
  dom.syncStatus.textContent = message;
}

function showPersistentError(message) {
  dom.errorText.textContent = String(message || "Unknown error.");
  dom.errorBox.hidden = false;
}

function clearPersistentError() {
  dom.errorText.textContent = "";
  dom.errorBox.hidden = true;
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
  state.settings.proxyEndpoint = DEFAULT_BACKEND_ENDPOINT;
  dom.proxyEndpointInput.value = DEFAULT_BACKEND_ENDPOINT;
  dom.backendEndpointInput.value = DEFAULT_BACKEND_ENDPOINT;
  await saveState();
  showToast("Shared storage saved.");
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
    return false;
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
  return true;
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
  return `${text.slice(0, maxLength)}\n\n[Text clipped at ${formatCompactNumber(maxLength)} characters in this prompt. Split the source into another item if the text is too long.]`;
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

function formatDateTime(value) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short"
  }).format(date);
}

function statusLabel(status) {
  return (STATUS_TEXT[normalizeStatus(status)] || STATUS_TEXT.draft).label;
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
    const savedPassword = savedEditorPassword();
    if (savedPassword) {
      dom.loginPasswordInput.value = savedPassword;
      await loginWithPassword(savedPassword);
    } else {
      showLogin();
    }
  } catch (error) {
    console.error("App failed to start", error);
    dom.saveStatus.textContent = "Database unavailable";
    showToast("The browser database is unavailable.");
  }
}

init();
