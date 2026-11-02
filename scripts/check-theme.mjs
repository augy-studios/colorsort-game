#!/usr/bin/env node
// The daylight hours and the storage key are duplicated in every page's
// pre-paint script, which cannot import theme.js. This fails when a copy
// drifts from js/theme.js.
//
// Run: node scripts/check-theme.mjs

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "main-site");
const theme = readFileSync(join(ROOT, "js", "theme.js"), "utf8");

const from = theme.match(/LIGHT_FROM_HOUR\s*=\s*(\d+)/)?.[1];
const until = theme.match(/LIGHT_UNTIL_HOUR\s*=\s*(\d+)/)?.[1];
const key = theme.match(/APP_KEY\s*=\s*"([^"]+)"/)?.[1];

const failures = [];
// 404.html is the template's own page and is left as it is; take it off
// this list if it is ever brought onto the theme system.
const SKIP = new Set(["404.html"]);
const pages = readdirSync(ROOT).filter((f) => f.endsWith(".html") && !SKIP.has(f));

for (const page of pages) {
  const html = readFileSync(join(ROOT, page), "utf8");
  const script = html.match(/<script>\s*\(function \(\) \{[\s\S]*?data-color-theme[\s\S]*?<\/script>/)?.[0];
  if (!script) {
    failures.push(`${page}: no pre-paint theme script`);
    continue;
  }
  const hours = script.match(/h >= (\d+) && h < (\d+)/);
  if (!hours || hours[1] !== from || hours[2] !== until) {
    failures.push(`${page}: pre-paint hours ${hours?.[1]}-${hours?.[2]}, theme.js has ${from}-${until}`);
  }
  if (!script.includes(`var k = "${key}"`)) failures.push(`${page}: pre-paint key does not match APP_KEY "${key}"`);
}

if (failures.length) {
  console.error("theme check failed:");
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}

console.log(`theme ok: ${pages.length} pages, light ${from}:00 to ${until}:00, key "${key}".`);
