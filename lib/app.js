/**
 * Deloitte Campus Drive — Candidate Management & Interview Status Dashboard.
 *
 * Shared application core. Vercel's catch-all rewrite does NOT preserve the
 * original pathname (the function is invoked with "/api"), so routing must not
 * be derived from request.url. Each file under api/ is a real filesystem route
 * that passes its own path in explicitly.
 *
 * Rebuilds the Sheets Canvas dashboard as a password-gated site. Canvas tabs
 * cannot be published to the web, so this reads the underlying grid tabs and
 * reproduces the same joins:
 *
 *   MASTER          -> candidate roster (149)
 *   interview status-> attendance form; completed=Yes joined on roll number
 *   issues          -> issue tracker; REPORTED OR NOT == "REPORTED" are blockers
 *   readiness Form  -> readiness answers, latest response per roll
 *
 * The sheet is fetched server-side and only after the session verifies, so an
 * unauthenticated request never receives candidate data.
 */

/* The spreadsheet is supplied at deploy time via the SHEET_ID binding, never
   committed: this sheet is readable by anyone holding its id, so the id is as
   sensitive as the candidate data itself. Accepts a bare id or a full URL. */
function sheetId(raw) {
  const v = String(raw || "").trim();
  const m = /\/spreadsheets\/d\/(?:e\/)?([A-Za-z0-9-_]+)/.exec(v);
  const id = m ? m[1] : v;
  if (!/^[A-Za-z0-9-_]{20,}$/.test(id)) throw new Error("SHEET_ID is missing or malformed");
  return id;
}

const CSV = (id, sheet) =>
  `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv` +
  (sheet ? `&sheet=${encodeURIComponent(sheet)}` : "");

const COOKIE = "dsess";
const SESSION_MAX_AGE = 60 * 60 * 8; // 8 hours
const MODEL_TTL_MS = 2500;           // in-isolate cache of the built model

/* ---------------------------------------------------------------- session */

const enc = new TextEncoder();

async function sign(secret, msg) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function etagOf(body) {
  const h = await crypto.subtle.digest("SHA-256", enc.encode(body));
  return '"' + [...new Uint8Array(h)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("") + '"';
}

async function issueToken(secret) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE;
  return `${exp}.${await sign(secret, String(exp))}`;
}

async function verifyToken(secret, token) {
  if (!token) return false;
  const dot = token.lastIndexOf(".");
  if (dot < 1) return false;
  const exp = token.slice(0, dot), sig = token.slice(dot + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Math.floor(Date.now() / 1000)) return false;
  return timingSafeEqual(sig, await sign(secret, exp));
}

function readCookie(req, name) {
  for (const part of (req.headers.get("Cookie") || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

/* ------------------------------------------------------------------- data */

function parseCSV(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

async function fetchTab(id, sheet) {
  const res = await fetch(CSV(id, sheet), { cache: "no-store" });
  if (!res.ok) throw new Error(`"${sheet || "MASTER"}" fetch failed: ${res.status}`);
  return parseCSV(await res.text());
}

const digits = (s) => String(s || "").replace(/\D/g, "");
const low = (s) => String(s || "").trim().toLowerCase();
const clean = (s) => {
  const v = String(s || "").trim();
  return v && !["#n/a", "n/a", "na", "-"].includes(v.toLowerCase()) ? v : "";
};

function indexBy(header, names) {
  const map = {};
  header.forEach((h, n) => (map[low(h)] = n));
  const out = {};
  for (const [key, label] of Object.entries(names)) {
    out[key] = map[low(label)];
    if (out[key] === undefined) {
      const hit = Object.keys(map).find((h) => h.startsWith(low(label).slice(0, 22)));
      out[key] = hit === undefined ? -1 : map[hit];
    }
  }
  return out;
}

async function buildModel(id) {
  const [master, ivs, issues, rdy] = await Promise.all([
    fetchTab(id, null), fetchTab(id, "interview status"),
    fetchTab(id, "issues"), fetchTab(id, "readiness Form"),
  ]);

  const M = indexBy(master[0], {
    sno: "S.No", roll: "Campus ID / Roll no", hp: "Hirepro ID", did: "Deloitte Candidate ID",
    name: "Full Name", gender: "Gender", phone: "Contact No.", email: "Registered Email ID",
    test: "Test Status", slot: "Interview Slot", degree: "Degree", branch: "Course/Branch",
    yop: "Year of passing",
  });

  // Attendance: completed=Yes in the interview-status form, joined on roll.
  const I = indexBy(ivs[0], { roll: "Roll Number (University ID)", done: "Is your Interview completed" });
  const attended = new Set();
  for (const r of ivs.slice(1)) {
    if (low(r[I.done]) === "yes" && digits(r[I.roll])) attended.add(digits(r[I.roll]));
  }

  // Issues: "REPORTED" rows are the blockers surfaced on the canvas.
  const S = indexBy(issues[0], {
    roll: "Campus ID / Roll no", issue: "ISSUE", reported: "REPORTED OR NOT", resolved: "Issue resolved",
  });
  const issueBy = new Map();
  for (const r of issues.slice(1)) {
    const k = digits(r[S.roll]);
    if (!k) continue;
    issueBy.set(k, {
      text: clean(r[S.issue]) && low(r[S.issue]) !== "no" ? clean(r[S.issue]) : "",
      reported: low(r[S.reported]) === "reported",
      resolved: low(r[S.resolved]) === "yes",
    });
  }

  // Readiness: latest response wins.
  const R = indexBy(rdy[0], {
    roll: "Student ID / Roll Number", reg: "Did you fill out the registration link?",
    mail: "Did you get the interview mail?",
    ready: "Are you ready to give the interview in the all",
    irp: "Do you want to attend the interview from the I",
    tech: "Are you facing any technical challenges?",
  });
  const rdyBy = new Map();
  for (const r of rdy.slice(1)) {
    const k = digits(r[R.roll]);
    if (k) rdyBy.set(k, {
      reg: low(r[R.reg]), mail: low(r[R.mail]), ready: low(r[R.ready]),
      irp: low(r[R.irp]), tech: low(r[R.tech]),
    });
  }

  const people = master.slice(1).map((r, n) => {
    const roll = digits(r[M.roll]);
    const q = rdyBy.get(roll) || {};
    const iss = issueBy.get(roll) || {};
    const flags = [];
    if (q.mail === "no") flags.push("No Mail Received");
    if (q.ready === "no") flags.push("Slot Not Ready");
    if (q.tech === "yes") flags.push("Technical Issue");
    return {
      n: clean(r[M.sno]) || String(n + 1),
      name: clean(r[M.name]), gender: clean(r[M.gender]),
      roll: clean(r[M.roll]), hp: clean(r[M.hp]), did: clean(r[M.did]),
      email: clean(r[M.email]), phone: clean(r[M.phone]),
      branch: clean(r[M.branch]) || "—", degree: clean(r[M.degree]),
      yop: clean(r[M.yop]),
      slot: clean(r[M.slot]) || "—", test: clean(r[M.test]),
      done: attended.has(roll),
      flags,
      issue: iss.text || "",
      blocker: !!iss.reported,
      issueResolved: !!iss.resolved,
      irp: q.irp === "yes",
      ans: { reg: q.reg || "", mail: q.mail || "", ready: q.ready || "",
             irp: q.irp || "", tech: q.tech || "" },
    };
  });

  const tally = (key) => {
    const m = new Map();
    for (const p of people) m.set(p[key], (m.get(p[key]) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };

  const slots = new Map();
  for (const p of people) {
    const s = slots.get(p.slot) || { total: 0, done: 0 };
    s.total++; if (p.done) s.done++;
    slots.set(p.slot, s);
  }
  const slotOrder = [...slots.entries()].sort((a, b) => {
    const t = (x) => {
      const m = /^(\d+):(\d+)\s*(AM|PM)/i.exec(x);
      if (!m) return Infinity;               // unparseable slots sort last
      let h = +m[1] % 12;
      if (/pm/i.test(m[3])) h += 12;
      return h * 60 + +m[2];
    };
    return t(a[0]) - t(b[0]);
  });

  const done = people.filter((p) => p.done).length;
  return {
    people,
    stats: {
      total: people.length,
      done,
      pending: people.length - done,
      blockers: people.filter((p) => p.blocker).length,
      irp: people.filter((p) => p.irp).length,
      cleared: Math.round(people.filter((p) => low(p.test) === "clear").length / (people.length || 1) * 100),
      waves: slotOrder.length,
    },
    slots: slotOrder,
    branches: tally("branch"),
  };
}

/* Polling every 2s meant every request - even a 304 - refetched all four tabs
   just to compute the ETag. Cache the built payload in the isolate, collapse
   concurrent misses onto one build, and fall back to the last good copy if
   Google hiccups mid-drive. */

let cached = null;    // { at, id, model, body, tag }
let inflight = null;

async function payload(id) {
  if (cached && cached.id === id && Date.now() - cached.at < MODEL_TTL_MS) return cached;
  if (inflight) return inflight;                       // collapse concurrent misses

  inflight = (async () => {
    try {
      const model = await buildModel(id);
      const body = JSON.stringify(model);
      cached = { at: Date.now(), id, model, body, tag: await etagOf(body) };
      return cached;
    } catch (err) {
      if (cached && cached.id === id) return cached;   // stale-if-error beats a 502
      throw err;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/* ------------------------------------------------------------------ views */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const CSS = `
:root{
  --bg:#f1f3f4; --surface:#fff; --border:#e0e4e7; --text:#161c1a; --muted:#6b7780;
  --brand:#0b5c3f; --brand-2:#0d7a4f; --accent:#12a05f; --accent-soft:#eaf7f0;
  --ok:#0b7a45; --ok-bg:#e3f6ea; --warn:#8a5a00; --warn-bg:#fdf3dd;
  --bad:#b3261e; --bad-bg:#fdeceb; --bar:#e6eaed;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#111614; --surface:#1a211e; --border:#2a3430; --text:#e7edea; --muted:#93a19a;
    --brand:#0b5c3f; --brand-2:#0d7a4f; --accent:#3ec27f; --accent-soft:#172a21;
    --ok:#5fd095; --ok-bg:#14301f; --warn:#e0b055; --warn-bg:#30260f;
    --bad:#f28b82; --bad-bg:#33191a; --bar:#2a3430;
  }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  -webkit-font-smoothing:antialiased}
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px}
.wrap{max-width:1560px;margin:0 auto;padding:18px 20px 40px}
`;

const SHELL_CSS = `
.top{background:var(--brand);color:#fff;padding:14px 24px;display:flex;
  align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:12px}
.mark{width:34px;height:34px;border-radius:8px;background:var(--brand-2);color:#fff;
  display:grid;place-items:center;font-weight:700;font-size:17px}
.top h1{margin:0;font-size:19px;font-weight:700;letter-spacing:-.01em;display:flex;
  align-items:center;gap:10px;flex-wrap:wrap}
.batch{font-size:11px;font-weight:600;background:rgba(255,255,255,.16);
  padding:3px 9px;border-radius:20px;letter-spacing:.02em}
.top p{margin:2px 0 0;font-size:12.5px;opacity:.82}
.topact{display:flex;align-items:center;gap:10px}
.chip{display:inline-flex;align-items:center;gap:7px;padding:8px 14px;border-radius:8px;
  font-size:13px;font-weight:600;border:0;cursor:pointer;font-family:inherit}
.chip-bad{background:var(--bad-bg);color:var(--bad)}
.chip-bad.on{background:var(--bad);color:#fff}
.chip-n{background:rgba(0,0,0,.14);border-radius:20px;padding:1px 8px;font-size:11.5px}
.chip-bad.on .chip-n{background:rgba(255,255,255,.25)}
.chip-ghost{background:rgba(255,255,255,.14);color:#fff}
.chip-ghost:hover{background:rgba(255,255,255,.22)}
`;

const DASH_CSS = `
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(215px,1fr));gap:14px;margin-bottom:16px}
.stat{padding:16px 18px}
.stat .lab{display:flex;align-items:center;justify-content:space-between;font-size:11px;
  font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.stat .big{font-size:32px;font-weight:700;letter-spacing:-.02em;margin:8px 0 2px;line-height:1}
.stat .big small{font-size:13px;font-weight:600;color:var(--muted);letter-spacing:0}
.stat .sub{font-size:12px;color:var(--muted)}
.stat .sub b{color:var(--ok)}
.stat.bad .big{color:var(--bad)} .stat.warn .big{color:var(--warn)}
.track{height:5px;border-radius:3px;background:var(--bar);overflow:hidden;margin-top:9px}
.track i{display:block;height:100%;background:var(--accent);border-radius:3px}
.pill{display:inline-block;font-size:11px;font-weight:700;padding:2px 8px;border-radius:20px;
  background:var(--ok-bg);color:var(--ok)}

.cols{display:grid;grid-template-columns:1.9fr 1fr;gap:16px;margin-bottom:16px;align-items:start}
@media(max-width:1080px){.cols{grid-template-columns:1fr}}
.panel{padding:16px 18px}
.phead{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:14px}
.phead h2{margin:0;font-size:14px;font-weight:700;letter-spacing:-.01em}
.phead span{font-size:11.5px;color:var(--muted)}

.slots{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:11px}
.slot{border:1px solid var(--border);border-radius:9px;padding:11px 13px}
.slot .t{font-size:12.5px;font-weight:700}
.slot .r{display:flex;align-items:baseline;justify-content:space-between;margin:5px 0 8px}
.slot .r b{font-size:22px;font-weight:700;letter-spacing:-.02em}
.slot .r span{font-size:11.5px;color:var(--ok);font-weight:600}
.slot .f{display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-top:6px}

.branch{display:flex;flex-direction:column;gap:12px}
.branch .row{display:flex;align-items:baseline;justify-content:space-between;font-size:12.5px;margin-bottom:5px}
.branch .row b{font-weight:600}
.branch .row span{color:var(--muted);font-size:11.5px}

.tools{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:14px 16px;
  border-bottom:1px solid var(--border)}
.tools input[type=search]{flex:1;min-width:230px;padding:9px 12px;font-size:13px;font-family:inherit;
  color:var(--text);background:var(--bg);border:1px solid var(--border);border-radius:8px}
.tools select{padding:9px 10px;font-size:12.5px;font-family:inherit;color:var(--text);
  background:var(--bg);border:1px solid var(--border);border-radius:8px}
.tools label{font-size:12px;color:var(--muted);font-weight:600}
input:focus,select:focus{outline:2px solid var(--accent);outline-offset:-1px;border-color:transparent}
.reset{margin-left:auto;background:transparent;border:0;color:var(--bad);font-weight:600;
  font-size:12.5px;cursor:pointer;font-family:inherit;padding:6px 4px}

.tscroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
th{position:sticky;top:0;background:var(--surface);text-align:left;padding:11px 14px;
  font-size:10.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;
  color:var(--muted);border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:11px 14px;border-bottom:1px solid var(--border);vertical-align:top}
tbody tr:hover{background:var(--accent-soft)}
.nm{font-weight:650}
.sub2{font-size:11.5px;color:var(--muted);margin-top:3px}
.tag{display:inline-block;font-size:10px;font-weight:700;padding:1.5px 7px;border-radius:4px;
  background:var(--bar);color:var(--muted);margin-right:5px}
.mono{font-variant-numeric:tabular-nums}
.badge{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:650;
  padding:4px 10px;border-radius:20px;white-space:nowrap}
.b-ok{background:var(--ok-bg);color:var(--ok)} .b-pend{background:var(--warn-bg);color:var(--warn)}
.note-ok{font-size:12px;color:var(--muted)}
.flag{display:inline-block;font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:5px;
  background:var(--warn-bg);color:var(--warn);margin:0 5px 4px 0}
.issue{font-size:12px;color:var(--bad);margin-top:3px;max-width:290px}
.foot{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;
  padding:13px 16px;font-size:12.5px;color:var(--muted)}
.pager{display:flex;align-items:center;gap:8px}
.stamp{font-size:11.5px;color:var(--muted);font-variant-numeric:tabular-nums;margin-right:6px}
.pager button{padding:6px 12px;font-size:12.5px;font-family:inherit;background:var(--surface);
  color:var(--text);border:1px solid var(--border);border-radius:7px;cursor:pointer}
.pager button:disabled{opacity:.4;cursor:default}
.empty{padding:44px;text-align:center;color:var(--muted)}
.lnk{color:inherit;text-decoration:none;border-bottom:1px solid transparent}
.lnk:hover{color:var(--accent);border-bottom-color:currentColor}
.cmail{max-width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dim{color:var(--muted)}
.eye{display:grid;place-items:center;width:30px;height:30px;padding:0;cursor:pointer;
  color:var(--muted);background:transparent;border:1px solid var(--border);border-radius:7px}
.eye:hover{color:var(--accent);border-color:var(--accent);background:var(--accent-soft)}
.eye:focus-visible{outline:2px solid var(--accent);outline-offset:1px}

.modal{position:fixed;inset:0;z-index:50;display:grid;place-items:center;padding:20px}
.mback{position:absolute;inset:0;background:rgba(8,14,11,.55);backdrop-filter:blur(2px)}
.mcard{position:relative;width:100%;max-width:580px;max-height:88vh;overflow-y:auto;
  background:var(--surface);border:1px solid var(--border);border-radius:14px;
  padding:24px 26px 26px;box-shadow:0 18px 50px rgba(0,0,0,.32)}
.mclose{position:absolute;top:14px;right:14px;width:30px;height:30px;font-size:20px;line-height:1;
  color:var(--muted);background:transparent;border:0;border-radius:7px;cursor:pointer;font-family:inherit}
.mclose:hover{background:var(--bar);color:var(--text)}
.mhead{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;
  padding-right:32px;padding-bottom:16px;border-bottom:1px solid var(--border)}
.mhead h2{margin:0 0 7px;font-size:19px;font-weight:700;letter-spacing:-.015em}
.mtags{display:flex;gap:6px;flex-wrap:wrap}
.msec{padding-top:16px}
.msec h3{margin:0 0 10px;font-size:10.5px;font-weight:700;letter-spacing:.06em;
  text-transform:uppercase;color:var(--muted)}
.flds{margin:0;display:flex;flex-direction:column;gap:1px}
.fld{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.25fr);gap:14px;
  padding:7px 0;border-bottom:1px solid var(--border)}
.fld:last-child{border-bottom:0}
.fld dt{font-size:12.5px;color:var(--muted)}
.fld dd{margin:0;font-size:13px;word-break:break-word}
.yn{display:inline-block;font-size:11px;font-weight:700;padding:2px 9px;border-radius:20px}
.yn.y{background:var(--ok-bg);color:var(--ok)}
.yn.n{background:var(--bad-bg);color:var(--bad)}
.yn.u{background:var(--bar);color:var(--muted)}
.cta{display:flex;gap:9px;flex-wrap:wrap;margin-bottom:12px}
.btn-a{display:inline-flex;align-items:center;gap:7px;padding:8px 14px;font-size:13px;font-weight:600;
  text-decoration:none;color:#fff;background:var(--brand);border-radius:8px}
.btn-a:hover{background:var(--brand-2)}
.mflags{margin-top:11px}
.ibox{padding:11px 13px;font-size:13px;color:var(--bad);background:var(--bad-bg);border-radius:8px}
.isub{margin-top:8px;display:flex;gap:7px}
@media(max-width:560px){.fld{grid-template-columns:1fr;gap:3px}.mcard{padding:20px}}
`;

function shell(title, head, body, css) {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title>
<style>${CSS}${css}</style></head><body>${head}${body}</body></html>`;
}

function loginPage(error) {
  return shell("Sign in — Deloitte Campus Drive", "", `
<main class="lwrap"><form method="POST" action="/api/login" class="card lcard">
  <div class="lmark">D</div>
  <h1>Deloitte Campus Drive</h1>
  <p class="lsub">Candidate Management &amp; Interview Status</p>
  ${error ? `<p class="lerr">${esc(error)}</p>` : ""}
  <label for="pw">Access password</label>
  <input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
  <button type="submit">Sign in</button>
  <p class="lnote">Authorised placement staff only.</p>
</form></main>`, `
.lwrap{min-height:100vh;display:grid;place-items:center;padding:24px}
.lcard{width:100%;max-width:370px;padding:30px}
.lmark{width:40px;height:40px;border-radius:9px;background:var(--brand);color:#fff;
  display:grid;place-items:center;font-weight:700;font-size:19px;margin-bottom:16px}
.lcard h1{margin:0;font-size:19px;font-weight:700;letter-spacing:-.015em}
.lsub{margin:3px 0 24px;font-size:13px;color:var(--muted)}
label{display:block;font-size:12px;font-weight:600;margin-bottom:7px;color:var(--muted)}
input{width:100%;padding:11px 12px;font-size:14px;font-family:inherit;color:var(--text);
  background:var(--bg);border:1px solid var(--border);border-radius:8px}
input:focus{outline:2px solid var(--accent);outline-offset:-1px;border-color:transparent}
button{width:100%;margin-top:18px;padding:11px;font-size:14px;font-weight:650;font-family:inherit;
  color:#fff;background:var(--brand);border:0;border-radius:8px;cursor:pointer}
button:hover{background:var(--brand-2)}
.lerr{margin:0 0 16px;padding:10px 12px;font-size:13px;color:var(--bad);
  background:var(--bad-bg);border-radius:8px}
.lnote{margin:18px 0 0;font-size:11.5px;color:var(--muted);text-align:center}
`);
}

function dashboard(model) {
  const json = JSON.stringify(model).replace(/</g, "\\u003c");

  const head = `<header class="top">
  <div class="brand"><div class="mark">D</div>
    <div><h1>Deloitte Campus Drive <span class="batch">Batch 2027</span></h1>
    <p>Candidate Management &amp; Interview Status Tracking System</p></div>
  </div>
  <div class="topact">
    <button id="blockBtn" class="chip chip-bad" aria-pressed="false">
      &#9888; Issues &amp; Blockers <span class="chip-n" id="blkN">0</span></button>
    <form method="POST" action="/api/logout"><button class="chip chip-ghost">Sign out</button></form>
  </div></header>`;

  const body = `<main class="wrap">
  <section class="stats" id="stats"></section>
  <section class="cols">
    <div class="card panel"><div class="phead"><h2>Interview Slot Timeline &amp; Progress</h2>
      <span>Click a slot to filter candidates</span></div><div class="slots" id="slotWrap"></div></div>
    <div class="card panel"><div class="phead"><h2>Branch Distribution</h2></div>
      <div class="branch" id="branchWrap"></div></div>
  </section>
  <section class="card">
    <div class="tools">
      <input id="q" type="search" placeholder="Search by name, roll no, Deloitte ID…" autocomplete="off">
      <label>Slot</label><select id="fSlot" data-all="All slots"></select>
      <label>Branch</label><select id="fBranch" data-all="All branches"></select>
      <label>Status</label><select id="fStatus"><option value="">All statuses</option><option>Completed</option><option>Pending</option></select>
      <label>Gender</label><select id="fGender"><option value="">All genders</option><option>Male</option><option>Female</option></select>
      <button class="reset" id="reset">Reset filters</button>
    </div>
    <div class="tscroll"><table>
      <thead><tr><th>#</th><th>Candidate</th><th>Campus ID / Roll</th><th>Branch &amp; Deg</th>
        <th>Slot</th><th>Contact details</th><th>Interview status</th><th>Readiness / Notes</th>
        <th>Actions</th></tr></thead>
      <tbody id="rows"></tbody></table></div>
    <div id="none" class="empty" hidden>No candidates match these filters.</div>
    <div class="foot"><div id="count"></div>
      <div class="pager"><span id="stamp" class="stamp"></span>
        <label for="per">Rows</label>
        <select id="per"><option>15</option><option>25</option><option>50</option><option>All</option></select>
        <button id="prev">Prev</button><span id="page" class="mono"></span><button id="next">Next</button>
      </div></div>
  </section></main>
<div id="modal" class="modal" hidden>
  <div class="mback" id="mback"></div>
  <div class="mcard" role="dialog" aria-modal="true" aria-labelledby="mtitle">
    <button class="mclose" id="mclose" aria-label="Close details">&times;</button>
    <div id="mbody"></div>
  </div>
</div>`;

  const script = `<script>
let MODEL = ${json};
let P = MODEL.people;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pct = (a,b) => b ? Math.round(a/b*100) : 0;
let page = 1, blockOnly = false;

/* ---------- summary panels (re-rendered on every data change) ---------- */

function paintStats() {
  const s = MODEL.stats;
  const card = (cls, lab, big, sub, extra) =>
    '<div class="card stat ' + cls + '"><div class="lab"><span>' + lab + '</span></div>' +
    '<div class="big">' + big + '</div><div class="sub">' + sub + '</div>' + (extra || '') + '</div>';
  $('stats').innerHTML =
    card('', 'Scheduled', s.total + ' <small>Candidates</small>',
         'Test status <span class="pill">' + s.cleared + '% cleared</span>') +
    card('', 'Attended', s.done + ' <small>/ ' + s.total + ' (' + pct(s.done,s.total) + '%)</small>',
         'Interview completed',
         '<div class="track"><i style="width:' + pct(s.done,s.total) + '%"></i></div>') +
    card('warn', 'Pending / Slot', s.pending, 'Awaiting status across ' + s.waves + ' waves') +
    card('bad', 'Blockers', s.blockers, 'Reported &middot; click above to isolate') +
    card('', 'Room C621B', s.irp, 'IRP panel requests');
  $('blkN').textContent = s.blockers;
}

function paintSlots() {
  $('slotWrap').innerHTML = MODEL.slots.map(([name, v]) => {
    const p = pct(v.done, v.total);
    return '<div class="slot" data-slot="' + esc(name) + '"><div class="t">' + esc(name) + '</div>' +
      '<div class="r"><b>' + v.total + '</b><span>' + v.done + ' done</span></div>' +
      '<div class="track"><i style="width:' + p + '%"></i></div>' +
      '<div class="f"><span>' + (v.total - v.done) + ' pending</span><span>' + p + '%</span></div></div>';
  }).join('');
  for (const el of document.querySelectorAll('.slot')) {
    el.style.cursor = 'pointer';
    el.onclick = () => {
      const t = el.dataset.slot;
      $('fSlot').value = $('fSlot').value === t ? '' : t;
      page = 1; render();
    };
  }
}

function paintBranches() {
  const total = MODEL.stats.total;
  $('branchWrap').innerHTML = MODEL.branches.map(([name, n]) => {
    const p = pct(n, total);
    return '<div><div class="row"><b>' + esc(name) + '</b><span>' + n + ' (' + p + '%)</span></div>' +
      '<div class="track"><i style="width:' + p + '%"></i></div></div>';
  }).join('');
}

/* Rebuild a filter dropdown only when its option set actually changed, so a
   poll never clears what the user has selected. */
function syncSelect(el, values) {
  const want = JSON.stringify(values);
  if (el.dataset.opts === want) return;
  const keep = el.value;
  el.dataset.opts = want;
  el.innerHTML = '<option value="">' + esc(el.dataset.all) + '</option>' +
    values.map(v => '<option>' + esc(v) + '</option>').join('');
  el.value = values.indexOf(keep) >= 0 ? keep : '';
}

/* ------------------------------- table -------------------------------- */

const state = () => ({
  q: $('q').value.trim().toLowerCase(),
  slot: $('fSlot').value, branch: $('fBranch').value,
  status: $('fStatus').value, gender: $('fGender').value,
});

function match(p, f) {
  if (blockOnly && !p.blocker) return false;
  if (f.slot && p.slot !== f.slot) return false;
  if (f.branch && p.branch !== f.branch) return false;
  if (f.gender && p.gender !== f.gender) return false;
  if (f.status === 'Completed' && !p.done) return false;
  if (f.status === 'Pending' && p.done) return false;
  if (f.q) {
    const hay = (p.name + ' ' + p.roll + ' ' + p.did + ' ' + p.hp + ' ' + p.email).toLowerCase();
    if (hay.indexOf(f.q) < 0) return false;
  }
  return true;
}

function notes(p) {
  const bits = p.flags.map(f => '<span class="flag">' + esc(f) + '</span>').join('');
  const txt = p.issue ? '<div class="issue">' + esc(p.issue) + '</div>' : '';
  return (bits || txt) ? bits + txt : '<span class="note-ok">Ready / Normal</span>';
}

function row(p) {
  return '<tr><td class="mono">' + esc(p.n) + '</td>' +
    '<td><div class="nm">' + esc(p.name) + '</div><div class="sub2">' +
      (p.gender ? '<span class="tag">' + esc(p.gender) + '</span>' : '') +
      (p.did ? 'DID: ' + esc(p.did) : '') + '</div></td>' +
    '<td><div class="mono">' + esc(p.roll) + '</div>' +
      (p.hp ? '<div class="sub2 mono">HP: ' + esc(p.hp) + '</div>' : '') + '</td>' +
    '<td><div>' + esc(p.branch) + '</div><div class="sub2">' + esc(p.degree) + '</div></td>' +
    '<td>' + esc(p.slot) + '</td>' +
    '<td>' + contact(p) + '</td>' +
    '<td><span class="badge ' + (p.done ? 'b-ok">&#10003; Completed' : 'b-pend">&#9201; Pending') + '</span></td>' +
    '<td>' + notes(p) + '</td>' +
    '<td><button class="eye" data-roll="' + esc(p.roll) + '" title="View full details" ' +
      'aria-label="View details for ' + esc(p.name) + '">' + EYE + '</button></td></tr>';
}

const EYE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
  'stroke-width="1.8" stroke-linecap="round"><path d="M1.6 12S5.2 5.6 12 5.6 22.4 12 22.4 12 18.8 18.4 12 18.4 1.6 12 1.6 12Z"/>' +
  '<circle cx="12" cy="12" r="3.1"/></svg>';

function contact(p) {
  const mail = p.email
    ? '<a class="lnk" href="mailto:' + esc(encodeURI(p.email)) + '" title="' + esc(p.email) + '">' + esc(p.email) + '</a>'
    : '<span class="dim">—</span>';
  const tel = p.phone
    ? '<a class="lnk mono" href="tel:' + esc(p.phone.replace(/[^0-9+]/g, '')) + '">' + esc(p.phone) + '</a>'
    : '<span class="dim">—</span>';
  return '<div class="cmail">' + mail + '</div><div class="sub2">' + tel + '</div>';
}

/* ------------------------- candidate detail ------------------------- */

let openRoll = null;

const YN = (v) => {
  const t = String(v || '').toLowerCase();
  if (t === 'yes') return '<span class="yn y">Yes</span>';
  if (t === 'no')  return '<span class="yn n">No</span>';
  return '<span class="yn u">Not answered</span>';
};

function field(k, v) {
  return '<div class="fld"><dt>' + esc(k) + '</dt><dd>' + (v || '<span class="dim">—</span>') + '</dd></div>';
}

function renderDetail(roll) {
  const p = P.find(x => x.roll === roll);
  if (!p) { closeDetail(); return; }
  const a = p.ans || {};
  const tel = p.phone ? p.phone.replace(/[^0-9+]/g, '') : '';

  const flags = p.flags.length
    ? p.flags.map(f => '<span class="flag">' + esc(f) + '</span>').join('')
    : '<span class="note-ok">Ready / Normal</span>';

  const issue = p.issue
    ? '<div class="msec"><h3>Reported issue</h3><div class="ibox">' + esc(p.issue) + '</div>' +
      '<div class="isub">' + (p.blocker ? '<span class="yn n">Reported</span>' : '') +
      (p.issueResolved ? ' <span class="yn y">Resolved</span>' : ' <span class="yn u">Open</span>') +
      '</div></div>'
    : '';

  $('mbody').innerHTML =
    '<div class="mhead"><div>' +
      '<h2 id="mtitle">' + esc(p.name) + '</h2>' +
      '<div class="mtags">' +
        (p.gender ? '<span class="tag">' + esc(p.gender) + '</span>' : '') +
        '<span class="tag">' + esc(p.branch) + '</span>' +
        '<span class="tag">' + esc(p.slot) + '</span>' +
      '</div></div>' +
      '<span class="badge ' + (p.done ? 'b-ok">&#10003; Completed' : 'b-pend">&#9201; Pending') + '</span>' +
    '</div>' +

    '<div class="msec"><h3>Contact</h3><div class="cta">' +
      (p.phone ? '<a class="btn-a" href="tel:' + esc(tel) + '">&#9742; Call ' + esc(p.phone) + '</a>' : '') +
      (p.email ? '<a class="btn-a" href="mailto:' + esc(encodeURI(p.email)) + '">&#9993; Email</a>' : '') +
    '</div><dl class="flds">' +
      field('Registered email', p.email ? esc(p.email) : '') +
      field('Contact number', p.phone ? '<span class="mono">' + esc(p.phone) + '</span>' : '') +
    '</dl></div>' +

    '<div class="msec"><h3>Identity</h3><dl class="flds">' +
      field('Campus ID / Roll no', '<span class="mono">' + esc(p.roll) + '</span>') +
      field('HirePro ID', p.hp ? '<span class="mono">' + esc(p.hp) + '</span>' : '') +
      field('Deloitte candidate ID', p.did ? '<span class="mono">' + esc(p.did) + '</span>' : '') +
      field('Serial no', '<span class="mono">' + esc(p.n) + '</span>') +
    '</dl></div>' +

    '<div class="msec"><h3>Academic &amp; schedule</h3><dl class="flds">' +
      field('Degree', esc(p.degree)) +
      field('Branch', esc(p.branch)) +
      field('Year of passing', esc(p.yop)) +
      field('Interview slot', esc(p.slot)) +
      field('Test status', p.test ? '<span class="yn y">' + esc(p.test) + '</span>' : '') +
      field('Interview status', p.done ? '<span class="yn y">Completed</span>' : '<span class="yn u">Pending</span>') +
    '</dl></div>' +

    '<div class="msec"><h3>Readiness form</h3><dl class="flds">' +
      field('Filled registration link', YN(a.reg)) +
      field('Received interview mail', YN(a.mail)) +
      field('Ready for allotted slot', YN(a.ready)) +
      field('Wants IRP panel (Room C621B)', YN(a.irp)) +
      field('Facing technical challenges', YN(a.tech)) +
    '</dl><div class="mflags">' + flags + '</div></div>' + issue;
}

function openDetail(roll) {
  openRoll = roll;
  renderDetail(roll);
  $('modal').hidden = false;
  document.body.style.overflow = 'hidden';
  $('mclose').focus();
}

function closeDetail() {
  openRoll = null;
  $('modal').hidden = true;
  document.body.style.overflow = '';
}

function render() {
  const f = state();
  const hits = P.filter(p => match(p, f));
  const perRaw = $('per').value;
  const per = perRaw === 'All' ? (hits.length || 1) : +perRaw;
  const pages = Math.max(1, Math.ceil(hits.length / per));
  page = Math.min(page, pages);
  const slice = hits.slice((page - 1) * per, page * per);

  const html = slice.map(row).join('');
  if ($('rows').innerHTML !== html) $('rows').innerHTML = html;   // avoid pointless repaint
  $('none').hidden = hits.length > 0;
  const from = hits.length ? (page - 1) * per + 1 : 0;
  $('count').textContent = 'Showing ' + from + '–' + ((page - 1) * per + slice.length) +
    ' of ' + hits.length + ' candidates' +
    (hits.length !== P.length ? ' (filtered from ' + P.length + ' total)' : '');
  $('page').textContent = page + ' / ' + pages;
  $('prev').disabled = page <= 1;
  $('next').disabled = page >= pages;
}

function paint() {
  paintStats(); paintSlots(); paintBranches();
  if (openRoll) renderDetail(openRoll);        // detail view updates in place too
  syncSelect($('fSlot'), MODEL.slots.map(x => x[0]));
  syncSelect($('fBranch'), MODEL.branches.map(x => x[0]));
  render();
}

/* --------------------- silent 2s refresh --------------------- */

let etag = null, inFlight = false;

async function poll() {
  if (inFlight || document.hidden) return;      // no overlap, idle when tab hidden
  inFlight = true;
  try {
    const r = await fetch('/api/data', {
      cache: 'no-store',
      headers: etag ? { 'if-none-match': etag } : {},
    });
    if (r.status === 304) { stamp(); return; }  // unchanged: no bytes, no repaint
    if (r.status === 401) { location.reload(); return; }   // session expired -> login
    if (!r.ok) return;                          // transient error: keep last good data
    etag = r.headers.get('etag') || etag;
    MODEL = await r.json();
    P = MODEL.people;
    paint();
    stamp();
  } catch (e) {
    /* offline or aborted - stay silent and keep showing the last good data */
  } finally {
    inFlight = false;
  }
}

function stamp() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  $('stamp').textContent = 'Updated ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
}

/* ------------------------------ wiring ------------------------------ */

for (const id of ['q','fSlot','fBranch','fStatus','fGender','per'])
  $(id).addEventListener('input', () => { page = 1; render(); });
$('prev').onclick = () => { page--; render(); };
$('next').onclick = () => { page++; render(); };
$('reset').onclick = () => {
  $('q').value = ''; blockOnly = false;
  $('blockBtn').classList.remove('on'); $('blockBtn').setAttribute('aria-pressed','false');
  for (const id of ['fSlot','fBranch','fStatus','fGender']) $(id).value = '';
  page = 1; render();
};
$('blockBtn').onclick = () => {
  blockOnly = !blockOnly;
  $('blockBtn').classList.toggle('on', blockOnly);
  $('blockBtn').setAttribute('aria-pressed', String(blockOnly));
  page = 1; render();
};
$('rows').addEventListener('click', (e) => {
  const b = e.target.closest('.eye');
  if (b) openDetail(b.dataset.roll);
});
$('mback').onclick = closeDetail;
$('mclose').onclick = closeDetail;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openRoll) closeDetail(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

paint();
stamp();
setInterval(poll, 2000);
</script>`;

  return shell("Deloitte Campus Drive — Candidate Dashboard", head, body + script,
    SHELL_CSS + DASH_CSS);
}

/* ----------------------------------------------------------------- routing */

const html = (body, status = 200, headers = {}) =>
  new Response(body, { status, headers: {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
    "x-robots-tag": "noindex, nofollow", "referrer-policy": "same-origin",
    "x-content-type-options": "nosniff", "x-frame-options": "DENY", ...headers } });

const cookie = (v, age) => `${COOKIE}=${v}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${age}`;

export async function app(request, path) {
  {
    const env = {
      SITE_PASSWORD: process.env.SITE_PASSWORD,
      SESSION_SECRET: process.env.SESSION_SECRET,
      SHEET_ID: process.env.SHEET_ID,
    };
    const { SITE_PASSWORD, SESSION_SECRET, SHEET_ID } = env;
    const missing = ["SITE_PASSWORD", "SESSION_SECRET", "SHEET_ID"].filter((k) => !env[k]);
    if (missing.length)
      return html(`<h1>Not configured</h1><p>Missing binding(s): ${esc(missing.join(", "))}.` +
        ` See README.md.</p>`, 500);

    let SHEET;
    try { SHEET = sheetId(SHEET_ID); }
    catch (err) { return html(`<h1>Not configured</h1><p>${esc(err.message)}</p>`, 500); }

    if (path === "/logout" && request.method === "POST")
      return html("", 302, { location: "/", "set-cookie": cookie("", 0) });

    if (path === "/login" && request.method === "POST") {
      const supplied = String((await request.formData()).get("password") || "");
      await new Promise((r) => setTimeout(r, 400)); // blunt brute force
      if (!timingSafeEqual(supplied, SITE_PASSWORD)) return html(loginPage("Incorrect password."), 401);
      return html("", 302, {
        location: "/",
        "set-cookie": cookie(await issueToken(SESSION_SECRET), SESSION_MAX_AGE),
      });
    }

    if (!(await verifyToken(SESSION_SECRET, readCookie(request, COOKIE))))
      return html(loginPage(null), 401);

    if (path === "/api/data") {
      try {
        const { body, tag } = await payload(SHEET);
        const base = { etag: tag, "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" };
        // Unchanged since the client's last poll: answer with no body at all.
        if (request.headers.get("if-none-match") === tag)
          return new Response(null, { status: 304, headers: base });
        return new Response(body, { status: 200, headers: {
          ...base, "content-type": "application/json; charset=utf-8",
          "x-content-type-options": "nosniff" } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 502,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
      }
    }

    if (path !== "/") return html("<h1>404</h1>", 404);

    try {
      return html(dashboard((await payload(SHEET)).model));
    } catch (err) {
      return html(`<h1>Could not load sheet</h1><p>${esc(err.message)}</p>`, 502);
    }
  }
}
