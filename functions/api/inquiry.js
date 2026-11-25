// Cloudflare Pages Function: POST /api/inquiry
// Receives the website inquiry form and creates a record in Airtable.
// Secrets (set in Cloudflare > Workers & Pages > this project > Settings > Variables and secrets):
//   AIRTABLE_TOKEN    Airtable personal access token (scope: data.records:write, this base only)
// Optional variables:
//   AIRTABLE_BASE_ID  defaults to the Olira Group base
//   AIRTABLE_TABLE    defaults to "Olira Group | CRM & Business Development"
//   ALLOWED_ORIGIN    defaults to https://www.oliragroup.com (apex is allowed too)

const DEFAULT_BASE = "appYu5L6nbc3oPR2S";
const DEFAULT_TABLE = "Olira Group | CRM & Business Development";

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

export async function onRequestPost({ request, env }) {
  const origin = allowedOrigin(request, env);
  if (!origin && request.headers.get("origin")) return json({ ok: false, error: "origin" }, 403);
  if (!env.AIRTABLE_TOKEN) return json({ ok: false, error: "not_configured" }, 503, origin);

  let data;
  try { data = await request.json(); } catch { return json({ ok: false, error: "bad_request" }, 400, origin); }

  // Spam traps: hidden field must stay empty, and the form must take more than 3 seconds to fill.
  if ((data.company_fax || "").trim()) return json({ ok: true }, 200, origin);
  if (Number(data.elapsed || 0) < 3000) return json({ ok: false, error: "too_fast" }, 400, origin);

  const fields = {};
  const missing = [];
  for (const [key, [column, required]] of Object.entries(FIELDS)) {
    let v = typeof data[key] === "string" ? data[key].trim().slice(0, 5000) : "";
    if (!v) { if (required) missing.push(key); continue; }
    if (key === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { missing.push(key); continue; }
    if (key === "website" && !/^https?:\/\//i.test(v)) v = "https://" + v;
    fields[column] = v;
  }
  if (missing.length) return json({ ok: false, error: "missing", fields: missing }, 400, origin);

  fields["Submission Date"] = new Date().toISOString().slice(0, 10);
  fields["Lead Status"] = "New";

  const base = env.AIRTABLE_BASE_ID || DEFAULT_BASE;
  const table = encodeURIComponent(env.AIRTABLE_TABLE || DEFAULT_TABLE);
  const send = (f) => fetch(`https://api.airtable.com/v0/${base}/${table}`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.AIRTABLE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ records: [{ fields: f }], typecast: true }),
  });
  let res = await send(fields);
  let err = null;
  if (!res.ok) {
    try { err = (await res.json()).error || null; } catch { err = null; }
    // If the two automatic fields are computed or named differently in Airtable, retry without them.
    if (res.status === 422) {
      delete fields["Submission Date"];
      delete fields["Lead Status"];
      res = await send(fields);
      if (!res.ok) { try { err = (await res.json()).error || err; } catch {} }
    }
  }
  if (!res.ok) {
    const type = (err && (err.type || err)) || "unknown";
    const message = (err && err.message) || "";
    console.error("Airtable error", res.status, type, message);
    return json({ ok: false, error: "airtable", status: res.status, type: String(type), message: String(message).slice(0, 300) }, 502, origin);
  }
  return json({ ok: true }, 200, origin);
}
