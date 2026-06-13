#!/usr/bin/env node
"use strict";

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  closePool,
  isPostgresRemoteFilePath,
  loadSharedState,
  saveDefaultPrompt,
  saveSharedState,
  saveSourceFile
} from "../server/postgres-storage.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_REPO = process.env.DATA_REPO || "demokratia-info/html-paragraph-prep-data";
const [GITHUB_OWNER, GITHUB_REPO] = DATA_REPO.split("/");
const GITHUB_BRANCH = process.env.DATA_BRANCH || "main";
const DATA_BASE_PATH = cleanBasePath(process.env.DATA_BASE_PATH || "summary-html-desk");
const STATE_PATH = `${DATA_BASE_PATH}/drafts.json`;
const DEFAULT_PROMPT_PATH = `${DATA_BASE_PATH}/default-prompt.txt`;
const GH_BIN = commandPath("gh");

if (!GITHUB_OWNER || !GITHUB_REPO) {
  fail("DATA_REPO must look like owner/repo.");
}

try {
  const state = await loadGithubJson(STATE_PATH);
  if (!state || !Array.isArray(state.drafts)) {
    fail(`Could not load ${DATA_REPO}/${STATE_PATH}.`);
  }

  const prompt = loadGithubText(DEFAULT_PROMPT_PATH) || readLocalPrompt();
  if (prompt.trim()) {
    await saveDefaultPrompt(prompt.trim());
  }

  await saveSharedState({
    ...state,
    version: state.version || 1,
    app: state.app || "summary-html-desk",
    updatedAt: new Date().toISOString()
  });

  const missingFiles = [];
  let migratedFiles = 0;

  for (const draft of state.drafts) {
    if (!Array.isArray(draft.sources)) draft.sources = [];
    for (const source of draft.sources) {
      if (!source?.id || isPostgresRemoteFilePath(source.remoteFilePath)) continue;

      const loaded = loadSourceFile(source);
      if (!loaded) continue;

      try {
        const saved = await saveSourceFile({
          ...source,
          draftId: draft.id,
          filename: source.filename || loaded.filename || source.title || "source-file",
          mimeType: source.mimeType || loaded.mimeType || guessMimeType(loaded.filename || source.filename || ""),
          size: loaded.buffer.length
        }, loaded.buffer);
        source.remoteFilePath = saved.remoteFilePath;
        source.fileAvailable = true;
        source.fileStored = false;
        migratedFiles += 1;
      } catch (error) {
        missingFiles.push({
          draftId: draft.id,
          sourceId: source.id,
          filename: source.filename || source.title || "",
          reason: error.message || String(error)
        });
      }
    }
  }

  await saveSharedState({
    ...state,
    version: state.version || 1,
    app: state.app || "summary-html-desk",
    updatedAt: new Date().toISOString()
  });

  const loaded = await loadSharedState();
  process.stdout.write(`${JSON.stringify({
    ok: true,
    importedDrafts: loaded.drafts.length,
    importedDefaultPrompt: Boolean(prompt.trim()),
    migratedSourceFiles: migratedFiles,
    missingSourceFiles: missingFiles
  }, null, 2)}\n`);
} finally {
  await closePool();
}

function loadSourceFile(source) {
  const local = resolveLocalPath(source.localPath);
  if (local) {
    return {
      filename: source.filename || path.basename(local),
      mimeType: source.mimeType || guessMimeType(local),
      buffer: fs.readFileSync(local)
    };
  }

  if (source.remoteFilePath) {
    const buffer = loadGithubRaw(source.remoteFilePath, { allow404: true });
    if (buffer) {
      return {
        filename: source.filename || path.basename(source.remoteFilePath),
        mimeType: source.mimeType || guessMimeType(source.remoteFilePath),
        buffer
      };
    }
  }

  return null;
}

function resolveLocalPath(localPath) {
  const value = String(localPath || "").trim();
  if (!value) return "";
  const resolved = path.isAbsolute(value) ? value : path.resolve(REPO_ROOT, value);
  const relative = path.relative(REPO_ROOT, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return "";
  return fs.existsSync(resolved) ? resolved : "";
}

async function loadGithubJson(remotePath) {
  const raw = loadGithubRaw(remotePath);
  return JSON.parse(raw.toString("utf8"));
}

function loadGithubText(remotePath) {
  const raw = loadGithubRaw(remotePath, { allow404: true });
  return raw ? raw.toString("utf8") : "";
}

function loadGithubRaw(remotePath, options = {}) {
  const endpoint = `${contentEndpoint(remotePath)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
  const result = spawnSync(GH_BIN, ["api", "--method", "GET", "-H", "Accept: application/vnd.github.raw", endpoint], {
    cwd: REPO_ROOT,
    encoding: null,
    maxBuffer: 500 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : String(result.stderr || "");
    if (options.allow404 && /HTTP 404|Not Found/i.test(stderr)) return null;
    throw new Error(stderr.trim() || `gh api exited with status ${result.status}`);
  }
  return result.stdout;
}

function contentEndpoint(remotePath) {
  const encodedPath = String(remotePath || "").split("/").map(encodeURIComponent).join("/");
  return `/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_REPO)}/contents/${encodedPath}`;
}

function readLocalPrompt() {
  const promptPath = path.join(REPO_ROOT, "prompt.txt");
  return fs.existsSync(promptPath) ? fs.readFileSync(promptPath, "utf8") : "";
}

function guessMimeType(filename) {
  const lower = String(filename || "").toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (lower.endsWith(".doc")) return "application/msword";
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  if (lower.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

function cleanBasePath(value) {
  return String(value || "summary-html-desk").trim().replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/") || "summary-html-desk";
}

function commandPath(command) {
  const result = spawnSync("bash", ["-lc", `command -v ${command}`], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} is not installed or is not in PATH.`);
  return result.stdout.trim() || command;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
