#!/usr/bin/env node
// Everything the app loads is precached, so the game plays offline from the
// first visit. This fails on a PRECACHE entry in main-site/sw.js with no
// file on disk, and on a file the app can load that is not precached.
//
// Run: node scripts/check-precache.mjs

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "main-site");
const source = readFileSync(join(ROOT, "sw.js"), "utf8");

const context = vm.createContext({ self: { addEventListener() {}, location: { origin: "https://example.test" } } });
vm.runInContext(`${source}\n;globalThis.__precache = PRECACHE;`, context);
const entries = [...context.__precache];

// cleanUrls is on, so "/" is index.html on disk.
const onDisk = (route) => (route === "/" ? "index.html" : route.replace(/^\//, ""));

const seen = new Set();
const missing = [];
const duplicates = [];
for (const route of entries) {
  if (seen.has(route)) duplicates.push(route);
  seen.add(route);
  if (!existsSync(join(ROOT, onDisk(route)))) missing.push(route);
}

function walk(dir) {
  const full = join(ROOT, dir);
  if (!existsSync(full)) return [];
  return readdirSync(full).flatMap((name) => {
    const path = join(full, name);
    return statSync(path).isDirectory() ? walk(join(dir, name)) : [path];
  });
}

// What the app can load: its modules, styles, font and vendored libraries.
// Licence and readme text is not loaded.
const LOADED = /\.(js|css|woff2|png)$/;
const unlisted = [];
for (const dir of ["js", "css", "fonts", "vendor"]) {
  for (const path of walk(dir)) {
    if (!LOADED.test(path)) continue;
    const route = `/${relative(ROOT, path).split(sep).join("/")}`;
    if (!seen.has(route)) unlisted.push(route);
  }
}
// The icons the page and manifest name.
for (const icon of ["/UCS-192.png", "/UCS-512.png", "/UCS-main.png", "/favicon.ico"]) {
  if (!seen.has(icon)) unlisted.push(icon);
}

if (duplicates.length) console.error(`duplicate PRECACHE entries:\n  - ${duplicates.join("\n  - ")}`);
if (missing.length) console.error(`PRECACHE entries with no file on disk:\n  - ${missing.join("\n  - ")}`);
if (unlisted.length) console.error(`files the app loads that are not precached:\n  - ${unlisted.join("\n  - ")}`);

if (missing.length || duplicates.length || unlisted.length) process.exit(1);

console.log(`precache ok: ${entries.length} entries, all present, nothing left out.`);
