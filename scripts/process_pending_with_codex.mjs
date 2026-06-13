#!/usr/bin/env node
"use strict";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const DATA_REPO = process.env.DATA_REPO || "demokratia-info/html-paragraph-prep-data";
const [GITHUB_OWNER, GITHUB_REPO] = DATA_REPO.split("/");
const GITHUB_BRANCH = process.env.DATA_BRANCH || "main";
const DATA_BASE_PATH = cleanBasePath(process.env.DATA_BASE_PATH || "summary-html-desk");
const STATE_PATH = `${DATA_BASE_PATH}/drafts.json`;
const DEFAULT_PROMPT_PATH = `${DATA_BASE_PATH}/default-prompt.txt`;
const LOCAL_PROMPT_PATH = path.join(REPO_ROOT, "prompt.txt");
const MAX_PENDING_PER_RUN = clamp(Number(process.env.MAX_PENDING_PER_RUN || 1), 1, 20);
const MAX_SOURCE_CHARS = clamp(Number(process.env.MAX_SOURCE_CHARS || 120000), 1000, 500000);
const CODEX_TIMEOUT_MS = clamp(Number(process.env.CODEX_TIMEOUT_MS || 45 * 60 * 1000), 60 * 1000, 3 * 60 * 60 * 1000);
const OCR_MAX_PAGES = clamp(Number(process.env.OCR_MAX_PAGES || 25), 1, 200);
const OCR_DPI = clamp(Number(process.env.OCR_DPI || 220), 100, 400);
const OCR_LANGS = String(process.env.OCR_LANGS || "heb+eng").trim() || "heb+eng";
const OCR_PSM = String(process.env.OCR_PSM || "6").trim() || "6";
const DEFAULT_DRAFT_TITLES = new Set(["", "מקור חדש", "מורק חדש", "New paper", "Untitled summary", "CMS summary"]);
const TITLE_MAX_CHARS = 90;
const PROCESSING_ROOT = path.join(REPO_ROOT, ".codex-processing");
const GH_BIN = commandPath("gh");
const CODEX_BIN = commandPath("codex");

if (!GITHUB_OWNER || !GITHUB_REPO) {
  fail("DATA_REPO must look like owner/repo.");
}

main().catch((error) => {
  fail(error?.stack || error?.message || String(error));
});

async function main() {
  ensureDir(PROCESSING_ROOT);
  if (process.argv.includes("--sync-default-prompt")) {
    syncDefaultPrompt();
    log("Default prompt sync complete.");
    return;
  }

  let processed = 0;
  for (let index = 0; index < MAX_PENDING_PER_RUN; index += 1) {
    const state = loadSharedState();
    if (!state) {
      log("No shared work list found yet.");
      return;
    }

    const draft = findNextPendingDraft(state.drafts);
    if (!draft) {
      log("No waiting items.");
      return;
    }

    await processDraft(draft);
    processed += 1;
  }

  log(`Processed ${processed} item${processed === 1 ? "" : "s"}.`);
}

function syncDefaultPrompt() {
  if (!fs.existsSync(LOCAL_PROMPT_PATH)) return;
  const localPrompt = fs.readFileSync(LOCAL_PROMPT_PATH, "utf8").trim();
  if (!localPrompt) return;

  const existing = githubGetContent(DEFAULT_PROMPT_PATH);
  const existingText = existing?.content
    ? Buffer.from(stripBase64Whitespace(existing.content), "base64").toString("utf8").trim()
    : "";
  if (existingText === localPrompt) return;

  githubPutContent(
    DEFAULT_PROMPT_PATH,
    Buffer.from(`${localPrompt}\n`, "utf8").toString("base64"),
    "Update default summary prompt"
  );
  log("Default prompt updated in shared storage.");
}

function loadRequiredDefaultPrompt() {
  const prompt = String(githubGetTextContent(DEFAULT_PROMPT_PATH) || "").trim();
  if (!prompt) {
    throw new Error(`Default prompt is missing or empty in ${DATA_REPO}/${DEFAULT_PROMPT_PATH}.`);
  }
  return prompt;
}

async function processDraft(draft) {
  const runId = `${Date.now()}-${process.pid}-${safePathPart(draft.id)}`;
  const now = new Date().toISOString();
  const defaultPrompt = loadRequiredDefaultPrompt();
  const draftInState = markDraftProcessing(draft, runId, now);

  const workDir = path.join(PROCESSING_ROOT, safePathPart(draft.id), runId);
  ensureDir(workDir);
  ensureDir(path.join(workDir, "sources"));

  try {
    const preparedSources = prepareSources(draftInState, workDir);
    const unreadableFiles = preparedSources.filter((source) => source.extractionError && !source.text && !source.extractedText);
    if (unreadableFiles.length && unreadableFiles.length === preparedSources.length) {
      throw new Error([
        "The uploaded file could not be converted to readable text before calling Codex.",
        "This usually means the PDF is scanned/image-based or uses text encoding that pdftotext cannot extract.",
        "Upload a text-selectable PDF, Word file, or extracted text version, or add OCR support to this machine.",
        `File: ${unreadableFiles.map((source) => source.filename || source.title || "source file").join(", ")}`
      ].join(" "));
    }
    const prompt = buildCodexPrompt(draftInState, preparedSources, defaultPrompt);
    const promptPath = path.join(workDir, "prompt.txt");
    const resultPath = path.join(workDir, "result.txt");
    fs.writeFileSync(promptPath, prompt, "utf8");

    runCodex(prompt, resultPath);
    const resultText = readResultText(resultPath);
    if (!resultText) throw new Error("Codex finished without returning summary text.");
    const derivedTitle = deriveTitleFromSources(preparedSources);

    finalizeDraft(draft.id, runId, (freshDraft) => {
      const processedAt = new Date().toISOString();
      freshDraft.result = resultText;
      freshDraft.regenerationBaseResult = "";
      freshDraft.html = "";
      freshDraft.htmlCreatedAt = "";
      freshDraft.exportedAt = "";
      freshDraft.editedAfterGeneration = false;
      if (shouldReplaceDraftTitle(freshDraft.title) && derivedTitle) {
        freshDraft.title = derivedTitle;
      }
      freshDraft.status = "done";
      freshDraft.processedAt = processedAt;
      freshDraft.processingStartedAt = "";
      freshDraft.processingRunId = "";
      freshDraft.processingError = "";
      freshDraft.updatedAt = freshDraft.updatedAt || freshDraft.processedAt;
    }, `Finish processing ${draft.title || draft.id}`);
    log(`Ready: ${draft.title || draft.id}`);
  } catch (error) {
    const message = error?.message || String(error);
    finalizeDraft(draft.id, runId, (freshDraft) => {
      freshDraft.status = "error";
      freshDraft.processingStartedAt = "";
      freshDraft.processingRunId = "";
      freshDraft.processingError = message;
    }, `Processing failed ${draft.title || draft.id}`);
    log(`Failed: ${draft.title || draft.id}: ${message}`);
  }
}

function markDraftProcessing(draft, runId, startedAt) {
  return updateSharedDraftWithRetry(draft.id, (freshDraft) => {
    freshDraft.status = "processing";
    freshDraft.processingStartedAt = startedAt;
    freshDraft.processingRunId = runId;
    freshDraft.processingError = "";
    freshDraft.prompt = "";
    freshDraft.promptSource = DEFAULT_PROMPT_PATH;
  }, `Start processing ${draft.title || draft.id}`);
}

function prepareSources(draft, workDir) {
  return (draft.sources || []).map((source, index) => {
    const prepared = { ...source, localPath: "", localPathError: "" };
    try {
      const cachedPath = resolveCachedSourcePath(source.localPath);
      if (cachedPath) {
        prepared.localPath = cachedPath;
        prepared.filename = prepared.filename || path.basename(cachedPath);
        prepared.mimeType = prepared.mimeType || mimeTypeFromFilename(cachedPath);
      } else if (source.remoteFilePath) {
        const raw = githubGetRaw(source.remoteFilePath);
        const filename = `${String(index + 1).padStart(2, "0")}-${safeFilename(source.filename || source.title || `source-${index + 1}`)}`;
        const localPath = path.join(workDir, "sources", filename);
        fs.writeFileSync(localPath, raw);
        prepared.localPath = localPath;
      } else if (source.url && !source.text) {
        const downloaded = downloadUrlSource(source, index, workDir);
        prepared.localPath = downloaded.localPath;
        prepared.filename = prepared.filename || downloaded.filename;
        prepared.mimeType = prepared.mimeType || downloaded.mimeType;
      }

      if (prepared.localPath) {
        const extraction = extractLocalText(prepared.localPath, prepared);
        if (extraction.text) {
          prepared.extractedText = extraction.text;
        } else if (textExtractionExpected(prepared)) {
          prepared.extractionError = extraction.error || "Local text extraction did not produce readable text.";
        }
      }
    } catch (error) {
      prepared.localPathError = error?.message || String(error);
    }
    return prepared;
  });
}

function resolveCachedSourcePath(localPath) {
  const value = String(localPath || "").trim();
  if (!value) return "";
  const resolved = path.isAbsolute(value) ? value : path.resolve(REPO_ROOT, value);
  const relative = path.relative(REPO_ROOT, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Cached source path is outside the repository: ${value}`);
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`Cached source file is missing: ${value}`);
  }
  return resolved;
}

function shouldReplaceDraftTitle(title) {
  return DEFAULT_DRAFT_TITLES.has(String(title || "").trim());
}

function deriveTitleFromSources(sources) {
  for (const source of sources || []) {
    const title = deriveTitleFromText(source.extractedText || source.text || "");
    if (title) return title;
  }
  return "";
}

function deriveTitleFromText(text) {
  const lines = normalizeExtractedText(text)
    .split(/\n/)
    .map(cleanTitleLine)
    .filter(Boolean)
    .slice(0, 80);

  for (const line of lines) {
    if (/הנדון/.test(line)) {
      const title = titleCandidate(line.replace(/^.*?הנדון\s*[:：\-–—]?\s*/, ""));
      if (title) return title;
    }
  }

  for (const line of lines) {
    const title = titleCandidate(line);
    if (title) return title;
  }
  return "";
}

function cleanTitleLine(line) {
  return String(line || "")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function titleCandidate(line) {
  let value = cleanTitleLine(line)
    .replace(/^[-–—•*.\s\d()]+/, "")
    .replace(/\s*[|:：\-–—]\s*$/, "")
    .trim();
  if (!value) return "";
  if (isGenericTitleLine(value) || isDateLikeTitleLine(value)) return "";

  const letterCount = (value.match(/\p{L}/gu) || []).length;
  if (letterCount < 8) return "";

  if (value.length > TITLE_MAX_CHARS) {
    value = `${value.slice(0, TITLE_MAX_CHARS - 1).trim()}…`;
  }
  return value;
}

function isGenericTitleLine(value) {
  const normalized = value.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return /^(לכבוד|עמוד|תוכן עניינים|page)$/i.test(normalized)
    || (/^נייר עמדה\b/.test(normalized) && normalized.length < 40);
}

function isDateLikeTitleLine(value) {
  const monthNames = "ינואר|פברואר|מרץ|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר";
  const wordCount = value.split(/\s+/).filter(Boolean).length;
  return wordCount <= 4 && new RegExp(`\\d.*(${monthNames})|(${monthNames}).*\\d`).test(value);
}

function downloadUrlSource(source, index, workDir) {
  let parsed;
  try {
    parsed = new URL(source.url);
  } catch {
    throw new Error(`The source URL is not valid: ${source.url}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Only HTTP and HTTPS source URLs can be downloaded: ${source.url}`);
  }

  const curl = optionalCommandPath("curl");
  if (!curl) throw new Error("curl is not installed, so URL sources cannot be downloaded locally.");

  const filename = `${String(index + 1).padStart(2, "0")}-${safeFilename(filenameFromUrl(parsed) || source.title || `source-${index + 1}.html`)}`;
  const localPath = path.join(workDir, "sources", filename);
  const result = spawnSync(curl, [
    "-L",
    "--fail",
    "--silent",
    "--show-error",
    "--max-time", "120",
    "-A", "Mozilla/5.0 (compatible; SummaryHtmlDesk/1.0)",
    "-o", localPath,
    source.url
  ], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 130 * 1000,
    maxBuffer: 20 * 1024 * 1024
  });

  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(commandError("curl", result));
  const stats = fs.statSync(localPath);
  if (!stats.size) throw new Error(`The source URL downloaded an empty file: ${source.url}`);

  return {
    localPath,
    filename,
    mimeType: mimeTypeFromFilename(filename)
  };
}

function filenameFromUrl(parsed) {
  const pathname = decodeURIComponent(parsed.pathname || "");
  const filename = pathname.split("/").filter(Boolean).pop() || "";
  return filename.includes(".") ? filename : "";
}

function mimeTypeFromFilename(filename) {
  const value = String(filename || "").toLowerCase();
  if (value.endsWith(".pdf")) return "application/pdf";
  if (value.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (value.endsWith(".txt")) return "text/plain";
  if (value.endsWith(".md") || value.endsWith(".markdown")) return "text/markdown";
  if (value.endsWith(".html") || value.endsWith(".htm")) return "text/html";
  if (value.endsWith(".csv")) return "text/csv";
  if (value.endsWith(".json")) return "application/json";
  if (value.endsWith(".rtf")) return "application/rtf";
  return "";
}

function runCodex(prompt, resultPath) {
  const args = [];
  if (process.env.CODEX_SEARCH !== "0") args.push("--search");
  args.push("--ask-for-approval", "never");
  if (process.env.CODEX_MODEL) args.push("-m", process.env.CODEX_MODEL);
  if (process.env.CODEX_REASONING_EFFORT) {
    args.push("-c", `model_reasoning_effort="${process.env.CODEX_REASONING_EFFORT}"`);
  }
  args.push("exec", "--cd", REPO_ROOT, "--sandbox", process.env.CODEX_SANDBOX || "workspace-write");
  args.push("--output-last-message", resultPath);
  args.push("-");

  const result = spawnSync(CODEX_BIN, args, {
    cwd: REPO_ROOT,
    input: prompt,
    encoding: "utf8",
    timeout: CODEX_TIMEOUT_MS,
    maxBuffer: 50 * 1024 * 1024
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(details || `codex exited with status ${result.status}`);
  }
}

function buildCodexPrompt(draft, sources, defaultPrompt) {
  const savedPrompt = String(defaultPrompt || "").trim();
  if (!savedPrompt) throw new Error("Default prompt is missing.");
  const previousResult = String(draft.regenerationBaseResult || draft.result || "").trim();
  const previousInstruction = previousResult
    ? [
      "This item already has a previous result.",
      "Treat the previous result as the base text.",
      "Keep it as similar as possible and only change what is needed to satisfy the current default prompt and source material.",
      "",
      "Previous result:",
      previousResult
    ].join("\n")
    : "This item does not have a previous result. Create the first summary text.";

  return [
    "You are processing one saved item for the Summary HTML Desk website.",
    "Return only the editable summary text that should be placed in the Result box.",
    "Do not return HTML unless the saved prompt explicitly asks for HTML.",
    "Do not edit files in the repository.",
    "Most sources and summaries are in Hebrew. Preserve Hebrew names, dates, titles, institutions, numbers, and causal claims accurately.",
    "",
    `Item title: ${draft.title || "Untitled summary"}`,
    "",
    "Current default prompt from the private shared system:",
    savedPrompt,
    "",
    previousInstruction,
    "",
    "Sources:",
    sources.length ? sources.map(formatSourceForCodex).join("\n\n") : "No sources were saved for this item."
  ].join("\n");
}

function formatSourceForCodex(source, index) {
  const lines = [`[Source ${index + 1}: ${source.title || source.filename || source.url || "Untitled"}]`];
  if (source.type) lines.push(`Type: ${source.type}`);
  if (source.url) lines.push(`URL: ${source.url}`);
  if (source.filename) lines.push(`Original file name: ${source.filename}`);
  if (source.localPath) {
    if (source.extractedText) {
      lines.push(`Extracted text from local file ${source.localPath}:`);
      lines.push(clipText(source.extractedText, MAX_SOURCE_CHARS));
    } else if (source.extractionError) {
      lines.push(`Text extraction note: ${source.extractionError}`);
    } else {
      lines.push(`Local file path: ${source.localPath}`);
      lines.push("Read this local file if needed before summarizing.");
    }
  } else if (source.localPathError) {
    lines.push(`Stored file could not be downloaded: ${source.localPathError}`);
  } else if (source.remoteFilePath) {
    lines.push("Stored file is listed but was not downloaded.");
  }
  if (source.text) {
    lines.push("Text:");
    lines.push(clipText(source.text, MAX_SOURCE_CHARS));
  }
  if (source.url && !source.text && !source.localPath) {
    lines.push("Open or search this URL if your environment allows it. If it cannot be accessed, say that source text is needed instead of guessing.");
  }
  return lines.join("\n");
}

function extractLocalText(localPath, source) {
  const filename = String(source.filename || localPath).toLowerCase();
  const mimeType = String(source.mimeType || "").toLowerCase();
  if (filename.endsWith(".pdf") || mimeType === "application/pdf") {
    const extracted = runTextCommand("pdftotext", ["-layout", "-enc", "UTF-8", localPath, "-"]);
    if (extracted.text) return extracted;
    const ocr = ocrPdfToText(localPath);
    if (ocr.text) return ocr;
    return {
      text: "",
      error: [
        extracted.error || "pdftotext did not produce readable text.",
        ocr.error || "OCR did not produce readable text."
      ].join(" ")
    };
  }
  if (filename.endsWith(".docx") || mimeType.includes("officedocument.wordprocessingml.document")) {
    const xml = runTextCommand("unzip", ["-p", localPath, "word/document.xml"]);
    if (!xml.text) return xml;
    const text = xmlToText(xml.text);
    return isUsefulExtractedText(text)
      ? { text, error: "" }
      : { text: "", error: "Word file text extraction did not produce readable text." };
  }
  if (/\.(txt|md|markdown|csv|json|html?|rtf)$/i.test(filename) || mimeType.startsWith("text/")) {
    const text = normalizeExtractedText(fs.readFileSync(localPath, "utf8"));
    return isUsefulExtractedText(text)
      ? { text, error: "" }
      : { text: "", error: "Text file did not contain enough readable text." };
  }
  return { text: "", error: "" };
}

function textExtractionExpected(source) {
  const filename = String(source.filename || "").toLowerCase();
  const mimeType = String(source.mimeType || "").toLowerCase();
  return filename.endsWith(".pdf")
    || filename.endsWith(".docx")
    || filename.endsWith(".txt")
    || filename.endsWith(".md")
    || filename.endsWith(".markdown")
    || filename.endsWith(".html")
    || filename.endsWith(".htm")
    || mimeType === "application/pdf"
    || mimeType.includes("officedocument.wordprocessingml.document")
    || mimeType.startsWith("text/");
}

function runTextCommand(command, args) {
  const binary = optionalCommandPath(command);
  if (!binary) return { text: "", error: `${command} is not installed.` };
  const result = spawnSync(binary, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 60 * 1000,
    maxBuffer: 20 * 1024 * 1024
  });
  if (result.error) return { text: "", error: result.error.message || String(result.error) };
  if (result.status !== 0) {
    return { text: "", error: commandError(command, result) };
  }
  const text = normalizeExtractedText(result.stdout || "");
  return isUsefulExtractedText(text)
    ? { text, error: "" }
    : { text: "", error: `${command} did not produce readable text.` };
}

function ocrPdfToText(localPath) {
  const pdftoppm = optionalCommandPath("pdftoppm");
  const tesseract = optionalCommandPath("tesseract");
  if (!pdftoppm) return { text: "", error: "OCR support is missing pdftoppm." };
  if (!tesseract) {
    return {
      text: "",
      error: "OCR support is missing tesseract. Install tesseract-ocr and tesseract-ocr-heb."
    };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "summary-html-desk-ocr-"));
  try {
    const imagePrefix = path.join(tempDir, "page");
    const render = spawnSync(pdftoppm, [
      "-r", String(OCR_DPI),
      "-png",
      "-f", "1",
      "-l", String(OCR_MAX_PAGES),
      localPath,
      imagePrefix
    ], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 3 * 60 * 1000,
      maxBuffer: 20 * 1024 * 1024
    });
    if (render.error) return { text: "", error: render.error.message || String(render.error) };
    if (render.status !== 0) return { text: "", error: commandError("pdftoppm", render) };

    const images = fs.readdirSync(tempDir)
      .filter((name) => /^page-\d+\.png$/i.test(name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((name) => path.join(tempDir, name));
    if (!images.length) return { text: "", error: "OCR rendering did not create page images." };

    const pageTexts = [];
    for (const imagePath of images) {
      const page = spawnSync(tesseract, [imagePath, "stdout", "-l", OCR_LANGS, "--psm", OCR_PSM], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: 3 * 60 * 1000,
        maxBuffer: 20 * 1024 * 1024
      });
      if (page.error) return { text: "", error: page.error.message || String(page.error) };
      if (page.status !== 0) return { text: "", error: commandError("tesseract", page) };
      pageTexts.push(page.stdout || "");
    }

    const text = normalizeExtractedText(pageTexts.join("\n\n"));
    return isUsefulExtractedText(text)
      ? { text, error: "" }
      : { text: "", error: "OCR ran but did not produce readable text." };
  } finally {
    if (process.env.KEEP_OCR_TEMP !== "1") {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

function commandError(command, result) {
  const details = [result.stderr, result.stdout]
    .filter(Boolean)
    .join("\n")
    .trim();
  return details || `${command} exited with status ${result.status}`;
}

function optionalCommandPath(command) {
  const result = spawnSync("bash", ["-lc", `command -v ${command}`], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function xmlToText(xml) {
  return normalizeExtractedText(String(xml || "")
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'"));
}

function normalizeExtractedText(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function isUsefulExtractedText(text) {
  const value = String(text || "");
  const wordChars = (value.match(/[\p{L}\p{N}]/gu) || []).length;
  return value.length >= 80 && wordChars >= 40;
}

function makeCmsHtml(input) {
  const cleaned = stripMarkdownFence(input).trim();
  if (!cleaned) return "";
  if (looksLikeHtml(cleaned)) return sanitizeGeneratedHtml(cleaned);
  return markdownishToHtml(cleaned);
}

function stripMarkdownFence(value) {
  return String(value || "").replace(/^```(?:html)?\s*/i, "").replace(/\s*```$/i, "");
}

function looksLikeHtml(value) {
  return /<(p|h[1-6]|ul|ol|li|blockquote|strong|em|a|br)\b/i.test(value);
}

function sanitizeGeneratedHtml(html) {
  const sanitized = String(html || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*[^\s>]+/gi, "")
    .replace(/\s+href\s*=\s*(['"])\s*javascript:[\s\S]*?\1/gi, "")
    .trim();
  return ensureBlankAnchorTargets(sanitized);
}

function ensureBlankAnchorTargets(html) {
  return String(html || "").replace(/<a\b([^>]*)>/gi, (match, attrs) => {
    if (!/\bhref\s*=/i.test(attrs)) return match;
    const normalizedAttrs = attrs
      .replace(/\s+target\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      .replace(/\s+rel\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      .trim();
    return `<a${normalizedAttrs ? ` ${normalizedAttrs}` : ""} target="_blank" rel="noopener noreferrer">`;
  });
}

function markdownishToHtml(text) {
  const blocks = String(text || "").split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
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
    return href ? linkHtml(href, label) : label;
  });
  escaped = escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  escaped = escaped.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return escaped;
}

function linkHtml(href, children) {
  return `<a href="${escapeAttribute(href)}" target="_blank" rel="noopener noreferrer">${children}</a>`;
}

function sanitizeHref(href) {
  const trimmed = String(href || "").trim();
  if (!trimmed) return "";
  if (/^(https?:|mailto:|tel:|#|\/)/i.test(trimmed)) return trimmed;
  return "";
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

function defaultPromptFromDraft(draft) {
  const language = draft.language === "same" ? "the same language as the source material" : (draft.language || "Hebrew");
  const paragraphCount = clamp(Number(draft.paragraphCount || 3), 1, 8);
  const shape = {
    paragraphs: `${paragraphCount} concise paragraphs`,
    "heading-paragraphs": "one short heading followed by concise paragraphs",
    "brief-list": "one short heading followed by a compact bullet list"
  }[draft.shape] || `${paragraphCount} concise paragraphs`;
  const tone = {
    neutral: "neutral and factual",
    academic: "careful, evidence-aware, and academic",
    plain: "plain, direct, and readable"
  }[draft.tone] || "neutral and factual";

  return [
    "You are preparing copy for a content management system.",
    `Write in ${language}.`,
    `Use a ${tone} tone.`,
    `Return ${shape}.`,
    "Return only editable summary text. Do not return HTML.",
    "Use blank lines between paragraphs. For a list, use simple bullet lines.",
    "Preserve important names, dates, numbers, and causal claims. Do not invent facts."
  ].join("\n");
}

function findNextPendingDraft(drafts) {
  return [...(drafts || [])]
    .filter((draft) => draft.status === "pending")
    .sort((a, b) => String(a.queuedAt || a.updatedAt || "").localeCompare(String(b.queuedAt || b.updatedAt || "")))[0] || null;
}

function finalizeDraft(draftId, runId, updateDraft, message) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const freshState = loadSharedState();
    if (!freshState) throw new Error("Shared work list disappeared while processing.");
    const freshDraft = freshState.drafts.find((item) => item.id === draftId);
    if (!freshDraft) throw new Error("Item disappeared while processing.");
    if (freshDraft.processingRunId && freshDraft.processingRunId !== runId) {
      log(`Skipping stale processing result for ${draftId}.`);
      return;
    }
    updateDraft(freshDraft);

    try {
      saveSharedState(freshState, message);
      return;
    } catch (error) {
      if (attempt < 4 && isGithubConflict(error)) {
        sleep(500 * attempt);
        continue;
      }
      throw error;
    }
  }
}

function updateSharedDraftWithRetry(draftId, updateDraft, message) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const freshState = loadSharedState();
    if (!freshState) throw new Error("Shared work list disappeared while processing.");
    const freshDraft = freshState.drafts.find((item) => item.id === draftId);
    if (!freshDraft) throw new Error("Item disappeared while processing.");
    updateDraft(freshDraft);

    try {
      saveSharedState(freshState, message);
      return freshDraft;
    } catch (error) {
      if (attempt < 4 && isGithubConflict(error)) {
        sleep(500 * attempt);
        continue;
      }
      throw error;
    }
  }
  throw new Error("Could not update shared draft after repeated GitHub conflicts.");
}

function loadSharedState() {
  const text = githubGetTextContent(STATE_PATH);
  if (!text) return null;
  const payload = JSON.parse(text);
  if (!Array.isArray(payload.drafts)) payload.drafts = [];
  return payload;
}

function saveSharedState(payload, message) {
  const nextPayload = {
    ...payload,
    version: payload.version || 1,
    app: payload.app || "summary-html-desk",
    updatedAt: new Date().toISOString(),
    drafts: Array.isArray(payload.drafts) ? payload.drafts : []
  };
  githubPutContent(STATE_PATH, Buffer.from(JSON.stringify(nextPayload), "utf8").toString("base64"), message);
}

function githubGetContent(remotePath) {
  const endpoint = `${contentEndpoint(remotePath)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
  const result = runGh(["--method", "GET", "-H", "Accept: application/vnd.github+json", endpoint], { allow404: true });
  if (!result) return null;
  return JSON.parse(result);
}

function githubGetTextContent(remotePath) {
  const item = githubGetContent(remotePath);
  if (!item) return "";
  if (item.content) {
    return Buffer.from(stripBase64Whitespace(item.content), "base64").toString("utf8");
  }
  return githubGetRaw(remotePath).toString("utf8");
}

function githubGetRaw(remotePath) {
  const endpoint = `${contentEndpoint(remotePath)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
  return runGh(["--method", "GET", "-H", "Accept: application/vnd.github.raw", endpoint], { raw: true });
}

function githubPutContent(remotePath, base64Content, message) {
  const existing = githubGetContent(remotePath);
  const body = {
    message,
    content: stripBase64Whitespace(base64Content),
    branch: GITHUB_BRANCH
  };
  if (existing?.sha) body.sha = existing.sha;
  runGh(["--method", "PUT", "-H", "Accept: application/vnd.github+json", contentEndpoint(remotePath), "--input", "-"], {
    input: JSON.stringify(body)
  });
}

function contentEndpoint(remotePath) {
  const encodedPath = String(remotePath || "").split("/").map(encodeURIComponent).join("/");
  return `/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_REPO)}/contents/${encodedPath}`;
}

function runGh(args, options = {}) {
  const result = spawnSync(GH_BIN, ["api", ...args], {
    cwd: REPO_ROOT,
    input: options.input,
    encoding: options.raw ? null : "utf8",
    maxBuffer: 100 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : String(result.stderr || "");
    if (options.allow404 && /HTTP 404|Not Found/i.test(stderr)) return null;
    throw new Error(stderr.trim() || `gh api exited with status ${result.status}`);
  }
  return result.stdout;
}

function isGithubConflict(error) {
  return /HTTP 409|expected [a-f0-9]{40}/i.test(error?.message || String(error));
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function commandPath(command) {
  const result = spawnSync("bash", ["-lc", `command -v ${command}`], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} is not installed or is not in PATH.`);
  return result.stdout.trim() || command;
}

function readResultText(resultPath) {
  if (!fs.existsSync(resultPath)) return "";
  return fs.readFileSync(resultPath, "utf8")
    .replace(/^```(?:html|text|markdown)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function clipText(text, maxLength) {
  const value = String(text || "");
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n\n[Source text clipped at ${maxLength} characters.]`;
}

function stripBase64Whitespace(value) {
  return String(value || "").replace(/\s/g, "");
}

function safeFilename(value) {
  const fallback = "source-file";
  const filename = String(value || fallback).trim() || fallback;
  const dotIndex = filename.lastIndexOf(".");
  const extension = dotIndex > 0 ? filename.slice(dotIndex).toLowerCase().replace(/[^a-z0-9.]/g, "") : "";
  const base = dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
  const safeBase = safePathPart(base).slice(0, 80) || "source";
  return `${safeBase}${extension}`;
}

function safePathPart(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "item";
}

function cleanBasePath(value) {
  return String(value || "summary-html-desk").trim().replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/") || "summary-html-desk";
}

function clamp(value, min, max) {
  const numeric = Number.isFinite(value) ? value : min;
  return Math.min(Math.max(numeric, min), max);
}

function log(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${message}${os.EOL}`);
}

function fail(message) {
  process.stderr.write(`[${new Date().toISOString()}] ${message}${os.EOL}`);
  process.exit(1);
}
