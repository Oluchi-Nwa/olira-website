// Cloudflare Pages Function: POST /api/inquiry
// Receives the website inquiry form and creates a record in Airtable.
// Secrets (set in Cloudflare > Workers & Pages > this project > Settings > Variables and secrets):
//   AIRTABLE_TOKEN    Airtable personal access token (scope: data.records:write, this base only)
// Optional variables:
//   AIRTABLE_BASE_ID  defaults to the Olira Group base
//   AIRTABLE_TABLE    defaults to "Olira Group | CRM & Business Development"
//   ALLOWED_ORIGIN    defaults to https://www.oliragroup.com (apex is allowed too)

const DEFAULT_BASE = "appYu5L6nbc3oPR2S";
const DEFAULT_TABLE = "tblX4RCvpOKtFbqUd"; // table ID inside the "Olira Group | CRM & Business Development" base

// form key -> Airtable column, required?
const FIELDS = {
  name: ["Name", true],
  organization: ["Organization", true],
  jobTitle: ["Job Title", true],
  email: ["Email Address", true],
  phone: ["Phone Number", false],
  website: ["Company Website", true],
  service: ["Service of Interest", true],
  goal: ["What are you hoping to accomplish?", true],
  success: ["What would success look like?", true],
  budget: ["Estimated Budget (optional)", false],
  startDate: ["Desired Start Date", true],
  source: ["How did you hear about us?", true],
};


// Find the Airtable token even if the variable name has stray spaces or different capitals.
function findToken(env) {
  if (env.AIRTABLE_TOKEN) return String(env.AIRTABLE_TOKEN).trim();
  for (const k of Object.keys(env || {})) {
    const n = k.trim().toUpperCase().replace(/[^A-Z]/g, "");
    if (n.includes("AIRTABLE") && /(TOKEN|KEY|PAT)/.test(n) && typeof env[k] === "string") return env[k].trim();
  }
  return "";
}

// GET /api/inquiry: setup check. Shows variable NAMES only, never their values.
export async function onRequestGet({ env }) {
  const names = Object.keys(env || {}).filter((k) => typeof env[k] === "string");
  const tok = findToken(env);
  return new Response(JSON.stringify({
    connector: "olira-inquiry v9",
    deployed_commit: String(env.CF_PAGES_COMMIT_SHA || "").slice(0, 7),
    token_length: tok.length,
    raw_value_length: typeof env.AIRTABLE_TOKEN === "string" ? env.AIRTABLE_TOKEN.length : null,
    token_found: Boolean(tok),
    token_looks_like_airtable_pat: /^pat[A-Za-z0-9]{10,}\./.test(tok),
    variable_names: names,
  }, null, 2), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": origin || "https://www.oliragroup.com",
      "vary": "origin",
    },
  });
}

function allowedOrigin(request, env) {
  const origin = request.headers.get("origin") || "";
  const allow = [env.ALLOWED_ORIGIN || "https://www.oliragroup.com", "https://oliragroup.com"];
  if (origin && origin === new URL(request.url).origin) return origin;
  if (allow.includes(origin) || /\.pages\.dev$/.test(new URL(origin || "https://x.invalid").hostname)) return origin;
  return null;
}

export async function onRequestOptions({ request, env }) {
  const origin = allowedOrigin(request, env);
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin || "https://www.oliragroup.com",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  });
}

export async function onRequestPost(ctx) {
  try {
    return await handlePost(ctx);
  } catch (e) {
    console.error("Inquiry exception", e);
    return json({ ok: false, error: "exception", message: String((e && e.message) || e).slice(0, 300) }, 200);
  }
}

async function handlePost({ request, env }) {
  const origin = allowedOrigin(request, env);
  if (!origin && request.headers.get("origin")) return json({ ok: false, error: "origin" }, 403);
  const TOKEN = findToken(env);
  if (!TOKEN) return json({ ok: false, error: "not_configured" }, 503, origin);

  let data;
  try { data = await request.json(); } catch { return json({ ok: false, error: "bad_request" }, 400, origin); }

  // Spam traps: hidden field must stay empty, and the form must take more than 3 seconds to fill.
  if ((data.zq_hp_8274 || data.company_fax || "").trim()) { console.warn("Inquiry dropped by spam trap"); return json({ ok: true, ref: null }, 200, origin); }
  if (Number(data.elapsed || 0) < 3000) return json({ ok: false, error: "too_fast" }, 400, origin);

  const values = {}; // form key -> cleaned value
  const missing = [];
  for (const [key, [, required]] of Object.entries(FIELDS)) {
    let v = typeof data[key] === "string" ? data[key].trim().slice(0, 5000) : "";
    if (!v) { if (required) missing.push(key); continue; }
    if (key === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { missing.push(key); continue; }
    if (key === "website" && !/^https?:\/\//i.test(v)) v = "https://" + v;
    values[key] = v;
  }
  if (missing.length) return json({ ok: false, error: "missing", fields: missing }, 400, origin);
  values.submitted = new Date().toISOString().slice(0, 10);
  values.status = "New";

  const base = env.AIRTABLE_BASE_ID || DEFAULT_BASE;
  const tableId = env.AIRTABLE_TABLE || DEFAULT_TABLE;
  const url = `https://api.airtable.com/v0/${base}/${encodeURIComponent(tableId)}`;
  const auth = { authorization: `Bearer ${TOKEN}` };

  // Match the form's answers to the table's real column names.
  const known = await tableFieldNames(base, tableId, auth);
  const { fields, unmatched } = mapToColumns(values, known);
  // Anything that found no column goes into a notes-style column, if the table has one.
  const notesCol = known && known.find((n) => /note|comment|message|detail/i.test(n) && !Object.keys(fields).includes(n));
  if (unmatched.length && notesCol) {
    fields[notesCol] = unmatched.map((k) => `${LABELS[k] || k}: ${values[k]}`).join("\n");
  }

  const send = (f) => fetch(url, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ records: [{ fields: f }], typecast: true }),
  });
  let res, err = null;
  const dropped = [];
  // Retry up to 15 times, removing any single column Airtable says it does not know or cannot accept.
  for (let i = 0; i < 15; i++) {
    res = await send(fields);
    if (res.ok) break;
    try { err = (await res.json()).error || null; } catch { err = null; }
    if (res.status !== 422 || !err || !err.message) break;
    const m = String(err.message).match(/(?:Unknown field name|Field)\s*:?\s*"([^"]+)"/i);
    if (!m || !(m[1] in fields)) break;
    dropped.push(m[1]);
    delete fields[m[1]];
  }
  if (dropped.length) console.warn("Inquiry saved without columns:", dropped.join(", "));
  if (!res.ok) {
    const type = (err && (err.type || err)) || "unknown";
    const message = (err && err.message) || "";
    console.error("Airtable error", res.status, type, message);
    return json({ ok: false, error: "airtable", status: res.status, type: String(type), message: String(message).slice(0, 300) }, 200, origin);
  }
  let ref = null;
  try { ref = ((await res.json()).records || [])[0]?.id || null; } catch {}
  return json({ ok: true, ref, dropped }, 200, origin);
}

const LABELS = {
  name: "Name", organization: "Organization", jobTitle: "Job title", email: "Email", phone: "Phone",
  website: "Website", service: "Service of interest", goal: "Goal", success: "Success looks like",
  budget: "Budget", startDate: "Desired start", source: "Heard about us via", submitted: "Submitted", status: "Status",
};

// Possible column names for each answer, best first.
const ALIASES = {
  name: ["Name", "Full Name", "Contact Name", "Client Name", "Contact"],
  organization: ["Organization", "Organization Name", "Company", "Company Name", "Organisation"],
  jobTitle: ["Job Title", "Title", "Role", "Position"],
  email: ["Email Address", "Email", "E-mail"],
  phone: ["Phone Number", "Phone", "Mobile"],
  website: ["Company Website", "Website", "URL"],
  service: ["Service of Interest", "Service", "Services", "Service Line"],
  goal: ["What are you hoping to accomplish?", "Goal", "Goals", "Objective"],
  success: ["What would success look like?", "Success", "Success Criteria"],
  budget: ["Estimated Budget (optional)", "Estimated Budget", "Budget"],
  startDate: ["Desired Start Date", "Start Date", "Timeline", "Timeframe"],
  source: ["How did you hear about us?", "Lead Source", "Source", "Referral Source"],
  submitted: ["Submission Date", "Date Submitted", "Submitted", "Date Received", "Inquiry Date"],
  status: ["Lead Status", "Status", "Stage"],
};

const norm = (s) => String(s).toLowerCase().replace(/\(optional\)/g, "").replace(/[^a-z0-9]/g, "");

function mapToColumns(values, known) {
  const fields = {}, unmatched = [];
  if (!known || !known.length) {
    for (const [k, v] of Object.entries(values)) fields[ALIASES[k][0]] = v;
    return { fields, unmatched };
  }
  const used = new Set();
  const pick = {};
  // Pass 1: exact matches, ignoring case, spaces, punctuation and "(optional)".
  for (const k of Object.keys(values)) {
    for (const a of ALIASES[k]) {
      const hit = known.find((n) => !used.has(n) && norm(n) === norm(a));
      if (hit) { pick[k] = hit; used.add(hit); break; }
    }
  }
  // Pass 2: close matches, where the column name contains a longer alias.
  for (const k of Object.keys(values)) {
    if (pick[k]) continue;
    for (const a of ALIASES[k]) {
      const na = norm(a);
      if (na.length < 5) continue;
      const hit = known.find((n) => !used.has(n) && norm(n).includes(na));
      if (hit) { pick[k] = hit; used.add(hit); break; }
    }
  }
  for (const [k, v] of Object.entries(values)) {
    if (pick[k]) fields[pick[k]] = v;
    else if (k !== "status" && k !== "submitted") unmatched.push(k);
  }
  return { fields, unmatched };
}

// The table's column names: from the schema if the token allows it, else from existing records.
async function tableFieldNames(base, tableId, auth) {
  try {
    const r = await fetch(`https://api.airtable.com/v0/meta/bases/${base}/tables`, { headers: auth });
    if (r.ok) {
      const j = await r.json();
      const t = (j.tables || []).find((t) => t.id === tableId || t.name === tableId);
      if (t) return t.fields.map((f) => f.name);
    }
  } catch {}
  try {
    const r = await fetch(`https://api.airtable.com/v0/${base}/${encodeURIComponent(tableId)}?pageSize=100`, { headers: auth });
    if (r.ok) {
      const j = await r.json();
      const names = new Set();
      for (const rec of j.records || []) for (const n of Object.keys(rec.fields || {})) names.add(n);
      if (names.size) return [...names];
    }
  } catch {}
  return null;
}

