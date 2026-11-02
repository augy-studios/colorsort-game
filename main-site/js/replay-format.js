// The replay format, shared by the API that stores replays and the page that
// plays them. A replay is what happened, not what it scored: every score is
// worked out again from the logs by js/rules.js, so a replay cannot claim
// points its moves do not add up to.
//
// {
//   v: 1,
//   kind: "solo" | "race" | "turns",
//   seed: "WE12-BXK4-M9TR",
//   timed: true | false,      whether speed bonuses counted
//   players: ["Augy", "Ben"],
//   logs: [[...], ...],       js/rules.js's log; one per player in a race,
//                             one shared log otherwise
//   at: ISO time the level started, or null
// }
//
// Online, a replay is stored by /api/replay/create and shared as /r/<id>.
// Offline, or when the API will not take it, the whole game travels in the
// link instead, the way chess-game's replay links do: the seed as it is,
// and each log packed a couple of bytes a move.

import { EXTRA, HINT, JOIN, LEAVE, MAX_LOG, MOVE, RESTART, UNDO, levelShape } from "./rules.js";
import { parseSeed } from "./seed.js";

export const REPLAY_VERSION = 1;
export const MAX_PLAYERS = 4;
const KINDS = ["solo", "race", "turns"];

// Control characters out, whitespace collapsed, cut to `max` characters.
export function cleanText(value, max) {
  if (typeof value !== "string") return "";
  const text = value.normalize("NFKC").replace(/\p{C}/gu, "").replace(/\s+/gu, " ").trim();
  return Array.from(text).slice(0, max).join("").trim();
}

function cleanLog(raw, columns, players, party) {
  if (!Array.isArray(raw) || raw.length > MAX_LOG) return null;
  const log = [];
  let last = 0;
  for (const e of raw) {
    if (!Array.isArray(e)) return null;
    const [t, code, x, y] = e;
    if (!Number.isInteger(t) || t < last) return null;
    last = t;
    if (code === MOVE && e.length === 4 && [x, y].every((c) => Number.isInteger(c) && c >= 0 && c < columns)) log.push([t, MOVE, x, y]);
    else if ((code === UNDO || code === HINT || code === EXTRA || code === RESTART) && e.length === 2) log.push([t, code]);
    else if ((code === LEAVE || code === JOIN) && party && e.length === 3 && Number.isInteger(x) && x >= 0 && x < players) log.push([t, code, x]);
    else return null;
  }
  return log;
}

// A replay from anywhere (a link, the API, a party host) made safe to use,
// or null if it is not one. The logs are checked for shape here; whether
// their moves are legal is for rules.js when it plays them.
export function cleanReplay(raw) {
  if (!raw || typeof raw !== "object" || raw.v !== REPLAY_VERSION) return null;
  const kind = KINDS.includes(raw.kind) ? raw.kind : null;
  const seed = parseSeed(raw.seed);
  if (!kind || !seed || typeof raw.seed !== "string" || seed.text !== raw.seed.toUpperCase()) return null;
  const shape = levelShape(seed.mode, seed.difficulty, seed.level);
  const columns = shape.colours + shape.empties + 1;

  const players = (Array.isArray(raw.players) ? raw.players.slice(0, MAX_PLAYERS) : []).map(
    (p, i) => cleanText(p, 20) || `Player ${i + 1}`
  );
  if (!players.length || (kind === "solo" && players.length !== 1)) return null;
  const wantLogs = kind === "race" ? players.length : 1;
  if (!Array.isArray(raw.logs) || raw.logs.length !== wantLogs) return null;
  const logs = raw.logs.map((log) => cleanLog(log, columns, players.length, kind === "turns"));
  if (logs.some((l) => !l) || logs.every((l) => !l.length)) return null;

  const at = typeof raw.at === "string" && !Number.isNaN(Date.parse(raw.at)) ? new Date(raw.at).toISOString() : null;
  return { v: REPLAY_VERSION, kind, seed: seed.text, timed: raw.timed === true, players, logs, at };
}

// What rules.js's createGame() wants for one board of a replay: the whole
// game for solo and turns, one racer's board in a race.
export const setupOf = (replay, board = 0) => ({
  seed: parseSeed(replay.seed),
  timed: replay.timed,
  players: replay.kind === "race" ? [replay.players[board]] : replay.players,
  turns: replay.kind === "turns",
});

/* ---- packing a log into a link ----
   Each entry is one byte saying what happened, a second byte for a move
   (from * 16 + to) or a party player, then the milliseconds since the entry
   before as a varint. Two or three bytes a move. No level has more than 16
   columns, which js/rules.js's shapes keep to. */

function toBase64Url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export function packLog(log) {
  const bytes = [];
  let prev = 0;
  for (const [t, code, x, y] of log) {
    bytes.push(code);
    if (code === MOVE) bytes.push(x * 16 + y);
    else if (code === LEAVE || code === JOIN) bytes.push(x);
    let delta = t - prev;
    prev = t;
    do {
      let b = delta & 0x7f;
      delta = Math.floor(delta / 128);
      if (delta > 0) b |= 0x80;
      bytes.push(b);
    } while (delta > 0);
  }
  return toBase64Url(Uint8Array.from(bytes));
}

export function unpackLog(text) {
  const bytes = fromBase64Url(text ?? "");
  if (!bytes) return null;
  const log = [];
  let t = 0;
  let i = 0;
  while (i < bytes.length) {
    const code = bytes[i++];
    let entry;
    if (code === MOVE) {
      if (i >= bytes.length) return null;
      const b = bytes[i++];
      entry = [MOVE, b >> 4, b & 15];
    } else if (code === LEAVE || code === JOIN) {
      if (i >= bytes.length) return null;
      entry = [code, bytes[i++]];
    } else if (code === UNDO || code === HINT || code === EXTRA || code === RESTART) entry = [code];
    else return null;
    let delta = 0;
    let scale = 1;
    for (;;) {
      if (i >= bytes.length || scale > 2 ** 35) return null;
      const b = bytes[i++];
      delta += (b & 0x7f) * scale;
      scale *= 128;
      if (!(b & 0x80)) break;
    }
    t += delta;
    log.push([t, ...entry]);
  }
  return log;
}

// A link that holds the whole game.
export function longLink(origin, replay) {
  const params = new URLSearchParams({
    watch: replay.logs.map(packLog).join("."),
    seed: replay.seed,
    kind: replay.kind,
    timed: replay.timed ? "1" : "0",
    names: replay.players.map((n) => n.replace(/,/g, " ")).join(","),
  });
  return `${origin}/?${params}`;
}

export const shortLink = (origin, id) => `${origin}/r/${id}`;

// Reads a long link's parameters. A replay, { damaged: true } if the link
// is broken, or null if it is not a replay link.
export function readLongLink(params) {
  if (!params.has("watch")) return null;
  const names = (params.get("names") ?? "").split(",").filter(Boolean);
  const replay = cleanReplay({
    v: REPLAY_VERSION,
    kind: params.get("kind") ?? "solo",
    seed: params.get("seed") ?? "",
    timed: params.get("timed") === "1",
    players: names.length ? names : ["Player"],
    logs: (params.get("watch") ?? "").split(".").map(unpackLog),
    at: null,
  });
  return replay ?? { damaged: true };
}
