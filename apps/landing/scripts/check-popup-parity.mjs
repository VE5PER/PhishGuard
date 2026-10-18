import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const popupHtml = readFileSync(resolve(here, "../../extension/popup/popup.html"), "utf8");
const replicaSource = [
  resolve(here, "../components/replica/PopupReplica.tsx"),
  resolve(here, "../lib/popupStates.ts"),
]
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");

const IGNORED_IDS = [
  /^status-badge$/,
  /^domain-text$/,
  /^risk-score$/,
  /^model-.*-text$/,
  /^model-sync-badge$/,
  /^ext-version-text$/,
  /^sqlite-status-text$/,
  /^sig-.*-detail$/,
  /^cloud-(desc|indicator|verdict-title|brand-name|teacher-version|reasons-list|result-view)$/,
  /^(model-)?update-banner$/,
  /^model-status-note$/,
  /^btn-cancel-sync$/,
];

function removeElementsById(html, patterns) {
  let out = html;
  const openTag = /<([a-z0-9]+)\b[^>]*\bid="([^"]+)"[^>]*>/gi;
  let match;
  while ((match = openTag.exec(out)) !== null) {
    const [full, tag, id] = match;
    if (!patterns.some((p) => p.test(id))) continue;
    const start = match.index;
    let depth = 1;
    let cursor = start + full.length;
    const token = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
    token.lastIndex = cursor;
    let t;
    while ((t = token.exec(out)) !== null) {
      depth += t[1] ? -1 : 1;
      if (depth === 0) {
        cursor = t.index + t[0].length;
        break;
      }
    }
    out = out.slice(0, start) + out.slice(cursor);
    openTag.lastIndex = start;
  }
  return out;
}

const decode = (text) =>
  text
    .replace(/&bull;/g, "•")
    .replace(/&amp;/g, "&")
    .replace(/&times;/g, "×")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

const body = popupHtml.slice(popupHtml.indexOf("<body>"));
const cleaned = removeElementsById(
  body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, ""),
  IGNORED_IDS
);

const labels = [...new Set(cleaned.split(/<[^>]+>/).map(decode).filter((text) => text.length > 0))];
const haystack = decode(replicaSource);

let missing = 0;
for (const label of labels) {
  const found = haystack.includes(label);
  if (!found) missing++;
  console.log(`${found ? "OK     " : "MISSING"} ${label}`);
}

console.log(missing === 0 ? `PARITY OK (${labels.length} labels)` : `PARITY FAIL (${missing} missing)`);
process.exit(missing === 0 ? 0 : 1);
