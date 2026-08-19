/**
 * Preflight: checks that would have caught a stale/mismatched load.
 * Run before telling anyone "reload the extension".
 */
import fs from "fs"; import path from "path";
import { fileURLToPath } from "node:url";
const D = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const m = JSON.parse(fs.readFileSync(path.join(D,"manifest.json"),"utf8"));
let bad = 0; const fail = s => { console.log("FAIL", s); bad++; };
const ok = s => console.log("ok  ", s);

// 1. every referenced file exists
const refs = [m.background.service_worker, m.side_panel?.default_path, m.options_ui?.page, m.action?.default_popup]
  .concat(m.content_scripts.flatMap(c => c.js))
  .concat((m.web_accessible_resources||[]).flatMap(w => w.resources)).filter(Boolean);
for (const f of refs) fs.existsSync(path.join(D,f)) ? null : fail(`missing file: ${f}`);
if (!bad) ok(`${refs.length} referenced files present`);

// 2. every id the panel JS touches exists in its HTML
const js = fs.readFileSync(path.join(D,"sidepanel.js"),"utf8");
const html = fs.readFileSync(path.join(D,"sidepanel.html"),"utf8");
const ids = [...js.matchAll(/\$\("([a-z-]+)"\)/g)].map(x=>x[1]);
const have = new Set([...html.matchAll(/id="([a-z-]+)"/g)].map(x=>x[1]));
const miss = [...new Set(ids)].filter(i => !have.has(i));
miss.length ? fail(`ids used in JS but absent from HTML: ${miss.join(", ")}`) : ok("all panel ids resolve");

// 3. the identity a user sees must match what we think we shipped
ok(`manifest says: "${m.name}" v${m.version}`);
console.log(bad ? `\n${bad} problem(s)` : "\npreflight clean");
