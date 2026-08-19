/**
 * Bundle the panel's dependencies into ONE classic script.
 *
 * sidepanel.js was converted to <script type="module"> and the entire panel
 * went dead: an extension-page module that fails to resolve ANY import runs
 * nothing, attaches no listeners, and surfaces no error anywhere obvious. The
 * module sources stay (the unit tests import them); the panel loads the bundle,
 * so there is no resolution step left to fail at runtime.
 *
 * Each file is wrapped in an IIFE that publishes only its exports onto a single
 * global. Without the wrapper, module-private helpers with the same name in two
 * files ("sleep", "rand") collide and the whole script fails to parse — which
 * would trade one silent breakage for another.
 *
 *   node tools/build-panel-lib.mjs
 */
import fs from "fs";
import path from "path";

const DIR = path.resolve(import.meta.dirname, "..");
// Dependency order.
const FILES = [
  "recorder.js",
  "card-parse.js",
  "deepseek.js",
  "agent-loop.js",
  "hunt-plan.js",
  "hunt-run.js",
  "diagnose.js",
  "read-document.js",
];

const header = `/**
 * panel-lib.js — GENERATED. Do not edit by hand.
 * Regenerate with: node tools/build-panel-lib.mjs
 *
 * The panel's dependencies as one CLASSIC script, published on window.RM.
 * See tools/build-panel-lib.mjs for why this is not a module.
 */
window.RM = window.RM || {};
`;

let out = header;

for (const file of FILES) {
  const src = fs.readFileSync(path.join(DIR, file), "utf8");
  const names = [];

  const body = src
    // Imports are resolved by concatenation order instead.
    .replace(/^\s*import[^;]+;\s*$/gm, "")
    .replace(/^export\s+(async\s+)?function\s+([A-Za-z0-9_$]+)/gm, (_m, a = "", n) => {
      names.push(n);
      return `${a}function ${n}`;
    })
    .replace(/^export\s+(const|let|class)\s+([A-Za-z0-9_$]+)/gm, (_m, kw, n) => {
      names.push(n);
      return `${kw} ${n}`;
    })
    .replace(/^export\s*\{([^}]*)\};?\s*$/gm, (_m, list) => {
      for (const n of list.split(",").map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean)) names.push(n);
      return "";
    });

  const publish = [...new Set(names)].map((n) => `  window.RM.${n} = ${n};`).join("\n");
  out += `\n// ── ${file} ${"─".repeat(Math.max(0, 58 - file.length))}\n(function () {\n${body}\n${publish}\n})();\n`;
}

fs.writeFileSync(path.join(DIR, "panel-lib.js"), out);
console.log(`panel-lib.js written — ${out.split("\n").length} lines from ${FILES.length} modules`);
