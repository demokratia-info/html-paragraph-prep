import crypto from "node:crypto";
import { Pool } from "pg";

const DEFAULT_DATABASE = "html_paragraph_prep";
const DEFAULT_SOCKET_DIR = "/var/run/postgresql";
const REMOTE_FILE_PREFIX = "postgres-source-files";
const VALID_STATUSES = new Set(["draft", "pending", "processing", "done", "error"]);
const INITIAL_ADMIN_USERNAME = "yael";
const INITIAL_ADMIN_PASSWORD = "yael!123";
const SESSION_TTL_DAYS = 30;

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

    CREATE TABLE IF NOT EXISTS app_users (
      id text PRIMARY KEY,
      username text NOT NULL,
      username_key text NOT NULL UNIQUE,
      password_hash text NOT NULL,
      is_admin boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
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

    ALTER TABLE drafts
      ADD COLUMN IF NOT EXISTS owner_user_id text REFERENCES app_users(id) ON DELETE SET NULL;

    ALTER TABLE drafts
      ADD COLUMN IF NOT EXISTS target_html_title text NOT NULL DEFAULT '';

    CREATE INDEX IF NOT EXISTS drafts_status_updated_idx
      ON drafts (status, updated_at DESC);

    CREATE INDEX IF NOT EXISTS drafts_updated_idx
      ON drafts (updated_at DESC);

    CREATE INDEX IF NOT EXISTS drafts_owner_updated_idx
      ON drafts (owner_user_id, updated_at DESC);

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

    CREATE TABLE IF NOT EXISTS app_sessions (
      token_hash text PRIMARY KEY,
      user_id text NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      last_seen_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS app_sessions_user_idx
      ON app_sessions (user_id);

    CREATE INDEX IF NOT EXISTS app_sessions_expiry_idx
      ON app_sessions (expires_at);
  `);
  await ensureInitialAdminUser();
  await assignUnownedDraftsToDefaultOwner();
  await cleanupExpiredSessions();
  await ensureUniqueExistingTargetHtmlTitles();
  await ensureTargetHtmlTitleUniqueIndex();
}

export async function loginUser(username, password) {
  await initDatabase();
  const usernameKey = usernameKeyFor(username);
  if (!usernameKey || !String(password || "")) {
    throw httpError("Invalid username or password.", 401);
  }

  const result = await getPool().query(
    "SELECT id, username, username_key, password_hash, is_admin, created_at, updated_at FROM app_users WHERE username_key = $1",
    [usernameKey]
  );
  const row = result.rows[0];
  if (!row || !verifyPassword(password, row.password_hash)) {
    throw httpError("Invalid username or password.", 401);
  }

  const sessionToken = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await getPool().query(
    `
      INSERT INTO app_sessions (token_hash, user_id, expires_at)
      VALUES ($1, $2, $3)
    `,
    [sha256Hex(sessionToken), row.id, expiresAt]
  );

  return {
    sessionToken,
    expiresAt,
    user: publicUser(row)
  };
}

export async function userFromSessionToken(sessionToken) {
  const token = String(sessionToken || "").trim();
  if (!token) return null;
  await initDatabase();

  const result = await getPool().query(
    `
      SELECT u.id, u.username, u.username_key, u.is_admin, u.created_at, u.updated_at
      FROM app_sessions s
      JOIN app_users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.expires_at > now()
    `,
    [sha256Hex(token)]
  );
  const row = result.rows[0];
  if (!row) return null;

  await getPool().query(
    "UPDATE app_sessions SET last_seen_at = now() WHERE token_hash = $1",
    [sha256Hex(token)]
  );
  return publicUser(row);
}

export async function deleteSessionToken(sessionToken) {
  const token = String(sessionToken || "").trim();
  if (!token) return { ok: true };
  await initDatabase();
  await getPool().query("DELETE FROM app_sessions WHERE token_hash = $1", [sha256Hex(token)]);
  return { ok: true };
}

export async function listUsers() {
  await initDatabase();
  const result = await getPool().query(
    `
      SELECT
        u.id,
        u.username,
        u.username_key,
        u.is_admin,
        u.created_at,
        u.updated_at,
        count(d.id)::int AS draft_count
      FROM app_users u
      LEFT JOIN drafts d ON d.owner_user_id = u.id
      GROUP BY u.id
      ORDER BY u.username_key ASC
    `
  );
  return result.rows.map(publicUser);
}

export async function createUser({ username, password, isAdmin = false } = {}) {
  await initDatabase();
  const cleanUsername = normalizeUsername(username);
  const usernameKey = usernameKeyFor(cleanUsername);
  const cleanPassword = String(password || "");
  if (!isValidUsername(cleanUsername)) {
    throw httpError("Use a username with 2-80 letters, numbers, dots, dashes, or underscores.", 400);
  }
  if (cleanPassword.length < 6) {
    throw httpError("Use a password with at least 6 characters.", 400);
  }

  const id = `user-${crypto.randomUUID()}`;
  const result = await getPool().query(
    `
      INSERT INTO app_users (id, username, username_key, password_hash, is_admin)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, username, username_key, is_admin, created_at, updated_at
    `,
    [id, cleanUsername, usernameKey, hashPassword(cleanPassword), Boolean(isAdmin)]
  ).catch((error) => {
    if (error.code === "23505") throw httpError("A user with this username already exists.", 409);
    throw error;
  });

  return publicUser(result.rows[0]);
}

export async function updateUser(userId, updates = {}, actor = null) {
  await initDatabase();
  const id = String(userId || "").trim();
  if (!id) throw httpError("Missing user id.", 400);

  const passwordWasProvided = Object.prototype.hasOwnProperty.call(updates, "password");
  const cleanPassword = String(updates.password || "");
  if (passwordWasProvided && cleanPassword.length < 6) {
    throw httpError("Use a password with at least 6 characters.", 400);
  }
  const adminWasProvided = Object.prototype.hasOwnProperty.call(updates, "isAdmin");

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const targetResult = await client.query(
      `
        SELECT id, username, username_key, password_hash, is_admin, created_at, updated_at
        FROM app_users
        WHERE id = $1
        FOR UPDATE
      `,
      [id]
    );
    const target = targetResult.rows[0];
    if (!target) throw httpError("User was not found.", 404);

    const nextIsAdmin = adminWasProvided ? Boolean(updates.isAdmin) : Boolean(target.is_admin);
    if (actor?.id === id && target.is_admin && !nextIsAdmin) {
      throw httpError("You cannot remove your own admin permission.", 400);
    }
    if (target.is_admin && !nextIsAdmin) {
      const adminCount = await client.query("SELECT count(*)::int AS count FROM app_users WHERE is_admin = true");
      if (Number(adminCount.rows[0]?.count || 0) <= 1) {
        throw httpError("Keep at least one admin user.", 400);
      }
    }

    const nextPasswordHash = passwordWasProvided ? hashPassword(cleanPassword) : target.password_hash;
    const updated = await client.query(
      `
        UPDATE app_users
        SET password_hash = $2,
            is_admin = $3,
            updated_at = now()
        WHERE id = $1
        RETURNING id, username, username_key, is_admin, created_at, updated_at
      `,
      [id, nextPasswordHash, nextIsAdmin]
    );
    await client.query("COMMIT");
    return publicUser(updated.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteUser(userId, actor) {
  await initDatabase();
  const id = String(userId || "").trim();
  if (!id) throw httpError("Missing user id.", 400);
  if (id === actor?.id) throw httpError("You cannot delete your own user.", 400);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const targetResult = await client.query(
      "SELECT id, username, username_key, is_admin FROM app_users WHERE id = $1 FOR UPDATE",
      [id]
    );
    const target = targetResult.rows[0];
    if (!target) throw httpError("User was not found.", 404);

    if (target.is_admin) {
      const adminCount = await client.query("SELECT count(*)::int AS count FROM app_users WHERE is_admin = true");
      if (Number(adminCount.rows[0]?.count || 0) <= 1) {
        throw httpError("Keep at least one admin user.", 400);
      }
    }

    await client.query(
      `
        UPDATE drafts
        SET owner_user_id = $2,
            payload = jsonb_set(
              jsonb_set(payload, '{ownerUserId}', to_jsonb($2::text), true),
              '{ownerUsername}', to_jsonb($3::text),
              true
            )
        WHERE owner_user_id = $1
      `,
      [id, actor.id, actor.username]
    );
    await client.query("DELETE FROM app_users WHERE id = $1", [id]);
    await client.query("COMMIT");
    return { ok: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function loadSharedState(options = {}) {
  await initDatabase();
  const user = options.user || null;
  const ownerUserId = normalizeOptionalId(options.ownerUserId);
  const params = [];
  let where = "";

  if (user?.isAdmin && ownerUserId) {
    params.push(ownerUserId);
    where = "WHERE d.owner_user_id = $1";
  } else if (user && !user.isAdmin) {
    params.push(user.id);
    where = "WHERE d.owner_user_id = $1";
  }

  const [draftsResult, meta] = await Promise.all([
    getPool().query(`
      SELECT d.payload, d.owner_user_id, d.target_html_title, u.username AS owner_username
      FROM drafts d
      LEFT JOIN app_users u ON u.id = d.owner_user_id
      ${where}
      ORDER BY d.updated_at DESC, d.id ASC
    `, params),
    getSetting("sharedStateMeta")
  ]);

  return {
    version: 1,
    app: "summary-html-desk",
    updatedAt: meta?.updatedAt || null,
    drafts: draftsResult.rows.map(draftPayloadWithOwner)
  };
}

export async function saveSharedState(shared, options = {}) {
  if (!shared || !Array.isArray(shared.drafts)) {
    throw httpError("Missing shared draft payload.", 400);
  }
  await initDatabase();

  const user = options.user || null;
  const ownerUserId = normalizeOptionalId(options.ownerUserId);
  const scope = saveScopeForUser(user, ownerUserId);
  const ownerCache = new Map();
  const drafts = shared.drafts.map(normalizeDraftForStorage);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const ids = drafts.map((draft) => draft.id);
    const usedTargetHtmlTitles = await reservedTargetHtmlTitles(client, scope);
    await clearTargetHtmlTitlesForSaveScope(client, scope);
    for (const draft of drafts) {
      const owner = await resolveDraftOwner(draft, { user, scope, client, ownerCache });
      draft.ownerUserId = owner?.id || "";
      draft.ownerUsername = owner?.username || "";
      draft.targetHtmlTitle = uniqueTargetHtmlTitle(draft.targetHtmlTitle, usedTargetHtmlTitles);
      await client.query(
        `
          INSERT INTO drafts (
            id, payload, title, status, created_at, updated_at, queued_at, processed_at, exported_at, owner_user_id, target_html_title
          )
          VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          ON CONFLICT (id) DO UPDATE SET
            payload = EXCLUDED.payload,
            title = EXCLUDED.title,
            status = EXCLUDED.status,
            created_at = EXCLUDED.created_at,
            updated_at = EXCLUDED.updated_at,
            queued_at = EXCLUDED.queued_at,
            processed_at = EXCLUDED.processed_at,
            exported_at = EXCLUDED.exported_at,
            owner_user_id = EXCLUDED.owner_user_id,
            target_html_title = EXCLUDED.target_html_title
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
          timestampOrNull(draft.exportedAt),
          draft.ownerUserId || null,
          String(draft.targetHtmlTitle || "")
        ]
      );
    }

    if (ids.length && scope.mode === "owner") {
      await client.query(
        "DELETE FROM drafts WHERE owner_user_id = $2 AND NOT (id = ANY($1::text[]))",
        [ids, scope.ownerId]
      );
    } else if (ids.length) {
      await client.query("DELETE FROM drafts WHERE NOT (id = ANY($1::text[]))", [ids]);
    } else if (scope.mode === "owner") {
      await client.query("DELETE FROM drafts WHERE owner_user_id = $1", [scope.ownerId]);
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

export async function saveSourceFile(source, fileData, options = {}) {
  const sourceId = String(source?.id || "").trim();
  if (!sourceId || !fileData) {
    throw httpError("Missing source id or file data.", 400);
  }
  await initDatabase();
  await assertDraftAccess(source?.draftId, options.user, { allowMissing: true });

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

export async function getSourceFileForUser(remoteFilePath, user) {
  const sourceId = sourceIdFromRemoteFilePath(remoteFilePath);
  if (!sourceId) throw httpError("Missing source file id.", 400);
  const file = await getSourceFileBuffer(sourceId, { user });
  return {
    filename: file.filename,
    mimeType: file.mimeType,
    fileData: file.content.toString("base64")
  };
}

export async function getSourceFileBuffer(sourceId, options = {}) {
  await initDatabase();
  const result = await getPool().query(
    `
      SELECT sf.source_id, sf.filename, sf.mime_type, sf.size, sf.content, d.owner_user_id
      FROM source_files sf
      LEFT JOIN drafts d ON d.id = sf.draft_id
      WHERE sf.source_id = $1
    `,
    [sourceId]
  );
  const row = result.rows[0];
  if (!row) throw httpError("Source file was not found.", 404);
  assertOwnerAccess(row.owner_user_id, options.user);
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
      (SELECT count(*)::int FROM app_users) AS user_count,
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
    targetHtmlTitle: String(draft.targetHtmlTitle || "").trim(),
    updatedAt: draft.updatedAt || new Date().toISOString()
  };
}

async function ensureInitialAdminUser() {
  const userCount = await getPool().query("SELECT count(*)::int AS count FROM app_users");
  if (Number(userCount.rows[0]?.count || 0) > 0) return;

  const usernameKey = usernameKeyFor(INITIAL_ADMIN_USERNAME);
  await getPool().query(
    `
      INSERT INTO app_users (id, username, username_key, password_hash, is_admin)
      VALUES ($1, $2, $3, $4, true)
    `,
    [
      `user-${usernameKey}`,
      INITIAL_ADMIN_USERNAME,
      usernameKey,
      hashPassword(INITIAL_ADMIN_PASSWORD)
    ]
  );
}

async function assignUnownedDraftsToDefaultOwner() {
  const owner = await defaultOwnerUser();
  if (!owner) return;
  await getPool().query(
    `
      UPDATE drafts
      SET owner_user_id = $1,
          payload = jsonb_set(
            jsonb_set(payload, '{ownerUserId}', to_jsonb($1::text), true),
            '{ownerUsername}', to_jsonb($2::text),
            true
          )
      WHERE owner_user_id IS NULL
    `,
    [owner.id, owner.username]
  );
}

async function defaultOwnerUser(client = getPool()) {
  const result = await client.query(
    `
      SELECT id, username, username_key, is_admin, created_at, updated_at
      FROM app_users
      ORDER BY
        CASE WHEN username_key = $1 THEN 0 WHEN is_admin THEN 1 ELSE 2 END,
        created_at ASC
      LIMIT 1
    `,
    [usernameKeyFor(INITIAL_ADMIN_USERNAME)]
  );
  return result.rows[0] ? publicUser(result.rows[0]) : null;
}

async function cleanupExpiredSessions() {
  await getPool().query("DELETE FROM app_sessions WHERE expires_at <= now()");
}

async function ensureUniqueExistingTargetHtmlTitles() {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(`
      SELECT id, target_html_title
      FROM drafts
      WHERE target_html_title <> ''
      ORDER BY target_html_title ASC, updated_at DESC, id ASC
      FOR UPDATE
    `);
    const used = new Set();
    for (const row of result.rows) {
      const next = uniqueTargetHtmlTitle(row.target_html_title, used);
      if (next === row.target_html_title) continue;
      await client.query(
        `
          UPDATE drafts
          SET target_html_title = $2,
              payload = jsonb_set(payload, '{targetHtmlTitle}', to_jsonb($2::text), true)
          WHERE id = $1
        `,
        [row.id, next]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function ensureTargetHtmlTitleUniqueIndex() {
  await getPool().query(`
    CREATE UNIQUE INDEX IF NOT EXISTS drafts_target_html_title_unique_idx
      ON drafts (target_html_title)
      WHERE target_html_title <> '';
  `);
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    isAdmin: Boolean(row.is_admin),
    draftCount: Number(row.draft_count || 0),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : "",
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : ""
  };
}

function draftPayloadWithOwner(row) {
  const payload = row?.payload && typeof row.payload === "object" ? { ...row.payload } : {};
  payload.ownerUserId = row.owner_user_id || payload.ownerUserId || "";
  payload.ownerUsername = row.owner_username || payload.ownerUsername || "";
  payload.targetHtmlTitle = row.target_html_title || payload.targetHtmlTitle || "";
  return payload;
}

function saveScopeForUser(user, ownerUserId) {
  if (!user) return { mode: "global", ownerId: "" };
  if (user.isAdmin && ownerUserId) return { mode: "owner", ownerId: ownerUserId };
  if (user.isAdmin) return { mode: "global", ownerId: "" };
  return { mode: "owner", ownerId: user.id };
}

async function reservedTargetHtmlTitles(client, scope) {
  if (scope.mode !== "owner") return new Set();
  const result = await client.query(
    `
      SELECT target_html_title
      FROM drafts
      WHERE target_html_title <> ''
        AND owner_user_id IS DISTINCT FROM $1
      FOR UPDATE
    `,
    [scope.ownerId]
  );
  return new Set(result.rows.map((row) => String(row.target_html_title || "").toLowerCase()));
}

async function clearTargetHtmlTitlesForSaveScope(client, scope) {
  const where = scope.mode === "owner" ? "WHERE owner_user_id = $1" : "";
  const params = scope.mode === "owner" ? [scope.ownerId] : [];
  await client.query(
    `
      UPDATE drafts
      SET target_html_title = '',
          payload = payload - 'targetHtmlTitle'
      ${where}
    `,
    params
  );
}

function uniqueTargetHtmlTitle(value, used) {
  const clean = normalizeTargetHtmlTitle(value);
  if (!clean) return "";

  let candidate = trimTargetHtmlTitle(clean, 40);
  let suffixNumber = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = `-${suffixNumber}`;
    candidate = `${trimTargetHtmlTitle(clean, 40 - suffix.length)}${suffix}`;
    suffixNumber += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function normalizeTargetHtmlTitle(value) {
  if (!String(value || "").trim()) return "";
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function trimTargetHtmlTitle(value, maxLength) {
  return String(value || "").slice(0, maxLength).replace(/-+$/g, "") || "source";
}

async function resolveDraftOwner(draft, context) {
  const { user, scope, client, ownerCache } = context;
  if (scope.mode === "owner") {
    const scopedOwner = await ownerById(scope.ownerId, client, ownerCache);
    if (scopedOwner) return scopedOwner;
  }

  if (user && !user.isAdmin) return user;

  const requestedOwnerId = normalizeOptionalId(draft.ownerUserId);
  const requestedOwner = requestedOwnerId
    ? await ownerById(requestedOwnerId, client, ownerCache)
    : null;
  if (requestedOwner) return requestedOwner;
  if (user?.isAdmin) return user;
  return defaultOwnerUser(client);
}

async function ownerById(id, client = getPool(), ownerCache = new Map()) {
  const cleanId = normalizeOptionalId(id);
  if (!cleanId) return null;
  if (ownerCache.has(cleanId)) return ownerCache.get(cleanId);
  const result = await client.query(
    "SELECT id, username, username_key, is_admin, created_at, updated_at FROM app_users WHERE id = $1",
    [cleanId]
  );
  const owner = result.rows[0] ? publicUser(result.rows[0]) : null;
  ownerCache.set(cleanId, owner);
  return owner;
}

async function assertDraftAccess(draftId, user, options = {}) {
  if (!user || user.isAdmin) return;
  const id = String(draftId || "").trim();
  if (!id) {
    if (options.allowMissing) return;
    throw httpError("Missing source owner.", 400);
  }
  const result = await getPool().query(
    "SELECT owner_user_id FROM drafts WHERE id = $1",
    [id]
  );
  const row = result.rows[0];
  if (!row) {
    if (options.allowMissing) return;
    throw httpError("Source was not found.", 404);
  }
  assertOwnerAccess(row.owner_user_id, user);
}

function assertOwnerAccess(ownerUserId, user) {
  if (!user || user.isAdmin) return;
  if (ownerUserId && ownerUserId === user.id) return;
  throw httpError("You do not have access to this source.", 403);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const hash = crypto.scryptSync(String(password || ""), salt, 64).toString("base64url");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, storedHash) {
  const [algorithm, salt, expected] = String(storedHash || "").split("$");
  if (algorithm !== "scrypt" || !salt || !expected) return false;
  const actual = crypto.scryptSync(String(password || ""), salt, 64).toString("base64url");
  return safeEqual(actual, expected);
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

function normalizeUsername(username) {
  return String(username || "").trim();
}

function usernameKeyFor(username) {
  return normalizeUsername(username).toLowerCase();
}

function isValidUsername(username) {
  return /^[\p{L}\p{N}._-]{2,80}$/u.test(username);
}

function normalizeOptionalId(value) {
  return String(value || "").trim();
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
