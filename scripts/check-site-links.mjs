// Checks every internal link and #anchor in site/ resolves, the way Firebase Hosting serves
// them (cleanUrls: "/docs/guide" -> docs/guide.html). Run: node scripts/check-site-links.mjs
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "site");
const pages = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (name.endsWith(".html")) pages.push(full);
  }
};
walk(root);

const ids = (file) => new Set([...readFileSync(file, "utf8").matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const resolveTarget = (from, url) => {
  const path = url.startsWith("/") ? join(root, url) : join(dirname(from), url);
  for (const candidate of [path, `${path}.html`, join(path, "index.html")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
};

let problems = 0;
for (const page of pages) {
  const html = readFileSync(page, "utf8");
  for (const [, attr, value] of html.matchAll(/\s(href|src)="([^"]*)"/g)) {
    if (/^(https?:|mailto:|data:)/.test(value)) continue;
    const [url, anchor] = value.split("#");
    const target = url ? resolveTarget(page, url) : page;
    const where = `${relative(root, page)}: ${attr}="${value}"`;
    if (!target) { console.error(`✗ missing ${where}`); problems++; continue; }
    if (anchor && target.endsWith(".html") && !ids(target).has(anchor)) { console.error(`✗ no #${anchor} for ${where}`); problems++; }
  }
}
console.log(problems ? `${problems} broken link(s) in ${pages.length} pages` : `✓ all links ok in ${pages.length} pages`);
process.exit(problems ? 1 : 0);
