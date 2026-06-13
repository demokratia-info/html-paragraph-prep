import { Pool } from "pg";

const DEFAULT_DATABASE = "html_paragraph_prep";
const DEFAULT_SOCKET_DIR = "/var/run/postgresql";
const REMOTE_FILE_PREFIX = "postgres-source-files";
const VALID_STATUSES = new Set(["draft", "pending", "processing", "done", "error"]);

let pool;

export function getPool() {
  if (!pool) {
    pool = process.env.DATABASE_URL
      ? new Pool({ connectionString: process.env.DATABASE_URL })
      : new Pool({
        host: DEFAULT_SOCKET_DIR,
        database: DEFAULT_DATABASE
      });
  }
  return pool;
}

export async function closePool() {
  if (!pool) return;
  await pool.end();
  pool = null;
}

export async function initDatabase() {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key text PRIMARY KEY,
      value jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS drafts (
      id text PRIMARY KEY,
      payload jsonb NOT NULL,
      title text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'draft',
      created_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now(),
      queued_at timestamptz,
      processed_at timestamptz,
      exported_at timestamptz
    );

    CREATE INDEX IF NOT EXISTS drafts_status_updated_idx
      ON drafts (status, updated_at DESC);

    CREATE INDEX IF NOT EXISTS drafts_updated_idx
      ON drafts (updated_at DESC);

    CREATE INDEX IF NOT EXISTS drafts_payload_gin_idx
      ON drafts USING gin (payload jsonb_path_ops);

    CREATE TABLE IF NOT EXISTS source_files (
      source_id text PRIMARY KEY,
      draft_id text REFERENCES drafts(id) ON DELETE CASCADE,
      filename text NOT NULL DEFAULT 'source-file',
      mime_type text NOT NULL DEFAULT 'application/octet-stream',
      size bigint NOT NULL DEFAULT 0,
      content bytea NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS source_files_draft_idx
      ON source_files (draft_id);
  `);
}

export async function loadSharedState() {
  await initDatabase();
  const [draftsResult, meta] = await Promise.all([
    getPool().query("SELECT payload FROM drafts ORDER BY updated_at DESC, id ASC"),
    getSetting("sharedStateMeta")
  ]);

  return {
    version: 1,
    app: "summary-html-desk",
    updatedAt: meta?.updatedAt || null,
    drafts: draftsResult.rows.map((row) => row.payload)
  };
}

export async function saveSharedState(shared) {
  if (!shared || !Array.isArray(shared.drafts)) {
    throw httpError("Missing shared draft payload.", 400);
  }
  await initDatabase();

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const ids = [];
    for (const rawDraft of shared.drafts) {
      const draft = normalizeDraftForStorage(rawDraft);
      ids.push(draft.id);
      await client.query(
        `
          INSERT INTO drafts (
            id, payload, title, status, created_at, updated_at, queued_at, processed_at, exported_at
          )
          VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (id) DO UPDATE SET
            payload = EXCLUDED.payload,
            title = EXCLUDED.title,
            status = EXCLUDED.status,
            created_at = EXCLUDED.created_at,
            updated_at = EXCLUDED.updated_at,
            queued_at = EXCLUDED.queued_at,
            processed_at = EXCLUDED.processed_at,
            exported_at = EXCLUDED.exported_at
        `,
        [
          draft.id,
          JSON.stringify(draft),
          String(draft.title || ""),
          normalizeStatus(draft.status),
          timestampOrNull(draft.createdAt),
          timestampOrNull(draft.updatedAt) || new Date().toISOString(),
          timestampOrNull(draft.queuedAt),
          timestampOrNull(draft.processedAt),
          timestampOrNull(draft.exportedAt)
        ]
      );
    }

    if (ids.length) {
      await client.query("DELETE FROM drafts WHERE NOT (id = ANY($1::text[]))", [ids]);
    } else {
      await client.query("DELETE FROM drafts");
    }

    const updatedAt = new Date().toISOString();
    await setSetting("sharedStateMeta", {
      updatedAt,
      count: shared.drafts.length
    }, client);
    await client.query("COMMIT");

    return {
      ok: true,
      updatedAt,
      count: shared.drafts.length
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function loadDefaultPrompt({ localPromptFallback = "" } = {}) {
  await initDatabase();
  const stored = await getSetting("defaultPrompt");
  const prompt = String(stored?.prompt || localPromptFallback || "").trim();
  return {
    prompt,
    updatedAt: stored?.updatedAt || null
  };
}

export async function saveDefaultPrompt(prompt) {
  const value = String(prompt || "").trim();
  if (!value) throw httpError("Default prompt cannot be empty.", 400);
  const updatedAt = new Date().toISOString();
  await setSetting("defaultPrompt", { prompt: value, updatedAt });
  return {
    ok: true,
    prompt: value,
    updatedAt
  };
}

export async function saveSourceFile(source, fileData) {
  const sourceId = String(source?.id || "").trim();
  if (!sourceId || !fileData) {
    throw httpError("Missing source id or file data.", 400);
  }
  await initDatabase();

  const buffer = Buffer.isBuffer(fileData) ? fileData : Buffer.from(stripDataUrl(fileData), "base64");
  const filename = String(source.filename || source.title || "source-file");
  const mimeType = String(source.mimeType || guessMimeType(filename));
  await getPool().query(
    `
      INSERT INTO source_files (source_id, draft_id, filename, mime_type, size, content, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, now())
      ON CONFLICT (source_id) DO UPDATE SET
        draft_id = EXCLUDED.draft_id,
        filename = EXCLUDED.filename,
        mime_type = EXCLUDED.mime_type,
        size = EXCLUDED.size,
        content = EXCLUDED.content,
        updated_at = now()
    `,
    [
      sourceId,
      source.draftId || null,
      filename,
      mimeType,
      Number(source.size || buffer.length || 0),
      buffer
    ]
  );

  return {
    remoteFilePath: remoteFilePathForSource(sourceId, filename)
  };
}

export async function getSourceFile(remoteFilePath) {
  const sourceId = sourceIdFromRemoteFilePath(remoteFilePath);
  if (!sourceId) throw httpError("Missing source file id.", 400);
  const file = await getSourceFileBuffer(sourceId);
  return {
    filename: file.filename,
    mimeType: file.mimeType,
    fileData: file.content.toString("base64")
  };
}

export async function getSourceFileBuffer(sourceId) {
  await initDatabase();
  const result = await getPool().query(
    "SELECT source_id, filename, mime_type, size, content FROM source_files WHERE source_id = $1",
    [sourceId]
  );
  const row = result.rows[0];
  if (!row) throw httpError("Source file was not found.", 404);
  return {
    sourceId: row.source_id,
    filename: row.filename,
    mimeType: row.mime_type,
    size: Number(row.size || 0),
    content: row.content
  };
}

export async function checkStorage() {
  await initDatabase();
  const result = await getPool().query(`
    SELECT
      (SELECT count(*)::int FROM drafts) AS draft_count,
      (SELECT count(*)::int FROM source_files) AS source_file_count,
      current_database() AS database,
      current_user AS user
  `);
  return {
    ok: true,
    backend: "postgres",
    ...result.rows[0]
  };
}

export function remoteFilePathForSource(sourceId, filename = "source-file") {
  return `${REMOTE_FILE_PREFIX}/${encodeURIComponent(sourceId)}/${encodeURIComponent(filename || "source-file")}`;
}

export function sourceIdFromRemoteFilePath(remoteFilePath) {
  const value = String(remoteFilePath || "").trim();
  const prefix = `${REMOTE_FILE_PREFIX}/`;
  if (!value.startsWith(prefix)) return "";
  return decodeURIComponent(value.slice(prefix.length).split("/")[0] || "");
}

export function isPostgresRemoteFilePath(remoteFilePath) {
  return Boolean(sourceIdFromRemoteFilePath(remoteFilePath));
}

export function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function getSetting(key) {
  await initDatabase();
  const result = await getPool().query("SELECT value FROM app_settings WHERE key = $1", [key]);
  return result.rows[0]?.value || null;
}

async function setSetting(key, value, client = getPool()) {
  await client.query(
    `
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ($1, $2::jsonb, now())
      ON CONFLICT (key) DO UPDATE SET
        value = EXCLUDED.value,
        updated_at = now()
    `,
    [key, JSON.stringify(value)]
  );
}

function normalizeDraftForStorage(draft) {
  const id = String(draft?.id || "").trim();
  if (!id) throw httpError("A draft is missing its id.", 400);
  return {
    ...draft,
    id,
    sources: Array.isArray(draft.sources) ? draft.sources : [],
    status: normalizeStatus(draft.status),
    updatedAt: draft.updatedAt || new Date().toISOString()
  };
}

function normalizeStatus(status) {
  const value = String(status || "draft").trim();
  return VALID_STATUSES.has(value) ? value : "draft";
}

function timestampOrNull(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function stripDataUrl(value) {
  return String(value || "").split(",").pop() || "";
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
