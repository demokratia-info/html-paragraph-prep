import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import {
  checkStorage,
  getSourceFile,
  httpError,
  initDatabase,
  loadDefaultPrompt,
  loadSharedState,
  saveDefaultPrompt,
  saveSharedState,
  saveSourceFile
} from "./postgres-storage.mjs";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_PORT = 8787;
const MAX_JSON_BODY = "80mb";
const DEFAULT_ALLOWED_ORIGINS = [
  "https://demokratia-info.github.io",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  "http://localhost:4173",
  "http://127.0.0.1:4173"
];

await initDatabase();

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || MAX_JSON_BODY }));
app.use(corsMiddleware);

app.get("/health", async (request, response) => {
  response.json({
    ok: true,
    storage: await checkStorage()
  });
});

app.options("/", (request, response) => {
  response.status(204).end();
});

app.post("/", async (request, response) => {
  try {
    await requireEditorPassword(request);
    const payload = request.body || {};

    switch (payload.action || "loadSharedState") {
      case "saveSourceFile":
        return response.json(await saveSourceFile({
          ...(payload.source || {}),
          draftId: payload.draftId || payload.source?.draftId || null
        }, payload.fileData));
      case "saveSharedState":
        return response.json(await saveSharedState(payload.payload));
      case "loadSharedState":
        return response.json(await loadSharedState());
      case "loadDefaultPrompt":
        return response.json(await loadDefaultPrompt({
          localPromptFallback: readLocalPrompt()
        }));
      case "saveDefaultPrompt":
        return response.json(await saveDefaultPrompt(payload.prompt));
      case "getSourceFile":
        return response.json(await getSourceFile(payload.remoteFilePath));
      case "checkStorage":
        return response.json(await checkStorage());
      case "summarize":
        throw httpError("The local PostgreSQL API does not run OpenAI directly. Use Save for Processing so the local Codex cron can process the item.", 400);
      default:
        throw httpError("Unknown action.", 400);
    }
  } catch (error) {
    const status = error.status || 500;
    response.status(status).json({
      error: error.message || "Request failed."
    });
  }
});

const port = Number(process.env.PORT || DEFAULT_PORT);
app.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Summary HTML Desk local API listening on http://127.0.0.1:${port}\n`);
});

function corsMiddleware(request, response, next) {
  const origin = request.headers.origin || "";
  const allowed = allowedOrigins();
  const allowOrigin = !origin
    ? allowed[0] || "*"
    : allowed.includes(origin)
      ? origin
      : "";

  if (allowOrigin) {
    response.setHeader("Access-Control-Allow-Origin", allowOrigin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Editor-Password");

  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }
  next();
}

function allowedOrigins() {
  return String(process.env.ALLOWED_ORIGIN || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .concat(DEFAULT_ALLOWED_ORIGINS)
    .filter((value, index, array) => array.indexOf(value) === index);
}

async function requireEditorPassword(request) {
  const supplied = normalizeEditorPassword(request.headers["x-editor-password"] || request.body?.editorPassword || "");
  const plain = process.env.EDITOR_PASSWORD || "";
  const hash = String(process.env.EDITOR_PASSWORD_SHA256 || "").trim().toLowerCase();

  if (!plain && !hash) {
    if (!supplied.trim()) throw httpError("Enter the editor password.", 401);
    return;
  }

  const valid = hash
    ? safeEqual(sha256Hex(supplied), hash)
    : safeEqual(supplied, plain);
  if (!valid) throw httpError("Invalid editor password.", 401);
}

function normalizeEditorPassword(value) {
  let text = String(value || "").trim();
  if (/^EDITOR_PASSWORD\s*=/i.test(text)) {
    text = text.replace(/^EDITOR_PASSWORD\s*=/i, "").trim();
  }
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function readLocalPrompt() {
  const promptPath = path.join(REPO_ROOT, "prompt.txt");
  if (!fs.existsSync(promptPath)) return "";
  return fs.readFileSync(promptPath, "utf8").trim();
}
