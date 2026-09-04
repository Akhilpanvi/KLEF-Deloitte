# KLEF × Deloitte — Campus Drive Dashboard

Password-gated dashboard for the Deloitte campus drive: candidate roster,
attendance, slot progress, branch distribution and issue tracking, read live
from Google Sheets.

Runs as a single Vercel Edge Function. No build step, no dependencies.

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

Add the three variables under **Project → Settings → Environment Variables**
(Production, Preview and Development), then redeploy. Or from the CLI:

```bash
npm i -g vercel
vercel link

vercel env add SHEET_ID production
vercel env add SITE_PASSWORD production
vercel env add SESSION_SECRET production   # openssl rand -hex 32

vercel --prod
```

Env var changes only take effect on a **new deployment** — redeploy after
adding them.

### Local development

```bash
cp .env.example .env.local   # fill in the three values
vercel dev
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
  misses collapse onto one build. If Sheets errors, the last good payload is
  served rather than a 502.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /` | Dashboard (login screen when unauthenticated) |
| `POST /login` | Verify password, issue session |
| `POST /logout` | Clear session |
| `GET /api/data` | JSON model for the poller; supports `If-None-Match` |

`vercel.json` rewrites every path to `api/index.js`, which routes on the
request pathname. `api/data.js` re-exports the same handler so `/api/data`
also resolves as a filesystem route.
