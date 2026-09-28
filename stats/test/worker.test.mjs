// Runs the Worker in Miniflare with a local D1 database and a fake catalog.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const CATALOG_URL = "https://catalog.test/hooks-catalog.json";
const catalog = { name: "community", templates: [{ id: "slack" }, { id: "discord" }, { id: "ntfy" }] };
let mf;

before(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: new URL("../src/index.js", import.meta.url).pathname,
      compatibilityDate: "2026-09-01",
      d1Databases: ["DB"],
      bindings: { SALT: "test-salt", CATALOG_NAME: "community", CATALOG_URL, DIFFICULTY: "8", DAILY_LIMIT: "2" },
      outboundService: (request) => (request.url === CATALOG_URL ? Response.json(catalog) : new Response("no", { status: 404 })),
    }),
  );
  const db = await mf.getD1Database("DB");
  const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8").replace(/--.*$/gm, "");
  for (const statement of schema.split(";").map((part) => part.trim()).filter(Boolean)) await db.prepare(statement).run();
});
after(() => mf.dispose());

const at = (ip) => ({ "cf-connecting-ip": ip });
const get = (path, ip = "203.0.113.1") => mf.dispatchFetch(`https://stats.test${path}`, { headers: at(ip) });
const post = (body, ip = "203.0.113.1", headers = {}) =>
  mf.dispatchFetch("https://stats.test/v1/installs", {
    method: "POST",
    headers: { "content-type": "application/json", ...at(ip), ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

function solve(token, difficulty) {
  for (let nonce = 0; ; nonce += 1) {
    const digest = createHash("sha256").update(`${token}.${nonce}`).digest();
    let bits = 0;
    for (const byte of digest) {
      if (byte === 0) {
        bits += 8;
        continue;
      }
      bits += Math.clz32(byte) - 24;
      break;
    }
    if (bits >= difficulty) return nonce;
  }
}

async function install(template, ip = "203.0.113.1") {
  const issued = await (await get(`/v1/installs/challenge?template=${template}`, ip)).json();
  return post({ catalog: "community", template, version: "1.0.0", token: issued.token, nonce: solve(issued.token, issued.difficulty) }, ip);
}

async function totals() {
  return (await (await get("/v1/installs")).json()).templates;
}

describe("install counter", () => {
  it("issues challenges only for templates in the catalog", async () => {
    const ok = await get("/v1/installs/challenge?template=slack");
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.difficulty, 8);
    assert.match(body.token, /^[\w-]+\.[0-9a-f]{64}$/);
    assert.equal((await get("/v1/installs/challenge?template=made-up")).status, 400);
    assert.equal((await get("/v1/installs/challenge?template=../etc")).status, 400);
  });

  it("counts a solved install once per address per day", async () => {
    assert.equal((await install("slack")).status, 204);
    assert.equal((await install("slack")).status, 204);
    assert.deepEqual(await totals(), { slack: 1 });
  });

  it("rejects reports without a valid, solved challenge", async () => {
    const issued = await (await get("/v1/installs/challenge?template=discord")).json();
    const nonce = solve(issued.token, issued.difficulty);
    const report = { catalog: "community", template: "discord", version: "1.0.0", token: issued.token, nonce };
    assert.equal((await post({ ...report, token: undefined, nonce: undefined })).status, 400, "no challenge");
    assert.equal((await post({ ...report, nonce: nonce + 1 })).status, 403, "unsolved");
    assert.equal((await post({ ...report, token: `${issued.token.split(".")[0]}.${"0".repeat(64)}` })).status, 403, "forged signature");
    assert.equal((await post({ ...report, template: "ntfy" })).status, 403, "token for another template");
    assert.equal((await post(report, "198.51.100.7")).status, 403, "token from another address");
    assert.deepEqual(await totals(), { slack: 1 });
  });

  it("refuses what a web page could send, and oversized bodies", async () => {
    const issued = await (await get("/v1/installs/challenge?template=discord")).json();
    const report = JSON.stringify({ catalog: "community", template: "discord", token: issued.token, nonce: solve(issued.token, issued.difficulty) });
    assert.equal((await post(report, undefined, { "content-type": "text/plain" })).status, 415);
    assert.equal((await post(JSON.stringify({ pad: "x".repeat(2000) }))).status, 413);
    assert.equal((await post("not json")).status, 400);
    assert.equal((await post({ catalog: "someone-else", template: "discord" })).status, 400);
  });

  it("caps how many templates one address counts per day", async () => {
    const ip = "192.0.2.50";
    assert.equal((await install("slack", ip)).status, 204);
    assert.equal((await install("discord", ip)).status, 204);
    assert.equal((await install("ntfy", ip)).status, 429);
    assert.deepEqual(await totals(), { discord: 1, slack: 2 });
  });

  it("treats an IPv6 /64 as one address", async () => {
    assert.equal((await install("ntfy", "2001:db8:aa:bb::1")).status, 204);
    assert.equal((await install("ntfy", "2001:0db8:00aa:00bb:ffff::9")).status, 204);
    assert.equal((await totals()).ntfy, 1);
    assert.equal((await install("ntfy", "2001:db8:aa:bc::1")).status, 204);
    assert.equal((await totals()).ntfy, 2);
  });

  it("serves badges and never stores addresses", async () => {
    assert.deepEqual(await (await get("/v1/badge/community/slack")).json(), { schemaVersion: 1, label: "installs", message: "2", color: "blue", cacheSeconds: 3600 });
    assert.equal((await (await get("/v1/badge/community/made-up")).json()).message, "0");
    const db = await mf.getD1Database("DB");
    const rows = JSON.stringify((await db.prepare("SELECT * FROM seen").all()).results);
    for (const ip of ["203.0.113.1", "192.0.2.50", "2001:db8"]) assert.ok(!rows.includes(ip), `found ${ip}`);
  });

  it("forgets daily hashes in the scheduled clean-up", async () => {
    const db = await mf.getD1Database("DB");
    await db.prepare("INSERT INTO seen (key, client, day) VALUES ('old', 'old', '2000-01-01')").run();
    const worker = await mf.getWorker();
    await worker.scheduled({ cron: "17 3 * * *" });
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM seen WHERE day = '2000-01-01'").first()).n, 0);
  });
});
