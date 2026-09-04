# KLEF × Deloitte — Campus Drive Dashboard

Password-gated dashboard for the Deloitte campus drive: candidate roster,
attendance, slot progress, branch distribution and issue tracking, read live
from Google Sheets.

Runs as a single Cloudflare Worker. No build step, no dependencies.

## Why it reads the grid tabs

The source workbook's dashboard is a Sheets **Canvas** tab. Canvas tabs cannot
be published to the web — every publish endpoint returns a JS shell with zero
data rows — so this app reads the underlying grid tabs and reproduces the same
joins server-side:

| Tab | Used for |
| --- | --- |
| `MASTER` | Candidate roster (identity, contact, branch, slot) |
| `interview status` | Attendance — `Is your Interview completed = Yes`, joined on roll number |
| `issues` | Blockers — rows where `REPORTED OR NOT = REPORTED` |
| `readiness Form` | Readiness answers, latest response per roll |

## Configuration

Three bindings are required. All three are secrets — **none belongs in git.**

| Name | What it is |
| --- | --- |
| `SHEET_ID` | Google Sheet id, or a full `/spreadsheets/d/<id>/…` URL |
| `SITE_PASSWORD` | Password for the login screen |
| `SESSION_SECRET` | HMAC key for session cookies (`openssl rand -hex 32`) |

`SHEET_ID` is a credential in practice: if the sheet is shared with "anyone
with the link", that id alone grants full access to candidate data and
bypasses `SITE_PASSWORD` entirely.

### Deploy

```bash
npm install -g wrangler
wrangler login

printf '<sheet-id>'            | wrangler secret put SHEET_ID
printf '<password>'            | wrangler secret put SITE_PASSWORD
openssl rand -hex 32 | tr -d '\n' | wrangler secret put SESSION_SECRET

wrangler deploy
```

Set the custom domain via `routes` in `wrangler.jsonc`, or remove that block to
deploy on a `*.workers.dev` subdomain.

### Local development

```bash
cp .dev.vars.example .dev.vars   # fill in the three values
wrangler dev
```

## How it works

- **Auth** — password checked server-side in constant time; session is an
  HMAC-SHA256 signed cookie (HttpOnly, Secure, SameSite=Lax, 8h). The sheet is
  fetched *only after* the session verifies, so an unauthenticated request
  never receives candidate data.
- **Live refresh** — the page polls `/api/data` every 2s and patches the DOM in
  place; filters, pagination, scroll and focus are preserved. ETag
  revalidation makes unchanged polls `304` with an empty body (~28ms).
- **Caching** — the built payload is cached in-isolate for 2.5s and concurrent
  misses collapse onto one build; Google fetches sit behind a 3s edge cache.
  If Sheets errors, the last good payload is served rather than a 502.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /` | Dashboard (login screen when unauthenticated) |
| `POST /login` | Verify password, issue session |
| `POST /logout` | Clear session |
| `GET /api/data` | JSON model for the poller; supports `If-None-Match` |
