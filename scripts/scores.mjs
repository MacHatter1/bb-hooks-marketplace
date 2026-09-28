#!/usr/bin/env node
// Maintainer review scores (scores.json) for the templates in hooks-catalog.json.
// Each score records the hash of the template it was given for, so any later
// edit marks it stale. The rubric is .bb/skills/review-hook/references/scoring.md.
//   node scripts/scores.mjs                 list every template's score and status
//   node scripts/scores.mjs --stamp <id>…   record the current hash, version and date
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const scoresPath = resolve(root, "scores.json");
const CRITICAL_CAP = 40;

const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};

export const templateHash = (template) => createHash("sha256").update(canonical(template)).digest("hex").slice(0, 16);

export function loadScores() {
  try {
    return JSON.parse(readFileSync(scoresPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { templates: {} };
    throw error;
  }
}

/** "scored", "stale" (the template changed after it was scored) or "unscored". */
export function scoreStatus(template, entry) {
  if (entry === undefined) return "unscored";
  return entry.hash === templateHash(template) ? "scored" : "stale";
}

// Standard US letter grades; each entry is the lowest score for that grade.
const GRADES = [[97, "A+"], [93, "A"], [90, "A-"], [87, "B+"], [83, "B"], [80, "B-"], [77, "C+"], [73, "C"], [70, "C-"], [67, "D+"], [63, "D"], [60, "D-"], [0, "F"]];

export const grade = (score) => GRADES.find(([floor]) => score >= floor)[1];

/** The score an entry's deductions add up to: 100 minus the points, floored at 0, capped at 40 after a Critical. */
export function expectedScore(entry, area) {
  const deductions = (entry.deductions ?? []).filter((deduction) => deduction.area === area);
  const total = Math.max(0, 100 - deductions.reduce((sum, deduction) => sum + deduction.points, 0));
  return deductions.some((deduction) => deduction.level === "critical") ? Math.min(total, CRITICAL_CAP) : total;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const catalog = JSON.parse(readFileSync(resolve(root, "hooks-catalog.json"), "utf8"));
  const scores = loadScores();
  const byId = new Map(catalog.templates.map((template) => [template.id, template]));
  const args = process.argv.slice(2);

  if (args[0] === "--stamp") {
    const today = new Date().toISOString().slice(0, 10);
    for (const id of args.slice(1)) {
      const template = byId.get(id);
      const entry = scores.templates[id];
      if (template === undefined) throw new Error(`no template "${id}" in hooks-catalog.json`);
      if (entry === undefined) throw new Error(`score "${id}" in scores.json before stamping it`);
      Object.assign(entry, { version: template.version, reviewed: today, hash: templateHash(template) });
    }
    writeFileSync(scoresPath, `${JSON.stringify(scores, null, 2)}\n`);
    console.log(`stamped ${args.length - 1} template(s)`);
  } else {
    let problems = 0;
    for (const template of catalog.templates) {
      const entry = scores.templates[template.id];
      const status = scoreStatus(template, entry);
      const notes = [];
      if (entry !== undefined) {
        for (const area of ["security", "performance"]) {
          const expected = expectedScore(entry, area === "security" ? "sec" : "perf");
          if (entry[area] !== expected) notes.push(`${area} is ${entry[area]} but its deductions give ${expected}`);
        }
      }
      if (status !== "scored" || notes.length > 0) problems += 1;
      const numbers = (entry === undefined ? "–/–" : `${entry.security} ${grade(entry.security)} / ${entry.performance} ${grade(entry.performance)}`).padEnd(17);
      console.log(`${template.id.padEnd(22)} ${numbers} ${status}${notes.length ? `  (${notes.join("; ")})` : ""}`);
    }
    for (const id of Object.keys(scores.templates)) if (!byId.has(id)) console.log(`${id.padEnd(22)} scored but no longer in the catalog`);
    process.exitCode = problems === 0 ? 0 : 1;
  }
}
