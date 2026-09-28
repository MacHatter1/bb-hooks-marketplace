// Install counter for this hooks marketplace, run as a Cloudflare Worker.
// BB's Hooks plugin reports a new install only when the user agreed to share
// install counts with this catalog.
//
//   GET  /v1/installs/challenge?template=<id>   a one-time challenge for one install
//   POST /v1/installs                           record one install (with a solved challenge)
//   GET  /v1/installs                           totals per template, as JSON
//   GET  /v1/badge/<catalog>/<template>         a shields.io endpoint badge
//
// Counting is deliberately hard to game:
// - A report needs a challenge issued to the same network address, for the
//   same template, today, solved with proof of work (DIFFICULTY bits of
//   SHA-256), so every counted install costs real CPU time.
// - One address counts each template once a day, and at most DAILY_LIMIT
//   templates a day. IPv6 addresses count per /64, the block one user holds.
// - Only application/json bodies under 1 KB are read, so a web page can't
//   make its visitors' browsers send reports.
// - Only templates the live catalog lists can be counted.
// Addresses are never stored: only salted hashes, deleted after a day.

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION = /^[A-Za-z0-9.+-]{1,32}$/;
const MAX_BODY_BYTES = 1024;
const CHALLENGE_TTL_SECONDS = 600;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/v1/installs") {
      if (request.method === "POST") return record(request, env);
      if (request.method === "GET") return totals(env);
      return new Response(null, { status: 405, headers: { allow: "GET, POST" } });
    }
    if (url.pathname === "/v1/installs/challenge" && request.method === "GET") return challenge(request, env, url);
    const badge = /^\/v1\/badge\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (badge !== null && request.method === "GET") return badgeFor(env, badge[1], badge[2]);
    return new Response("Not found", { status: 404 });
  },

  // Daily cron: forget the hashes behind the daily limits.
  async scheduled(_event, env) {
    await env.DB.prepare("DELETE FROM seen WHERE day < ?").bind(dayOffset(-1)).run();
  },
};

function settings(env) {
  return {
    difficulty: Math.min(Math.max(Number(env.DIFFICULTY ?? 20), 1), 32),
    dailyLimit: Math.max(Number(env.DAILY_LIMIT ?? 10), 1),
  };
}

async function challenge(request, env, url) {
  if (!env.SALT) return new Response("SALT is not configured", { status: 500 });
  const template = url.searchParams.get("template") ?? "";
  if (!ID.test(template)) return new Response("Unknown template", { status: 400 });
  const known = await catalogTemplates(env);
  if (known === null) return new Response("Catalog unavailable", { status: 503 });
  if (!known.has(template)) return new Response("Unknown template", { status: 400 });
  const day = dayOffset(0);
  const payload = base64url(
    JSON.stringify({ t: template, c: await clientId(env, request, day), d: day, e: nowSeconds() + CHALLENGE_TTL_SECONDS, n: randomHex(8) }),
  );
  const token = `${payload}.${await hmac(env.SALT, `challenge|${payload}`)}`;
  return Response.json({ token, difficulty: settings(env).difficulty }, { headers: { "cache-control": "no-store" } });
}

async function record(request, env) {
  if (!env.SALT) return new Response("SALT is not configured", { status: 500 });
  // Browsers can only send JSON cross-site after a CORS preflight, which this Worker never grants.
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return new Response("Send application/json", { status: 415 });
  }
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return new Response("Body too large", { status: 413 });
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return new Response("Body too large", { status: 413 });
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return new Response("Body must be JSON", { status: 400 });
  }
  const { catalog, template, token, nonce } = body ?? {};
  const version = body?.version ?? null;
  if (catalog !== env.CATALOG_NAME || typeof template !== "string" || !ID.test(template)) return new Response("Unknown catalog or template", { status: 400 });
  if (version !== null && (typeof version !== "string" || !VERSION.test(version))) return new Response("Bad version", { status: 400 });
  if (typeof token !== "string" || token.length > 512 || !Number.isSafeInteger(nonce) || nonce < 0) return new Response("Missing challenge", { status: 400 });

  const day = dayOffset(0);
  const client = await clientId(env, request, day);
  const claims = await verifyToken(env, token);
  if (claims === null || claims.t !== template || claims.d !== day || claims.c !== client || claims.e < nowSeconds()) {
    return new Response("Invalid or expired challenge", { status: 403 });
  }
  if (leadingZeroBits(await sha256(`${token}.${nonce}`)) < settings(env).difficulty) return new Response("Challenge not solved", { status: 403 });

  const known = await catalogTemplates(env);
  if (known === null) return new Response("Catalog unavailable", { status: 503 });
  if (!known.has(template)) return new Response("Unknown template", { status: 400 });

  const key = await sha256Hex(`${env.SALT}|seen|${client}|${catalog}|${template}|${day}`);
  const already = await env.DB.prepare("SELECT 1 FROM seen WHERE key = ?").bind(key).first();
  if (already !== null) return new Response(null, { status: 204 });
  const used = await env.DB.prepare("SELECT COUNT(*) AS n FROM seen WHERE client = ? AND day = ?").bind(client, day).first();
  if ((used?.n ?? 0) >= settings(env).dailyLimit) return new Response("Daily limit reached", { status: 429 });
  const fresh = await env.DB.prepare("INSERT OR IGNORE INTO seen (key, client, day) VALUES (?, ?, ?)").bind(key, client, day).run();
  if (fresh.meta.changes === 1) {
    await env.DB.prepare(
      "INSERT INTO installs (catalog, template, version, day, count) VALUES (?, ?, ?, ?, 1) ON CONFLICT (catalog, template, version, day) DO UPDATE SET count = count + 1",
    )
      .bind(catalog, template, version ?? "", day)
      .run();
  }
  return new Response(null, { status: 204 });
}

async function totals(env) {
  const { results } = await env.DB.prepare("SELECT template, SUM(count) AS installs FROM installs WHERE catalog = ? GROUP BY template ORDER BY template")
    .bind(env.CATALOG_NAME)
    .all();
  const templates = Object.fromEntries(results.map((row) => [row.template, row.installs]));
  return Response.json({ catalog: env.CATALOG_NAME, templates }, { headers: { "cache-control": "public, max-age=300" } });
}

async function badgeFor(env, catalog, template) {
  let count = 0;
  if (catalog === env.CATALOG_NAME && ID.test(template)) {
    const row = await env.DB.prepare("SELECT SUM(count) AS installs FROM installs WHERE catalog = ? AND template = ?").bind(catalog, template).first();
    count = row?.installs ?? 0;
  }
  const badge = { schemaVersion: 1, label: "installs", message: compact(count), color: count > 0 ? "blue" : "lightgrey", cacheSeconds: 3600 };
  return Response.json(badge, { headers: { "cache-control": "public, max-age=3600" } });
}

/** Template ids in the live catalog, cached for an hour. Null when it can't be fetched. */
async function catalogTemplates(env) {
  try {
    const response = await fetch(env.CATALOG_URL, { cf: { cacheTtl: 3600, cacheEverything: true } });
    if (!response.ok) return null;
    const catalog = await response.json();
    if (catalog?.name !== env.CATALOG_NAME || !Array.isArray(catalog.templates)) return null;
    return new Set(catalog.templates.map((template) => template.id));
  } catch {
    return null;
  }
}

/** A salted, per-day hash of the caller's address; IPv6 counts per /64. */
async function clientId(env, request, day) {
  const address = request.headers.get("cf-connecting-ip") ?? "";
  return (await sha256Hex(`${env.SALT}|client|${networkOf(address)}|${day}`)).slice(0, 32);
}

/** An IPv4 address as is, or the first four groups (/64) of an IPv6 address. */
function networkOf(address) {
  if (!address.includes(":")) return address;
  const [head, tail = ""] = address.toLowerCase().split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === "" ? [] : tail.split(":");
  const groups = address.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  return groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, "")).join(":");
}

async function verifyToken(env, token) {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = await hmac(env.SALT, `challenge|${payload}`);
  const a = new TextEncoder().encode(signature);
  const b = new TextEncoder().encode(expected);
  if (a.byteLength !== b.byteLength || !crypto.subtle.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

async function sha256Hex(text) {
  return hex(await sha256(text));
}

function leadingZeroBits(bytes) {
  let bits = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64url(text) {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomHex(bytes) {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/** A UTC date as YYYY-MM-DD, `days` from today. */
function dayOffset(days) {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function compact(count) {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}
