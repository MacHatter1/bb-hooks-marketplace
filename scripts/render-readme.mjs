#!/usr/bin/env node
// Regenerates the catalog table and stats badges in README.md from
// hooks-catalog.json and scores.json, between the <!-- catalog --> and
// <!-- stats --> markers.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { grade, loadScores, scoreStatus } from "./scores.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const catalog = JSON.parse(readFileSync(resolve(root, "hooks-catalog.json"), "utf8"));
const readmePath = resolve(root, "README.md");
const readme = readFileSync(readmePath, "utf8");

// Triggers in plain words, phrased to follow "Runs when"; event names stay in the template details.
const WHEN = {
  "thread.created": "a thread is created",
  "thread.active": "a turn starts",
  "thread.idle": "a turn finishes",
  "thread.failed": "a thread fails",
  "thread.archived": "a thread is archived",
  "thread.unarchived": "a thread is unarchived",
  "thread.deleted": "a thread is deleted",
  "interaction.pending": "an agent needs you",
  "message.queued": "a message is queued",
  "message.dispatched": "a queued message is sent",
  "message.cancelled": "a queued message is cancelled",
  "turn.failed": "a turn fails",
  "experimental_thread.events": "a thread logs activity",
  "experimental_terminal.input": "someone types in a terminal",
  "message.dispatch": "a message is about to be sent",
};
// The same categories and tag rules as the Hooks page in BB.
const CATEGORIES = [
  { label: "🔔 Notify", tags: ["notifications", "desktop", "phone", "push", "voice", "chat", "slack", "discord", "telegram", "teams", "mattermost", "email", "on-call", "pagerduty"] },
  { label: "🔌 Integrate", tags: ["integration", "webhook", "github", "home-automation"] },
  { label: "🤖 Automate", tags: ["automation", "agents", "chaining", "code-review", "housekeeping", "resilience", "scheduling"] },
  { label: "🛡️ Guard", tags: ["gate", "policy", "safety", "secrets", "process"] },
  { label: "📄 Observe", tags: ["audit", "logging"] },
];
const categoryOf = (template) => {
  if (template.kind === "gate") return CATEGORIES[3];
  return CATEGORIES.find((category) => (template.tags ?? []).some((tag) => category.tags.includes(tag))) ?? CATEGORIES[1];
};
// What a user must enter when installing, and what the BB server machine must have.
const setup = (template) => template.params.filter((param) => param.required).map((param) => (param.secret ? `🔒 ${param.label}` : param.label)).join(", ");
const requires = (template) => /needs ([^.]+)/i.exec(template.notes ?? "")?.[1].trim().replace(/ on the machine running the BB server$/, " on the BB server") ?? "";
// "a, b or c", so a trigger list reads as a sentence.
const either = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`);
// A score given before the template's last edit is marked with *; an unscored template shows –.
const scores = loadScores().templates;
const DOTS = { A: "🟢", B: "🟡", C: "🟠", D: "🔴", F: "🔴" };
const score = (template, area) => {
  const entry = scores[template.id];
  const status = scoreStatus(template, entry);
  if (status === "unscored") return "–";
  const letter = grade(entry[area]);
  return `${DOTS[letter[0]]} ${letter}<br><sub>${entry[area]}${status === "stale" ? "*" : ""}</sub>`;
};
// A GitHub login links to its profile; anything else is shown as written.
const author = (template) => {
  const name = template.author ?? catalog.author;
  if (!name) return "–";
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(name) ? `[@${name}](https://github.com/${name})` : name;
};
// Live install counts from the stats Worker (stats/). Switch on once a Hooks
// plugin release that reports installs is out; until then every badge says 0.
const SHOW_INSTALLS = false;
const COUNTER = "https://bb-hooks-stats.machatter1.workers.dev";
const installs = (template) =>
  SHOW_INSTALLS ? ` · ![installs](https://img.shields.io/endpoint?url=${encodeURIComponent(`${COUNTER}/v1/badge/${catalog.name}/${template.id}`)})` : "";
// Three columns so the table fits the page: the hook cell wraps, and each
// detail sits on its own small line under the summary.
const row = (template) => {
  const details = [
    `**Runs when** ${either(template.events.map((event) => WHEN[event] ?? event))}`,
    setup(template) && `**Setup** ${setup(template)}`,
    requires(template) && `**Requires** ${requires(template)}`,
    `\`${catalog.name}/${template.id}\`${template.version ? ` v${template.version}` : ""} · by ${author(template)}${installs(template)}`,
  ].filter(Boolean);
  return `| **${template.name}**<br>${template.summary}<br>${details.map((detail) => `<sub>${detail}</sub>`).join("<br>")} | ${score(template, "security")} | ${score(template, "performance")} |`;
};
const groups = CATEGORIES.map((category) => ({ category, templates: catalog.templates.filter((template) => categoryOf(template) === category) })).filter((group) => group.templates.length > 0);
// GitHub drops the emoji from a heading's anchor, leaving a leading dash.
const anchor = (label) => `#${label.replace(/^\S+\s/, "-").toLowerCase().replace(/\s+/g, "-")}`;
const table = [
  groups.map(({ category, templates }) => `[${category.label} (${templates.length})](${anchor(category.label)})`).join(" · "),
  ...groups.map(({ category, templates }) =>
    [`### ${category.label}`, "", "| Hook | Security | Performance |", "| :-- | :-: | :-: |", ...templates.map(row)].join("\n"),
  ),
].join("\n\n");
const reacts = catalog.templates.filter((t) => t.kind === "observe").length;
const gates = catalog.templates.length - reacts;
// Badges live inside a centered <p> in the README, and GitHub does not render
// Markdown inside raw HTML blocks, so they must be <img> tags.
const badge = (label, value, color) =>
  `<img alt="${label}: ${value}" src="https://img.shields.io/badge/${encodeURIComponent(label)}-${encodeURIComponent(value)}-${color}?style=flat-square">`;
const stats = [badge("templates", String(catalog.templates.length), "6d5cff"), badge("reacts", String(reacts), "3b82f6"), badge("gates", String(gates), "ef4444"), badge("catalog", `v${catalog.version}`, "10b981"), badge("license", "MIT", "8b5cf6")].join(" ");

const replace = (text, marker, content) => {
  const start = `<!-- ${marker}:start -->`;
  const end = `<!-- ${marker}:end -->`;
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  if (from === -1 || to === -1) throw new Error(`README.md is missing the ${marker} markers`);
  return `${text.slice(0, from + start.length)}\n${content}\n${text.slice(to)}`;
};
const next = replace(replace(readme, "catalog", table), "stats", stats);
if (next !== readme) {
  writeFileSync(readmePath, next);
  console.log("README.md updated");
} else {
  console.log("README.md already current");
}
