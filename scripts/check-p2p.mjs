#!/usr/bin/env node
// STUN-p2p-spec.md, rule 1: every peer is made with this app's own ICE list,
// which has no TURN relay in it. Fails on a turn: or turns: URL anywhere in
// the app's own code, and on a `new Peer(` that does not pass PEER_OPTIONS.
//
// The vendored PeerJS (main-site/vendor/peerjs) is left out on purpose: its
// built-in default config names PeerJS's public TURN servers, and passing
// our own config is what replaces it, which the second check makes sure of.
//
// Run: node scripts/check-p2p.mjs

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const JS = join(dirname(fileURLToPath(import.meta.url)), "..", "main-site", "js");
const failures = [];

for (const file of readdirSync(JS).filter((f) => f.endsWith(".js"))) {
  const code = readFileSync(join(JS, file), "utf8");
  // A TURN URL in a string, such as "turn:host:3478". Not the game's own
  // `turn:` keys, which are seconds per turn.
  if (/["'`]turns?:[a-z0-9[]/i.test(code)) failures.push(`${file}: names a turn: or turns: server`);
  for (const call of code.matchAll(/new Peer\(([^)]*)\)/g)) {
    if (!call[1].includes("PEER_OPTIONS")) failures.push(`${file}: new Peer(${call[1]}) without PEER_OPTIONS`);
  }
}

const p2p = readFileSync(join(JS, "p2p.js"), "utf8");
if (!/config:\s*\{\s*iceServers:\s*ICE_SERVERS\s*\}/.test(p2p)) failures.push("p2p.js: PEER_OPTIONS does not set config.iceServers");

if (failures.length) {
  console.error("p2p check failed:");
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}
console.log("p2p ok: STUN only, every peer passes PEER_OPTIONS.");
