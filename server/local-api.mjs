import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import {
  checkStorage,
  createUser,
  deleteSessionToken,
  deleteUser,
  getSourceFileForUser,
  httpError,
  initDatabase,
  listUsers,
  loadDefaultPrompt,
  loadSharedState,
  loginUser,
  saveDefaultPrompt,
  saveSharedState,
  saveSourceFile,
  updateUser,
  userFromSessionToken
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
    const payload = request.body || {};
    const action = payload.action || "loadSharedState";

    if (action === "login") {
      const session = await loginUser(payload.username, payload.password);
      return response.json({
        ...session,
        users: session.user?.isAdmin ? await listUsers() : []
      });
    }

    if (action === "logout") {
      await deleteSessionToken(sessionTokenFromRequest(request));
      return response.json({ ok: true });
    }

    const user = await requireUser(request);

    switch (action) {
      case "currentUser":
        return response.json({
          user,
          users: user.isAdmin ? await listUsers() : []
        });
      case "listUsers":
        requireAdmin(user);
        return response.json({ users: await listUsers() });
      case "addUser":
        requireAdmin(user);
        return response.json({
          user: await createUser({
            username: payload.username,
            password: payload.password,
            isAdmin: payload.isAdmin
          }),
          users: await listUsers()
        });
      case "updateUser":
        requireAdmin(user);
        return response.json({
          updatedUser: await updateUser(payload.userId, updateUserPayload(payload), user),
          currentUser: await userFromSessionToken(sessionTokenFromRequest(request)),
          users: await listUsers()
        });
      case "deleteUser":
        requireAdmin(user);
        await deleteUser(payload.userId, user);
        return response.json({ ok: true, users: await listUsers() });
      case "saveSourceFile":
        return response.json(await saveSourceFile({
          ...(payload.source || {}),
          draftId: payload.draftId || payload.source?.draftId || null
        }, payload.fileData, { user }));
      case "saveSharedState":
        return response.json(await saveSharedState(payload.payload, {
          user,
          ownerUserId: payload.ownerUserId || ""
        }));
      case "loadSharedState":
        return response.json({
          ...await loadSharedState({
            user,
            ownerUserId: payload.ownerUserId || ""
          }),
          user,
          users: user.isAdmin ? await listUsers() : []
        });
      case "loadDefaultPrompt":
        return response.json(await loadDefaultPrompt({
          user,
          localPromptFallback: readLocalPrompt()
        }));
      case "saveDefaultPrompt":
        return response.json(await saveDefaultPrompt(payload.prompt, { user }));
      case "getSourceFile":
        return response.json(await getSourceFileForUser(payload.remoteFilePath, user));
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
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");

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

async function requireUser(request) {
  const user = await userFromSessionToken(sessionTokenFromRequest(request));
  if (!user) throw httpError("Please sign in again.", 401);
  return user;
}

function requireAdmin(user) {
  if (!user?.isAdmin) throw httpError("Admin permission is required.", 403);
}

function updateUserPayload(payload) {
  const updates = {};
  if (Object.prototype.hasOwnProperty.call(payload, "password")) updates.password = payload.password;
  if (Object.prototype.hasOwnProperty.call(payload, "isAdmin")) updates.isAdmin = payload.isAdmin;
  return updates;
}

function sessionTokenFromRequest(request) {
  const authorization = String(request.headers.authorization || "").trim();
  if (/^Bearer\s+/i.test(authorization)) {
    return authorization.replace(/^Bearer\s+/i, "").trim();
  }
  return String(request.body?.sessionToken || "").trim();
}

function readLocalPrompt() {
  const promptPath = path.join(REPO_ROOT, "prompt.txt");
  if (!fs.existsSync(promptPath)) return "";
  return fs.readFileSync(promptPath, "utf8").trim();
}
