#!/usr/bin/env node
// Validates hooks-catalog.json the same way the BB Hooks plugin does:
// JSON Schema (generated from the plugin's validator) plus the rules a
// schema cannot express. Exit code 1 on any problem.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = resolve(new URL("..", import.meta.url).pathname);
const file = process.argv[2] ?? resolve(root, "hooks-catalog.json");
const schema = JSON.parse(readFileSync(resolve(root, "schema/hooks-catalog.schema.json"), "utf8"));
const catalog = JSON.parse(readFileSync(file, "utf8"));

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);
const problems = [];
if (!validate(catalog)) {
  for (const error of validate.errors ?? []) problems.push(`${error.instancePath || "/"}: ${error.message}`);
}

const GATE_EVENTS = new Set(["message.dispatch"]);
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*(?:\|\s*\d+\s*)?\}\}/g;
const ids = new Set();
for (const [index, template] of (catalog.templates ?? []).entries()) {
  const at = `/templates/${index} (${template.id ?? "?"})`;
  if (ids.has(template.id)) problems.push(`${at}: duplicate id`);
  ids.add(template.id);
  if ((template.command === undefined) === (template.url === undefined)) problems.push(`${at}: needs exactly one of command or url`);
  for (const event of template.events ?? []) {
    if ((template.kind === "gate") !== GATE_EVENTS.has(event)) problems.push(`${at}: ${event} is not a ${template.kind} event`);
  }
  const keys = new Set();
  for (const param of template.params ?? []) {
    if (keys.has(param.key)) problems.push(`${at}: duplicate param ${param.key}`);
    keys.add(param.key);
    if (param.secret && param.type !== "string") problems.push(`${at}: only string params can be secret`);
    if (param.type === "agent") {
      for (const part of ["mode", "providerId", "model", "reasoningLevel", "serviceTier"]) keys.add(`${param.key}.${part}`);
      const value = (param.default ?? "").trim();
      if (value !== "" && value !== "inherit" && !/^[a-z0-9][a-z0-9-]*$/i.test(value) && !value.startsWith("{")) problems.push(`${at}: agent default must be inherit, a provider id, or JSON`);
    }
    if (param.required && param.default !== undefined) problems.push(`${at}: param ${param.key} is required but has a default (pick one)`);
  }
  // Every {{placeholder}} in command/url/headers/match must be a declared param.
  // Bodies may also read the event payload at run time (thread.title, lastAssistantText|300, …).
  const check = (field, text) => {
    for (const match of text.matchAll(PLACEHOLDER)) {
      const key = match[1];
      if (!keys.has(key)) problems.push(`${at}: ${field} references {{${key}}} which is not a param`);
    }
  };
  if (template.command) check("command", template.command);
  if (template.url) check("url", template.url);
  for (const [name, value] of Object.entries(template.headers ?? {})) check(`headers.${name}`, value);
  for (const [name, value] of Object.entries(template.match ?? {})) check(`match.${name}`, value);
  if (template.body !== undefined) {
    // Placeholders normally sit inside JSON strings; with each replaced by text
    // the body must parse. An unquoted object placeholder is unusual, so warn only.
    try {
      JSON.parse(template.body.replace(PLACEHOLDER, "x"));
    } catch {
      console.warn(`warning: ${at}: body does not parse as JSON once placeholders are filled; check quoting`);
    }
  }
}

if (problems.length > 0) {
  console.error(`hooks-catalog.json is invalid:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(`ok: catalog "${catalog.name}" with ${catalog.templates.length} template${catalog.templates.length === 1 ? "" : "s"}`);
for (const template of catalog.templates) console.log(`  ${catalog.name}/${template.id}  [${template.kind}]  ${template.summary}`);
