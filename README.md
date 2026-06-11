# Summary HTML Desk

A separate personal GitHub Pages app for preparing Hebrew CMS-ready HTML summaries from document links, pasted text, and uploaded documents.

This project is intentionally independent of `Documents/DemocracyWebSite`.

## What It Does

- Keeps up to roughly 100 summary drafts for later browsing and editing.
- Provides a compact browse list with search and status filters.
- Keeps source links and uploaded origin files attached to each draft.
- Accepts Hebrew source text, document links, uploaded PDFs, uploaded Word files, and uploaded text files.
- Saves items to a shared queue that a local Codex cron job can process.
- Keeps an editable prompt with each item, including a default prompt users can restore.
- Converts the LLM result into clean CMS HTML.
- Copies or downloads the generated HTML.
- Works as a static GitHub Pages site with no build step.
- Uses a private GitHub data repo behind the Worker for cross-computer sharing.

## Safe Default Workflow

1. Open the app and enter the editor password once.
2. Use the left panel to browse papers, search, filter by status, or click **Add New Paper**.
3. Use the source panel to edit the paper title, save one URL, upload one or more files, and click **Save for Processing**.
4. Use the text panel to edit the prompt and generated text. Click **Generate HTML** when the text is ready.
5. Use the HTML panel to review and click **Copy HTML**. The item status becomes **Exported**.
6. The local Codex cron job processes waiting items and changes the status to **Ready**.
7. Click **Refresh** to load the latest shared work.

Each item displays the last modified time, last processed time, and last exported time.

Use **Show summaries -> Ready to export** to find texts that have a result, are not waiting, and are not currently marked exported.

The static GitHub Pages app does not contain an API key, GitHub token, or editor password. Do not put secrets into frontend code or committed files.

Drafts are cached in the browser profile for local work, then shared through the private data repo. The JSON export includes draft text and source metadata, but not binary PDF/Word files.

## Local Codex Processing

The website does not use the OpenAI API for the normal workflow. A local cron job runs Codex on this computer using the local ChatGPT/Codex login, checks the shared work list, and only starts Codex when an item is waiting.

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

## Shared Storage Worker

The Worker lets the page share summaries/files without exposing your GitHub token or editor password in GitHub Pages. The OpenAI API action still exists as a fallback, but the normal workflow is the local Codex cron job.

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

The app is preconfigured for `https://summary-html-desk-openai.demokratia-info.workers.dev`. If the deployed Worker URL is different, update `DEFAULT_BACKEND_ENDPOINT` in `assets/app.js`.

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
