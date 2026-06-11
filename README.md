# Summary HTML Desk

A separate personal GitHub Pages app for preparing Hebrew CMS-ready HTML summaries from document links, pasted text, and uploaded documents.

This project is intentionally independent of `Documents/DemocracyWebSite`.

## What It Does

- Keeps up to roughly 100 summary drafts for later browsing and editing.
- Keeps source links and uploaded origin files attached to each draft.
- Accepts Hebrew source text, document links, uploaded PDFs, uploaded Word files, and uploaded text files.
- Summarizes through a password-protected backend Worker when configured.
- Builds a prompt you can copy into ChatGPT, Codex, or another LLM as a fallback.
- Converts the LLM result into clean CMS HTML.
- Copies or downloads the generated HTML.
- Works as a static GitHub Pages site with no build step.
- Uses a private GitHub data repo behind the Worker for cross-computer sharing.

## Safe Default Workflow

1. Open the app.
2. Add Hebrew document links, paste source text, or upload PDF/Word/text files.
3. Enter the editor password.
4. Click **Run LLM** to generate the Hebrew summary, or use **Build Prompt** as a manual fallback.
5. Edit the result if needed.
6. Click **Push** so other editors can pull the updated summaries.
7. Copy **Generated HTML** into your CMS.

The static GitHub Pages app does not contain an API key, GitHub token, or editor password. Do not put secrets into frontend code or committed files.

Drafts are cached in the browser profile for local work, then shared through the backend. The JSON export includes draft text and source metadata, but not binary PDF/Word files.

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

## Shared Backend Worker

The Worker lets the page share summaries/files and call OpenAI without exposing your API key, GitHub token, or editor password in GitHub Pages.

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
