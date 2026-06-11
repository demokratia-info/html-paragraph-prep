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
const MAX_PENDING_PER_RUN = clamp(Number(process.env.MAX_PENDING_PER_RUN || 1), 1, 20);
const MAX_SOURCE_CHARS = clamp(Number(process.env.MAX_SOURCE_CHARS || 120000), 1000, 500000);
const CODEX_TIMEOUT_MS = clamp(Number(process.env.CODEX_TIMEOUT_MS || 45 * 60 * 1000), 60 * 1000, 3 * 60 * 60 * 1000);
const PROCESSING_ROOT = path.join(REPO_ROOT, ".codex-processing");

if (!GITHUB_OWNER || !GITHUB_REPO) {
  fail("DATA_REPO must look like owner/repo.");
}

main().catch((error) => {
  fail(error?.stack || error?.message || String(error));
});

async function main() {
  requireCommand("gh");
  requireCommand("codex");
  ensureDir(PROCESSING_ROOT);

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

    await processDraft(state, draft);
    processed += 1;
  }

  log(`Processed ${processed} item${processed === 1 ? "" : "s"}.`);
}

async function processDraft(state, draft) {
  const runId = `${Date.now()}-${process.pid}-${safePathPart(draft.id)}`;
  const now = new Date().toISOString();
  const draftInState = state.drafts.find((item) => item.id === draft.id);
  draftInState.status = "processing";
  draftInState.processingStartedAt = now;
  draftInState.processingRunId = runId;
  draftInState.processingError = "";
  saveSharedState(state, `Start processing ${draft.title || draft.id}`);

  const workDir = path.join(PROCESSING_ROOT, safePathPart(draft.id), runId);
  ensureDir(workDir);
  ensureDir(path.join(workDir, "sources"));

  try {
    const preparedSources = prepareSources(draftInState, workDir);
    const prompt = buildCodexPrompt(draftInState, preparedSources);
    const promptPath = path.join(workDir, "prompt.txt");
    const resultPath = path.join(workDir, "result.txt");
    fs.writeFileSync(promptPath, prompt, "utf8");

    runCodex(prompt, resultPath);
    const resultText = readResultText(resultPath);
    if (!resultText) throw new Error("Codex finished without returning summary text.");

    finalizeDraft(draft.id, runId, (freshDraft) => {
      freshDraft.result = resultText;
      freshDraft.status = "done";
      freshDraft.processedAt = new Date().toISOString();
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

function prepareSources(draft, workDir) {
  return (draft.sources || []).map((source, index) => {
    const prepared = { ...source, localPath: "", localPathError: "" };
    if (source.remoteFilePath) {
      try {
        const raw = githubGetRaw(source.remoteFilePath);
        const filename = `${String(index + 1).padStart(2, "0")}-${safeFilename(source.filename || source.title || `source-${index + 1}`)}`;
        const localPath = path.join(workDir, "sources", filename);
        fs.writeFileSync(localPath, raw);
        prepared.localPath = localPath;
      } catch (error) {
        prepared.localPathError = error?.message || String(error);
      }
    }
    return prepared;
  });
}

function runCodex(prompt, resultPath) {
  const args = [];
  if (process.env.CODEX_SEARCH !== "0") args.push("--search");
  args.push("exec", "--cd", REPO_ROOT, "--sandbox", process.env.CODEX_SANDBOX || "workspace-write");
  args.push("--ask-for-approval", "never", "--output-last-message", resultPath);
  if (process.env.CODEX_MODEL) args.push("-m", process.env.CODEX_MODEL);
  if (process.env.CODEX_REASONING_EFFORT) {
    args.push("-c", `model_reasoning_effort="${process.env.CODEX_REASONING_EFFORT}"`);
  }
  args.push("-");

  const result = spawnSync("codex", args, {
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

function buildCodexPrompt(draft, sources) {
  const savedPrompt = String(draft.prompt || "").trim() || defaultPromptFromDraft(draft);
  const previousResult = String(draft.result || "").trim();
  const previousInstruction = previousResult
    ? [
      "This item already has a previous result.",
      "Treat the previous result as the base text.",
      "Keep it as similar as possible and only change what is needed to satisfy the latest saved prompt and source material.",
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
    "Latest saved prompt:",
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
    lines.push(`Local file path: ${source.localPath}`);
    lines.push("Read this local file if needed before summarizing.");
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
  const freshState = loadSharedState();
  if (!freshState) throw new Error("Shared work list disappeared while processing.");
  const freshDraft = freshState.drafts.find((item) => item.id === draftId);
  if (!freshDraft) throw new Error("Item disappeared while processing.");
  if (freshDraft.processingRunId && freshDraft.processingRunId !== runId) {
    log(`Skipping stale processing result for ${draftId}.`);
    return;
  }
  updateDraft(freshDraft);
  saveSharedState(freshState, message);
}

function loadSharedState() {
  const item = githubGetContent(STATE_PATH);
  if (!item?.content) return null;
  const payload = JSON.parse(Buffer.from(stripBase64Whitespace(item.content), "base64").toString("utf8"));
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
  githubPutContent(STATE_PATH, Buffer.from(JSON.stringify(nextPayload, null, 2), "utf8").toString("base64"), message);
}

function githubGetContent(remotePath) {
  const endpoint = `${contentEndpoint(remotePath)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
  const result = runGh(["--method", "GET", "-H", "Accept: application/vnd.github+json", endpoint], { allow404: true });
  if (!result) return null;
  return JSON.parse(result);
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
  const result = spawnSync("gh", ["api", ...args], {
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

function requireCommand(command) {
  const result = spawnSync("bash", ["-lc", `command -v ${command}`], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} is not installed or is not in PATH.`);
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
