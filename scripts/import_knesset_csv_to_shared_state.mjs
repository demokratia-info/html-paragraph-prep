#!/usr/bin/env node
"use strict";

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CSV = path.join(REPO_ROOT, "downloads", "knesset-opinion-pdfs", "knesset_opinion_pdfs.csv");
const DATA_REPO = process.env.DATA_REPO || "demokratia-info/html-paragraph-prep-data";
const [GITHUB_OWNER, GITHUB_REPO] = DATA_REPO.split("/");
const GITHUB_BRANCH = process.env.DATA_BRANCH || "main";
const DATA_BASE_PATH = cleanBasePath(process.env.DATA_BASE_PATH || "summary-html-desk");
const STATE_PATH = `${DATA_BASE_PATH}/drafts.json`;
const DEFAULT_PROMPT_PATH = `${DATA_BASE_PATH}/default-prompt.txt`;
const DEFAULT_DRAFT_TITLE = "מקור חדש";

const GH_BIN = commandPath("gh");

main();

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const rows = parseCsv(fs.readFileSync(options.csv, "utf8")).filter((row) => {
    return String(row.accepted || "").trim().toLowerCase() === "yes" && row.url;
  });
  if (!rows.length) throw new Error(`No accepted rows found in ${options.csv}`);

  const prompt = loadDefaultPrompt();
  const state = loadSharedState() || {
    version: 1,
    app: "summary-html-desk",
    updatedAt: null,
    drafts: []
  };
  if (!Array.isArray(state.drafts)) state.drafts = [];

  const seen = existingSourceKeys(state.drafts);
  const now = new Date();
  const imported = [];
  const skipped = [];

  rows.forEach((row, index) => {
    const url = normalizeUrl(row.url);
    const basename = urlBasename(url);
    if (seen.urls.has(url) || seen.basenames.has(basename)) {
      skipped.push(row);
      return;
    }

    const draft = createDraftFromRow(row, prompt, new Date(now.getTime() + index * 1000).toISOString());
    imported.push(draft);
    state.drafts.push(draft);
    seen.urls.add(url);
    seen.basenames.add(basename);
  });

  state.drafts.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));

  if (options.dryRun) {
    console.log(`Would import ${imported.length} drafts and skip ${skipped.length} existing sources.`);
    return;
  }

  saveSharedState(state, `Import ${imported.length} Knesset opinion PDF sources`);
  console.log(`Imported ${imported.length} drafts.`);
  console.log(`Skipped ${skipped.length} existing sources.`);
  console.log(`Shared draft count: ${state.drafts.length}`);
}

function parseArgs(args) {
  const options = {
    csv: DEFAULT_CSV,
    dryRun: false,
    help: false
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--csv") options.csv = path.resolve(readValue(args, ++i, arg));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function readValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value.`);
  return value;
}

function printHelp() {
  console.log(`Usage:
  node scripts/import_knesset_csv_to_shared_state.mjs [options]

Options:
  --csv PATH     CSV from download_knesset_opinion_pdfs.mjs.
  --dry-run      Report import count without updating shared state.
`);
}

function createDraftFromRow(row, prompt, timestamp) {
  const documentId = String(row.document_bill_id || urlBasename(row.url).replace(/\D/g, "") || Date.now());
  const url = normalizeUrl(row.url);
  const filename = urlBasename(url);
  const title = buildTitle(row, filename);
  const localPath = String(row.local_path || "").trim();
  return {
    id: `knesset-${documentId}`,
    title,
    sources: [
      {
        id: `knesset-source-${documentId}`,
        type: "link",
        title: filename,
        url,
        text: "",
        filename,
        mimeType: "application/pdf",
        size: 0,
        textAvailable: false,
        fileAvailable: false,
        fileStored: false,
        remoteFilePath: "",
        localPath,
        createdAt: timestamp
      }
    ],
    language: "Hebrew",
    shape: "paragraphs",
    paragraphCount: 3,
    tone: "neutral",
    includeLinks: true,
    prompt,
    result: "",
    regenerationBaseResult: "",
    html: "",
    direction: "auto",
    status: "pending",
    queuedAt: timestamp,
    processingStartedAt: "",
    processedAt: "",
    exportedAt: "",
    htmlCreatedAt: "",
    editedAfterGeneration: false,
    processingError: "",
    processingRunId: "",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function buildTitle(row, filename) {
  const billName = String(row.bill_name || "").trim();
  const cleanFilename = filename.replace(/\.pdf$/i, "");
  if (!billName) return cleanFilename || DEFAULT_DRAFT_TITLE;
  return `${billName} - ${cleanFilename}`;
}

function existingSourceKeys(drafts) {
  const urls = new Set();
  const basenames = new Set();
  for (const draft of drafts || []) {
    for (const source of draft.sources || []) {
      if (source.url) {
        const url = normalizeUrl(source.url);
        urls.add(url);
        basenames.add(urlBasename(url));
      }
      if (source.remoteFilePath) {
        basenames.add(path.basename(String(source.remoteFilePath || "")));
      }
      if (source.filename) {
        basenames.add(path.basename(String(source.filename || "")));
      }
    }
  }
  return { urls, basenames };
}

function loadDefaultPrompt() {
  return String(githubGetTextContent(DEFAULT_PROMPT_PATH) || "").trim();
}

function loadSharedState() {
  const text = githubGetTextContent(STATE_PATH);
  return text ? JSON.parse(text) : null;
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

function parseCsv(text) {
  const rows = csvRows(String(text || "").replace(/^\ufeff/, ""));
  if (!rows.length) return [];
  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1).filter((row) => row.some((cell) => String(cell || "").trim())).map((row) => {
    const item = {};
    headers.forEach((header, index) => {
      item[header] = row[index] || "";
    });
    return item;
  });
}

function csvRows(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

function normalizeUrl(url) {
  const parsed = new URL(String(url || "").replace("https://fs.knesset.gov.il//", "https://fs.knesset.gov.il/"));
  parsed.protocol = "https:";
  return parsed.href;
}

function urlBasename(url) {
  return path.basename(new URL(url).pathname);
}

function cleanBasePath(value) {
  return String(value || "summary-html-desk").trim().replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/") || "summary-html-desk";
}

function stripBase64Whitespace(value) {
  return String(value || "").replace(/\s/g, "");
}

function commandPath(command) {
  const result = spawnSync("bash", ["-lc", `command -v ${command}`], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} is not installed or is not in PATH.`);
  return result.stdout.trim() || command;
}
