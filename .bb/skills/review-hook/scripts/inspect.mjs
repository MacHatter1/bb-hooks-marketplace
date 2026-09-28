#!/usr/bin/env node
// Checks a hooks-catalog.json pull request: what it touches, which templates
// it adds or changes, and mechanical faults in those templates.
// Usage: inspect.mjs [--base <ref>] [--head <ref>] [catalog.json]
//   --head  read the catalog from a git ref (default: the file on disk)
//   --base  compare with a ref and inspect only added or changed templates
// Prints FAIL (always wrong), WARN (read it) and INFO lines, each tagged with the
// score it feeds: sec, perf, fix (correctness) or docs. Exits 1 on any FAIL.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual, parseArgs } from "node:util";

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*(?:\|\s*(\d+)\s*)?\}\}/g;
const SECRET_REF = /\{\{\s*secret:([^}\s]+)\s*\}\}/g;
const AGENT_PARTS = ["mode", "providerId", "model", "reasoningLevel", "serviceTier"];
const TOOLS = ["jq", "gh", "curl", "wget", "osascript", "notify-send", "say", "python3", "python", "node", "git", "nc", "ssh", "scp", "openssl"];
const RISKS = [
  [/\b(curl|wget)\b[^\n|]*\|\s*(ba|z)?sh\b|\b(ba|z)?sh\s+<\(\s*(curl|wget)/, "FAIL", "sec", "pipes a download into a shell"],
  [/\beval\b/, "WARN", "sec", "eval: check nothing fetched or payload-derived reaches it"],
  [/base64\s+(-d|--decode|-D)\b|\\x[0-9a-f]{2}/i, "WARN", "sec", "decodes or builds hidden text"],
  [/\brm\s+-[a-z]*r|\bgit\s+(push\s+[^\n]*(-f|--force)|reset\s+--hard|clean\s+-[a-z]*f)/, "WARN", "sec", "destructive file or git operation"],
  [/thread\s+(archive|delete|stop)\b/, "WARN", "sec", "archives, deletes or stops threads: check the scope"],
  [/thread\s+(spawn|tell|message|send|retry|fork|new|create)\b/, "WARN", "perf", "creates agent work: check the loop guard and child-completed re-triggers"],
  [/\bhooks\s+(add|edit|remove|enable|disable|use|secrets)\b|\b(settings|plugin)\s+(set|install|remove|enable|disable)\b/, "FAIL", "sec", "changes BB configuration"],
  [/~\/\.(bb|ssh|aws|config|zshrc|bashrc|profile)|\$HOME\/\.(bb|ssh|aws)|secretsKey|data\.db\b|\bcrontab\b|\blaunchctl\b/, "FAIL", "sec", "touches credentials, BB data or persistence"],
  [/\bnohup\b|\bdisown\b|\bsetsid\b|[^&|]&\s*(\n|$)/, "WARN", "perf", "leaves a process running after the hook exits"],
  [/(^|[\s;|(])(env|printenv)\s*($|[|;>)])/m, "WARN", "sec", "dumps the environment (the server's, including its tokens)"],
];
// Files a template PR has no reason to touch; changes here can weaken the review itself.
const TOOLING = /^(scripts|schema|stats|\.github|\.bb)\/|^package(-lock)?\.json$|^scores\.json$/;

const { values: opts, positionals } = parseArgs({ options: { base: { type: "string" }, head: { type: "string" } }, allowPositionals: true });
const file = positionals[0] ?? "hooks-catalog.json";
const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 16 << 20, stdio: ["ignore", "pipe", "pipe"] });
const readAt = (ref, path) => (ref === undefined ? readFileSync(path, "utf8") : git("show", `${ref}:${path}`));
const print = (level, area, text) => console.log(`  ${level.padEnd(4)} ${area.padEnd(4)} ${text}`);

// Positions of `{{…}}` inside shell double quotes, where a shell-quoted param would gain literal quotes.
function quotedPlaceholders(command) {
  const found = [];
  let state = "none";
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (state === "single") { if (c === "'") state = "none"; continue; }
    if (c === "\\") { i += 1; continue; }
    if (c === "{" && command[i + 1] === "{" && state === "double") found.push(command.slice(i, command.indexOf("}}", i) + 2));
    if (c === '"') state = state === "double" ? "none" : "double";
    else if (c === "'" && state === "none") state = "single";
  }
  return found;
}

/** What the PR touches besides templates. Returns true when something must block. */
function reviewScope(base, head, baseCatalog, headCatalog) {
  let failed = false;
  console.log(`\nPR scope: ${base}...${head ?? "working tree"}`);
  const files = git("diff", "--name-only", head === undefined ? base : `${base}...${head}`).split("\n").filter(Boolean);
  for (const path of files.filter((f) => f !== file && f !== "README.md")) {
    const tooling = TOOLING.test(path);
    failed ||= tooling;
    print(tooling ? "FAIL" : "WARN", tooling ? "sec" : "docs", `touches ${path}${tooling ? " (review tooling: needs a separate maintainer review)" : ""}`);
  }
  for (const key of new Set([...Object.keys(baseCatalog), ...Object.keys(headCatalog)])) {
    if (key === "templates" || isDeepStrictEqual(baseCatalog[key], headCatalog[key])) continue;
    failed ||= key === "name";
    print(key === "name" ? "FAIL" : "WARN", "docs", `catalog ${key}: ${JSON.stringify(baseCatalog[key])} -> ${JSON.stringify(headCatalog[key])}${key === "name" ? " (breaks every installed <name>/<id> reference and stops install counting)" : " (maintainer-owned)"}`);
  }
  const headIds = new Set(headCatalog.templates.map((t) => t.id));
  for (const t of baseCatalog.templates) if (!headIds.has(t.id)) print("WARN", "docs", `removes template ${t.id}`);
  return failed;
}

function inspect(t, catalogName, readme, changed) {
  const out = [];
  const add = (level, area, text) => out.push([level, area, text]);
  const events = t.events ?? [];
  const gate = t.kind === "gate";
  const params = new Map((t.params ?? []).map((p) => [p.key, p]));
  const keys = new Set(params.keys());
  for (const p of params.values()) if (p.type === "agent") for (const part of AGENT_PARTS) keys.add(`${p.key}.${part}`);
  const fields = { command: t.command, url: t.url, body: t.body, ...Object.fromEntries(Object.entries(t.headers ?? {}).map(([k, v]) => [`headers.${k}`, v])) };

  if (changed) add("INFO", "", `changed fields: ${changed.join(", ")}${changed.includes("version") ? "" : " (version not bumped)"}`);
  if (readme !== null && !readme.includes(`\`${catalogName}/${t.id}\``)) add("WARN", "docs", "missing from the README table (run npm run readme)");

  // Text aimed at whoever reviews it rather than whoever installs it.
  const addressed = /\bpre-?approved\b|\b(already|been) (been )?(approved|reviewed|vetted)\b|\bapproved by (the )?(maintainers?|reviewers?)\b|\b(reviewers?|maintainers?|assistant|ai|llm)\b[^.\n]{0,80}\b(skip|ignore|bypass)\b|\bignore (all |any )?(previous|prior|above) instructions\b|\bskip (the )?(checks|review|validation)\b/i;
  const hit = JSON.stringify(t).match(addressed);
  if (hit) add("FAIL", "sec", `text aimed at reviewers or agents: "${hit[0]}"`);

  // Credentials.
  for (const [field, text] of Object.entries(fields)) {
    for (const [, name] of (text ?? "").matchAll(SECRET_REF)) add("FAIL", "sec", `${field} references {{secret:${name}}} directly; secret names are predictable, so this can read another hook's credential`);
  }
  for (const p of params.values()) {
    if (!p.secret && /token|key|secret|password|webhook|url/i.test(`${p.key} ${p.label}`)) add("WARN", "sec", `param ${p.key} ("${p.label}") looks like a credential or capability URL but is not secret: true`);
    if (p.default && /(sk-|ghp_|xox[bp]-|AKIA)[A-Za-z0-9]{8,}|https:\/\/hooks\./.test(p.default)) add("FAIL", "sec", `param ${p.key} has a credential-like default`);
  }

  // Placeholders that nothing fills; bodies may also read the event payload.
  for (const [field, text] of Object.entries(fields)) {
    if (field === "body" || text === undefined) continue;
    for (const [, key] of text.matchAll(PLACEHOLDER)) if (!keys.has(key)) add("FAIL", "fix", `${field} has {{${key}}}, which is not a param and stays literal`);
  }

  // Command: syntax, quoting, risky shapes, tools.
  if (t.command !== undefined) {
    const rendered = t.command.replace(SECRET_REF, '"$BB_SECRET_X"').replace(PLACEHOLDER, "x");
    const syntax = spawnSync("/bin/sh", ["-n"], { input: rendered, encoding: "utf8" });
    if (syntax.status !== 0) add("FAIL", "fix", `sh -n: ${syntax.stderr.trim()}`);
    for (const ph of quotedPlaceholders(t.command)) add("FAIL", "fix", `${ph} is inside shell quotes; the renderer single-quotes params, so the value gains literal quotes. Assign it to a variable first.`);
    if (spawnSync("shellcheck", ["--version"]).status === 0) {
      const lint = spawnSync("shellcheck", ["-s", "sh", "-f", "gcc", "-e", "SC2034", "-"], { input: rendered, encoding: "utf8" });
      for (const line of lint.stdout.split("\n").filter(Boolean)) add("WARN", "fix", `shellcheck ${line.replace(/^-:/, "line ")}`);
    }
    for (const [pattern, level, area, text] of RISKS) if (pattern.test(t.command)) add(level, area, text);
    const bbCommands = [...new Set([...t.command.matchAll(/(?:"\$bb"|\$\{?BB_CLI(?::-bb)?\}?"?|(?:^|[\s;|(])bb)[ \t]+([a-z][a-z-]*)[ \t]+([a-z][a-z-]*)/gm)].map((m) => `bb ${m[1]} ${m[2]}`))];
    if (bbCommands.length) add("INFO", "", `bb commands: ${bbCommands.join(", ")}`);
    const tools = TOOLS.filter((tool) => new RegExp(`(^|[\\s;|(!])${tool}(\\s|$)`, "m").test(t.command));
    if (tools.length) add("INFO", "", `tools: ${tools.join(", ")}`);
    const unnamed = tools.filter((tool) => !new RegExp(`\\b${tool}\\b`).test(`${t.notes ?? ""} ${t.description ?? ""}`));
    if (unnamed.length) add("WARN", "docs", `tools not named in notes/description: ${unnamed.join(", ")}`);
    const env = [...new Set([...t.command.matchAll(/\$\{?(BB_[A-Z_]+)/g)].map((m) => m[1]))];
    if (env.length) add("INFO", "", `env: ${env.join(", ")}`);
    if (env.includes("BB_MESSAGE_TEXT")) add("WARN", "fix", "BB_MESSAGE_TEXT is the first 1000 chars only; read .input.text from stdin for the whole message");
    if (/thread\s+history\b/.test(t.command)) add("WARN", "fix", "bb thread history omits the spawn prompt (single-turn threads return [])");
    const hosts = [...new Set([...t.command.matchAll(/https?:\/\/([^/\s"'$]+)/g)].map((m) => m[1]))];
    if (hosts.length) add("INFO", "", `contacts: ${hosts.join(", ")}`);
  }

  // URL: destination and what leaves the machine.
  if (t.url !== undefined) {
    const dynamic = /^\s*\{\{/.test(t.url);
    let host = "user-supplied";
    if (!dynamic) try { host = new URL(t.url.replace(PLACEHOLDER, "x")).host; } catch { add("FAIL", "fix", `url is not a valid URL: ${t.url}`); }
    add("INFO", "", `POST to ${host}${dynamic ? ` (param ${t.url.replace(/[{}\s]/g, "")})` : ""}`);
    if (t.body === undefined) add("WARN", "sec", "no body: the entire event JSON is sent (agent replies, errors, message text)");
    else {
      try { JSON.parse(t.body.replace(SECRET_REF, "x").replace(PLACEHOLDER, "x")); } catch { add("FAIL", "fix", "body is not valid JSON once placeholders are filled"); }
      const reads = [...new Set([...t.body.matchAll(PLACEHOLDER)].map((m) => m[1]).filter((key) => !keys.has(key)))];
      if (reads.length) add("INFO", "", `sends payload fields: ${reads.join(", ")}`);
      if (events.includes("turn.failed") && /\{\{\s*error\b/.test(t.body)) add("WARN", "fix", "{{error}} is always empty on turn.failed (use errorInfo.category)");
    }
  }

  // Match: JavaScript RegExp after params are filled.
  for (const [field, text] of Object.entries(t.match ?? {})) {
    if (field !== "title" && field !== "text") continue;
    const filled = text.replace(PLACEHOLDER, (_, key) => params.get(key)?.default ?? "x");
    if (filled.length > 512) add("FAIL", "fix", `match.${field} is over 512 chars once filled`);
    try { new RegExp(filled); } catch (error) { add("FAIL", "fix", `match.${field} is not a valid JavaScript RegExp: ${error.message}`); }
    if (/\[\[:\w+:\]\]/.test(filled)) add("WARN", "fix", `match.${field} uses POSIX classes, which JavaScript treats as literal brackets`);
  }

  // Gates and scope.
  if (gate) {
    if ((t.timeoutMs ?? 0) > 8000) add("INFO", "perf", `timeoutMs ${t.timeoutMs} is capped at 8000 for gates`);
    if (t.onError === undefined) add("INFO", "sec", "onError defaults to proceed: a crash or timeout lets the message through");
    if (/thread\s+(spawn|tell|archive)|\bcurl\b|>>?\s*[^&\s]/.test(t.command ?? "") || t.url) add("WARN", "perf", "gate has side effects or network calls; gates should be fast and side-effect free");
  }
  if (!gate && events.includes("thread.idle") && t.match === undefined && out.some(([, , text]) => /creates agent work|archives, deletes/.test(text))) {
    add("WARN", "perf", "runs after every turn of every thread unless the user adds --title/--project; consider enforcing a scope with a required param");
  }

  console.log(`\n${catalogName}/${t.id}  [${changed ? "changed" : "new"} ${t.kind}: ${events.join(", ")}]  ${t.summary}`);
  for (const [level, area, text] of out) print(level, area, text);
  return out.some(([level]) => level === "FAIL");
}

try {
  const headCatalog = JSON.parse(readAt(opts.head, file));
  const baseCatalog = opts.base === undefined ? null : JSON.parse(readAt(opts.base, file));
  let readme = null;
  try { readme = readAt(opts.head, "README.md"); } catch { /* no README at that ref */ }
  let failures = baseCatalog === null ? 0 : Number(reviewScope(opts.base, opts.head, baseCatalog, headCatalog));
  const before = new Map((baseCatalog?.templates ?? []).map((t) => [t.id, t]));
  let scored = {};
  try { scored = JSON.parse(readAt(opts.base, "scores.json")).templates ?? {}; } catch { /* no scores at that ref */ }
  let unchanged = 0;
  for (const t of headCatalog.templates) {
    const old = before.get(t.id);
    if (old !== undefined && isDeepStrictEqual(old, t)) { unchanged += 1; continue; }
    const changed = old === undefined ? null : [...new Set([...Object.keys(old), ...Object.keys(t)])].filter((k) => !isDeepStrictEqual(old[k], t[k]));
    const current = scored[t.id];
    if (changed && current) changed.push(`current score ${current.security}/${current.performance}, stale once merged`);
    failures += Number(inspect(t, headCatalog.name, readme, changed));
  }
  console.log(`\n${failures === 0 ? "no mechanical failures" : `${failures} section(s) with FAIL lines`}${unchanged ? `; ${unchanged} unchanged template(s) skipped` : ""}. Now read each command and body (references/checklist.md).`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (error) {
  console.error(`inspect: ${error.message}`);
  process.exitCode = 2;
}
