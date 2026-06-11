"use strict";

const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_OWNER = "demokratia-info";
const DEFAULT_DATA_REPO = "html-paragraph-prep-data";
const DEFAULT_BRANCH = "main";
const DEFAULT_BASE_PATH = "summary-html-desk";
const DEFAULT_REASONING_EFFORT = "xhigh";
const MAX_TEXT_SOURCE_CHARS = 120000;
const MAX_FILE_DATA_CHARS = 28 * 1024 * 1024;

export default {
  async fetch(request, env) {
    const corsHeaders = buildCorsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return json({ error: "Use POST." }, 405, corsHeaders);
    }

    try {
      const payload = await request.json();
      await requireEditorPassword(request, payload, env);

      switch (payload.action || "summarize") {
        case "summarize":
          return json(await summarize(payload, env), 200, corsHeaders);
        case "saveSourceFile":
          return json(await saveSourceFile(payload, env), 200, corsHeaders);
        case "saveSharedState":
          return json(await saveSharedState(payload, env), 200, corsHeaders);
        case "loadSharedState":
          return json(await loadSharedState(env), 200, corsHeaders);
        case "getSourceFile":
          return json(await getSourceFile(payload, env), 200, corsHeaders);
        case "checkStorage":
          return json(await checkStorage(env), 200, corsHeaders);
        default:
          return json({ error: "Unknown action." }, 400, corsHeaders);
      }
    } catch (error) {
      const status = error.status || 400;
      return json({ error: error.message || "Request failed." }, status, corsHeaders);
    }
  }
};

async function summarize(payload, env) {
  if (!env.OPENAI_API_KEY) {
    throw httpError("OPENAI_API_KEY is not configured.", 500);
  }

  const openaiPayload = await buildOpenAiPayload(payload, env);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(openaiPayload)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw httpError(data?.error?.message || `OpenAI returned ${response.status}`, response.status);
  }

  return {
    text: collectOutputText(data),
    model: data.model || openaiPayload.model,
    usage: data.usage || null
  };
}

async function buildOpenAiPayload(payload, env) {
  const options = payload.options || {};
  const sources = Array.isArray(payload.sources) ? payload.sources : [];
  const content = [
    {
      type: "input_text",
      text: buildInstructions(payload, options, sources)
    }
  ];

  for (const source of sources) {
    if (source.fileData && source.fileData.length <= MAX_FILE_DATA_CHARS) {
      content.push({
        type: "input_file",
        file_data: source.fileData,
        filename: source.filename || source.title || "source-file"
      });
    } else if (source.remoteFilePath) {
      const item = await githubGetContent(githubConfig(env), source.remoteFilePath);
      if (item?.content && item.content.length <= MAX_FILE_DATA_CHARS) {
        content.push({
          type: "input_file",
          file_data: githubItemDataUrl(item, source),
          filename: source.filename || item.name || source.title || "source-file"
        });
      }
    } else if (source.url && looksLikeFileUrl(source.url)) {
      content.push({
        type: "input_file",
        file_url: source.url,
        filename: source.filename || source.title || "source-url"
      });
    }
  }

  const hasWebLinks = sources.some((source) => source.url && !looksLikeFileUrl(source.url));
  const responsePayload = {
    model: env.OPENAI_MODEL || DEFAULT_MODEL,
    reasoning: buildReasoningConfig(env),
    input: [
      {
        role: "developer",
        content: [
          {
            type: "input_text",
            text: "You create accurate, CMS-ready Hebrew HTML summaries from provided sources. Return only the requested HTML and do not invent facts."
          }
        ]
      },
      {
        role: "user",
        content
      }
    ],
    max_output_tokens: Number(env.MAX_OUTPUT_TOKENS || 2400),
    store: false
  };
  if (hasWebLinks) responsePayload.tools = [{ type: "web_search_preview" }];
  return responsePayload;
}

function buildReasoningConfig(env) {
  const effort = String(env.OPENAI_REASONING_EFFORT || DEFAULT_REASONING_EFFORT).trim();
  if (!effort || effort === "default") return undefined;
  return { effort };
}

async function saveSourceFile(payload, env) {
  const source = payload.source || {};
  const fileData = String(payload.fileData || "");
  if (!source.id || !fileData) {
    throw httpError("Missing source id or file data.", 400);
  }

  const config = githubConfig(env);
  const remoteFilePath = source.remoteFilePath || `${config.basePath}/files/${source.id}/${safeRemoteFilename(source.filename || "source-file")}`;
  await githubPutContent(config, remoteFilePath, stripDataUrl(fileData), `Store source file ${source.filename || source.id}`);
  return { remoteFilePath };
}

async function saveSharedState(payload, env) {
  const shared = payload.payload;
  if (!shared || !Array.isArray(shared.drafts)) {
    throw httpError("Missing shared draft payload.", 400);
  }

  const config = githubConfig(env);
  const statePayload = {
    ...shared,
    updatedAt: new Date().toISOString()
  };
  await githubPutContent(
    config,
    sharedStatePath(config),
    utf8ToBase64(JSON.stringify(statePayload, null, 2)),
    "Update shared summary drafts"
  );
  return {
    ok: true,
    updatedAt: statePayload.updatedAt,
    count: shared.drafts.length
  };
}

async function loadSharedState(env) {
  const config = githubConfig(env);
  const item = await githubGetContent(config, sharedStatePath(config));
  if (!item?.content) {
    return {
      version: 1,
      app: "summary-html-desk",
      updatedAt: null,
      drafts: []
    };
  }
  return JSON.parse(base64ToUtf8(item.content));
}

async function getSourceFile(payload, env) {
  const remoteFilePath = String(payload.remoteFilePath || "");
  if (!remoteFilePath) throw httpError("Missing remote file path.", 400);

  const item = await githubGetContent(githubConfig(env), remoteFilePath);
  if (!item?.content) throw httpError("Source file was not found.", 404);
  return {
    filename: item.name || "source-file",
    mimeType: guessMimeType(item.name || remoteFilePath),
    fileData: stripBase64Whitespace(item.content)
  };
}

async function checkStorage(env) {
  const config = githubConfig(env);
  const repo = await githubGetRepo(config);
  const stateItem = await githubGetContent(config, sharedStatePath(config));
  const testPath = `${config.basePath}/diagnostics/worker-write-test.txt`;
  await githubPutContent(
    config,
    testPath,
    utf8ToBase64(`Worker storage test at ${new Date().toISOString()}\n`),
    "Test summary desk storage access"
  );
  return {
    ok: true,
    owner: config.owner,
    repo: config.repo,
    branch: config.branch,
    basePath: config.basePath,
    private: Boolean(repo?.private),
    sharedStateExists: Boolean(stateItem?.content),
    testPath
  };
}

function buildInstructions(payload, options, sources) {
  const language = options.language === "same"
    ? "the same language as the source material"
    : !options.language
      ? "Hebrew"
      : options.language;
  const paragraphCount = clamp(Number(options.paragraphCount || 3), 1, 8);
  const shape = {
    paragraphs: `${paragraphCount} concise <p> paragraphs`,
    "heading-paragraphs": "one short <h2> heading followed by concise <p> paragraphs",
    "brief-list": "one short <h2> heading followed by a compact <ul> list"
  }[options.shape] || `${paragraphCount} concise <p> paragraphs`;
  const tone = {
    neutral: "neutral and factual",
    academic: "careful, evidence-aware, and academic",
    plain: "plain, direct, and readable"
  }[options.tone] || "neutral and factual";

  return [
    `Draft title: ${payload.title || "Untitled summary"}`,
    `Write in ${language}.`,
    `Use a ${tone} tone.`,
    `Return ${shape}.`,
    "Allowed tags: <p>, <h2>, <h3>, <ul>, <ol>, <li>, <strong>, <em>, <a>, and <blockquote>.",
    "Do not include Markdown fences, CSS, inline styles, tables, footnotes, or commentary.",
    "Preserve important Hebrew names, titles, dates, numbers, institutional terms, and causal claims.",
    "Sources and final summaries are usually in Hebrew; keep Hebrew wording natural and avoid unnecessary translation.",
    "For public document URLs, use the file input, file URL, or web search context before summarizing.",
    options.includeLinks ? "Keep useful source links in <a> tags." : "Avoid links unless central to the summary.",
    "",
    "Source index:",
    sources.map(formatSourceIndex).join("\n\n")
  ].join("\n");
}

function formatSourceIndex(source, index) {
  const lines = [`[Source ${index + 1}: ${source.title || source.filename || source.url || "Untitled"}]`];
  if (source.url) lines.push(`URL: ${source.url}`);
  if (source.filename) lines.push(`File: ${source.filename}`);
  if (source.remoteFilePath) lines.push("Private stored file is attached by the backend.");
  if (source.text) lines.push(`Text:\n${clipText(source.text, MAX_TEXT_SOURCE_CHARS)}`);
  if (source.fileData) lines.push("Uploaded file content is included as an input_file item.");
  return lines.join("\n");
}

function githubConfig(env) {
  if (!env.GITHUB_TOKEN) throw httpError("GITHUB_TOKEN is not configured.", 500);
  return {
    token: env.GITHUB_TOKEN,
    owner: env.GITHUB_OWNER || DEFAULT_OWNER,
    repo: env.GITHUB_REPO || DEFAULT_DATA_REPO,
    branch: env.GITHUB_BRANCH || DEFAULT_BRANCH,
    basePath: cleanBasePath(env.GITHUB_BASE_PATH || DEFAULT_BASE_PATH)
  };
}

async function githubGetContent(config, path) {
  const response = await fetch(githubContentUrl(config, path, true), {
    headers: githubHeaders(config)
  });
  if (response.status === 404) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw httpError(githubErrorMessage(payload, response.status), response.status);
  }
  return payload;
}

async function githubGetRepo(config) {
  const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`, {
    headers: githubHeaders(config)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw httpError(githubErrorMessage(payload, response.status), response.status);
  }
  return payload;
}

async function githubPutContent(config, path, base64Content, message) {
  const existing = await githubGetContent(config, path);
  const body = {
    message,
    content: stripBase64Whitespace(base64Content),
    branch: config.branch
  };
  if (existing?.sha) body.sha = existing.sha;

  const response = await fetch(githubContentUrl(config, path, false), {
    method: "PUT",
    headers: githubHeaders(config),
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw httpError(githubErrorMessage(payload, response.status), response.status);
  }
  return payload;
}

function githubContentUrl(config, path, includeRef) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const url = new URL(`https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${encodedPath}`);
  if (includeRef) url.searchParams.set("ref", config.branch);
  return url.toString();
}

function githubHeaders(config) {
  return {
    "Accept": "application/vnd.github+json",
    "Authorization": `Bearer ${config.token}`,
    "Content-Type": "application/json",
    "User-Agent": "summary-html-desk-worker",
    "X-GitHub-Api-Version": "2022-11-28"
  };
}

function githubErrorMessage(payload, status) {
  const message = payload?.message || `GitHub returned ${status}`;
  const detail = payload?.documentation_url ? ` See ${payload.documentation_url}` : "";
  return `${message} (GitHub ${status}).${detail}`;
}

async function requireEditorPassword(request, payload, env) {
  if (!env.EDITOR_PASSWORD && !env.EDITOR_PASSWORD_SHA256) {
    throw httpError("EDITOR_PASSWORD or EDITOR_PASSWORD_SHA256 is not configured.", 500);
  }
  const supplied = request.headers.get("X-Editor-Password") || payload.editorPassword || "";
  const valid = env.EDITOR_PASSWORD_SHA256
    ? safeEqual(await sha256Hex(supplied), String(env.EDITOR_PASSWORD_SHA256).trim().toLowerCase())
    : safeEqual(supplied, env.EDITOR_PASSWORD);
  if (!valid) {
    throw httpError("Invalid editor password.", 401);
  }
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value || ""));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeEqual(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

function collectOutputText(response) {
  if (typeof response.output_text === "string") return response.output_text;
  const chunks = [];
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) chunks.push(content.text);
    }
  }
  return chunks.join("\n").trim();
}

function buildCorsHeaders(request, env) {
  const requestOrigin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGIN || "").split(",").map((item) => item.trim()).filter(Boolean);
  const allowOrigin = allowed.length
    ? (allowed.includes(requestOrigin) ? requestOrigin : allowed[0])
    : requestOrigin || "*";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Editor-Password",
    "Vary": "Origin"
  };
}

function json(payload, status, headers) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...headers,
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function sharedStatePath(config) {
  return `${config.basePath}/drafts.json`;
}

function githubItemDataUrl(item, source) {
  const mimeType = source.mimeType || guessMimeType(source.filename || item.name || "");
  return `data:${mimeType};base64,${stripBase64Whitespace(item.content)}`;
}

function stripDataUrl(value) {
  return String(value || "").split(",").pop() || "";
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

function looksLikeFileUrl(url) {
  return /\.(pdf|doc|docx|ppt|pptx|txt|md|html?|csv|json|rtf)(?:[?#].*)?$/i.test(url);
}

function guessMimeType(filename) {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (lower.endsWith(".doc")) return "application/msword";
  if (lower.endsWith(".pptx")) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  if (lower.endsWith(".json")) return "application/json";
  return "application/octet-stream";
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

function cleanBasePath(value) {
  return String(value || DEFAULT_BASE_PATH).trim().replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/") || DEFAULT_BASE_PATH;
}

function clipText(text, maxLength) {
  if (!text || text.length <= maxLength) return text || "";
  return `${text.slice(0, maxLength)}\n\n[Source text clipped at ${maxLength} characters.]`;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
