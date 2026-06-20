# Summary HTML Desk

A separate personal GitHub Pages app for preparing Hebrew CMS-ready HTML summaries from document links, pasted text, and uploaded documents.

This project is intentionally independent of `Documents/DemocracyWebSite`.

## What It Does

- Keeps up to roughly 100 summary drafts for later browsing and editing.
- Provides a compact browse list with search and status filters.
- Keeps source links and uploaded origin files attached to each draft.
- Accepts Hebrew source text, document links, uploaded PDFs, uploaded Word files, and uploaded text files.
- Saves items to a local PostgreSQL-backed shared queue and wakes the local Codex processor immediately.
- Keeps an editable prompt with each item, including a default prompt users can restore.
- Converts the LLM result into clean CMS HTML.
- Copies or downloads the generated HTML.
- Works as a static GitHub Pages site with no build step.
- Uses a local API backed by PostgreSQL for shared summaries and source files.

## Safe Default Workflow

1. Open the app and enter the editor password once.
2. Use the left panel to browse papers, search, filter by status, or click **Add New Paper**.
3. Use the source panel to edit the paper title, save one URL, upload one or more files, and click **Save and Generate**.
4. Use the text panel to edit the prompt and generated text. Click **Generate HTML** when the text is ready.
5. Use the HTML panel to review and click **Copy HTML**. The item status becomes **Exported**.
6. The local Codex processor handles waiting items and changes the status to **Ready**.
7. Click **Refresh** to load the latest shared work.

Each item displays the last modified time, last processed time, and last exported time.

Use **Show summaries -> Ready to export** to find texts that have a result, are not waiting, and are not currently marked exported.

The static GitHub Pages app does not contain an API key, GitHub token, or editor password. Do not put secrets into frontend code or committed files.

Drafts are cached in the browser profile for local work, then shared through the local PostgreSQL API. The SQL database stores draft text, source metadata, and uploaded/cached source files.

## Local PostgreSQL API

PostgreSQL should be running locally with the `html_paragraph_prep` database. The API normally runs as a systemd service on this server:

```bash
sudo systemctl status summary-html-desk-api.service
```

The GitHub Pages frontend is configured to call the public Cloudflare Tunnel endpoint, which forwards to `http://127.0.0.1:8787` on this server. Editors never connect to PostgreSQL directly.

The current tunnel service is:

```bash
sudo systemctl status summary-html-desk-tunnel.service
```

The account-less `trycloudflare.com` tunnel is suitable for immediate testing, but it is not a permanent production hostname. For stable multi-user use, replace it with a named Cloudflare Tunnel or another stable HTTPS API endpoint, then update `DEFAULT_BACKEND_ENDPOINT` in `assets/app.js`.

Initialize or check the SQL schema:

```bash
npm run db:init
```

Import the previous private GitHub shared state into PostgreSQL:

```bash
npm run db:migrate:github
```

## Local Codex Processing

The website does not use the OpenAI API for the normal workflow. When a user clicks **Save and Generate**, the local API saves the item, wakes the Codex processor on this computer, and keeps waiting items queued. The cron job below can remain as a fallback check.

Run one manual check:

```bash
cd /home/talraviv/html-paragraph-prep
scripts/process_pending_with_codex.sh
```

Add this cron entry to check once per minute:

```cron
* * * * * cd /home/talraviv/html-paragraph-prep && scripts/process_pending_with_codex.sh >> /home/talraviv/html-paragraph-prep/summary-cron.log 2>&1
```

Optional settings for the cron job:

```bash
export CODEX_REASONING_EFFORT=xhigh
export CODEX_MODEL=gpt-5.5
export MAX_PENDING_PER_RUN=1
export DRAIN_PENDING_LIMIT=20
```

If an item already has result text and the prompt is changed, the processor asks Codex to keep the existing result as similar as possible and only make the changes requested by the latest prompt.

## Publish To A Separate GitHub Repo

From this folder:

```bash
git init
git add .
git commit -m "Create summary HTML desk"
gh repo create html-paragraph-prep --public --source=. --remote=origin --push
```

Then enable GitHub Pages for the repo from **Settings -> Pages** and publish from the `main` branch root. The app repo can be public because secrets and data are not stored there.

Create a separate private data repo for shared summaries and files:

```bash
gh repo create html-paragraph-prep-data --private --add-readme
```

## Legacy Shared Storage Worker

The Worker was the earlier GitHub-backed storage layer. The current default frontend points to the local PostgreSQL API instead. Keep the Worker instructions below only if you need the old GitHub JSON storage fallback.

1. Install Wrangler and log in to Cloudflare.
2. Copy `workers/wrangler.toml.example` to `workers/wrangler.toml`.
3. Set `ALLOWED_ORIGIN` to the GitHub Pages origin for this app.
4. Confirm `GITHUB_OWNER`, `GITHUB_REPO`, and `GITHUB_BASE_PATH`.
5. Set secrets and deploy:

```bash
cd workers
wrangler secret put EDITOR_PASSWORD
# Or reuse a hashed existing editor password:
# wrangler secret put EDITOR_PASSWORD_SHA256
wrangler secret put GITHUB_TOKEN
wrangler secret put OPENAI_API_KEY
wrangler deploy
```

To use the Worker again, update `DEFAULT_BACKEND_ENDPOINT` in `assets/app.js`.

The Worker uses the OpenAI Responses API, supports text inputs, public document file URLs, private uploaded PDF/Word files stored in the data repo, and optional web search for ordinary URLs.

## Model And Effort

Set these in `workers/wrangler.toml` before deploying:

```toml
OPENAI_MODEL = "gpt-5.5"
OPENAI_REASONING_EFFORT = "xhigh"
MAX_OUTPUT_TOKENS = "4000"
```

Recommended effort values:

- `low` for faster, cheaper routine summaries.
- `medium` for balanced Hebrew document summaries.
- `high` for difficult legal/academic documents where quality matters more than latency.
- `xhigh` only for the hardest cases, with higher latency and cost.

Then redeploy:

```bash
cd /home/talraviv/html-paragraph-prep/workers
npx wrangler@3.114.14 deploy
```

## Local Use

You can open `index.html` directly in a browser. For service worker offline caching, serve it over HTTP:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`.
