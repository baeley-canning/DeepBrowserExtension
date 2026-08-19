/**
 * Sync the brand from brand.js into the manifest + panel visibility.
 *
 * Edits land ONLY in brand.js. Run:
 *   node tools/sync-brand.mjs
 *
 * It rewrites manifest.json's name/short_name/description from brand.js. This
 * keeps the brand a single source of truth: never hand-edit the name in the
 * manifest — the sync would overwrite it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const brand = (await import(path.join(DIR, "brand.js"))).default;

const manifestPath = path.join(DIR, "manifest.json");
const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

m.name = brand.name;
m.short_name = brand.shortName;
m.description = `${brand.name}: paste a role, search LinkedIn & SEEK, get a ranked shortlist — in your own browser session.`;

fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");

console.log(`synced manifest → "${brand.name}" (short "${brand.shortName}")`);
console.log("Next: rebuild panel-lib.js if you changed any panel module (node tools/build-panel-lib.mjs) — branding needs no rebuild.");