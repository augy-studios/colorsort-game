#!/usr/bin/env node
// Guards the change that silently turns the update bar into a silent
// takeover: skipWaiting() or clients.claim() anywhere but the message
// handler. Also checks the precache rules sw.js depends on.
//
// Run: node scripts/check-sw.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SW = join(dirname(fileURLToPath(import.meta.url)), "..", "main-site", "sw.js");

// Line comments first: the header prose could otherwise close a block
// comment early and swallow real code.
const code = readFileSync(SW, "utf8")
  .replace(/^\s*\/\/.*$/gm, "")
  .replace(/\/\*[\s\S]*?\*\//g, "");

const failures = [];

const handlerAt = code.search(/addEventListener\(\s*["']message["']/);
if (handlerAt < 0) {
  failures.push("no message handler, so nothing can promote the waiting worker");
} else {
  const before = code.slice(0, handlerAt);
  const after = code.slice(handlerAt);
  if (/skipWaiting\s*\(/.test(before)) failures.push("skipWaiting() is called outside the message handler");
  if (/clients\.claim\s*\(/.test(before)) failures.push("clients.claim() is called outside the message handler");
  if (!/skipWaiting\s*\(/.test(after)) failures.push("the message handler never calls skipWaiting()");
  if (!/["']skip-waiting["']/.test(after)) failures.push("the message handler does not gate on 'skip-waiting'");
}

// Stated the other way round, so a call added inside install or activate is
// caught even if the handler still looks right.
for (const name of ["install", "activate", "fetch"]) {
  const at = code.search(new RegExp(`addEventListener\\(\\s*["']${name}["']`));
  if (at < 0) continue;
  const rest = code.slice(at + 1);
  const nextAt = rest.search(/self\.addEventListener\(/);
  const body = nextAt < 0 ? rest : rest.slice(0, nextAt);
  if (/skipWaiting\s*\(/.test(body)) failures.push(`skipWaiting() appears in the ${name} handler`);
  if (/clients\.claim\s*\(/.test(body)) failures.push(`clients.claim() appears in the ${name} handler`);
}

if (/cache\.addAll\s*\(/.test(code)) failures.push("cache.addAll() is used: one bad path fails the whole install");
if (!/cache:\s*["']reload["']/.test(code)) failures.push("precache fetches do not pass cache: 'reload'");
if (!/function isCacheable/.test(code)) failures.push("no isCacheable() gate on cache writes");

const version = code.match(/VERSION\s*=\s*["']([^"']+)["']/)?.[1];
if (!version) failures.push("no VERSION constant, which is the trigger for the update prompt");

if (failures.length) {
  console.error("sw.js check failed:");
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}

console.log(`sw.js ok: version ${version}, worker waits for a reader to press Reload.`);
