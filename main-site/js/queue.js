// Finished levels on their way to the server, kept in this browser until
// they get there.
//
// Every level finished without autoplay, on a seed the game dealt rather
// than a pasted one, is recorded: online straight away, offline once the
// connection is back. The server keeps each browser's levels as a chain,
// and a level only counts towards the Top level board if the one before it
// is in the chain, so the queue is strictly first in, first out and stops
// at the first item it cannot send.
//
// An item carries the leaderboard name it should go under, if any. A name
// given after the level was recorded goes through /api/leaderboard/submit
// instead, or rides along on the queued item if it is still waiting.
//
// Events on document: "uwusort:recorded" { playId, result } when an item
// lands, "uwusort:refused" { playId, code, message } when the server says
// no for good, and "uwusort:queue" { waiting } whenever the queue changes.

import { ApiError, api, isRetryable } from "./api.js";
import { store } from "./ui.js";

const QUEUE_KEY = "uwusort.queue";
const DONE_KEY = "uwusort.recorded"; // play id -> server's result, the last few
const RETRY_MS = 60000;

let flushing = null;
let stalled = false; // the last try could not reach the server

export const isStalled = () => stalled;

function read(key, fallback) {
  try {
    return JSON.parse(store.get(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
}

const items = () => read(QUEUE_KEY, []);
const save = (list) => {
  store.set(QUEUE_KEY, JSON.stringify(list));
  document.dispatchEvent(new CustomEvent("uwusort:queue", { detail: { waiting: list.length } }));
};

export const waiting = () => items().length;
export const isQueued = (playId) => items().some((i) => i.play_id === playId);

export function remember(playId, result) {
  const done = read(DONE_KEY, {});
  done[playId] = result;
  const keys = Object.keys(done);
  for (const k of keys.slice(0, Math.max(0, keys.length - 30))) delete done[k];
  store.set(DONE_KEY, JSON.stringify(done));
}

export const recordedResult = (playId) => read(DONE_KEY, {})[playId] ?? null;

// A finished level: { play_id, seed, run_id, log, duration_ms, at, name }.
export function enqueue(item) {
  const list = items();
  if (!list.some((i) => i.play_id === item.play_id)) list.push(item);
  save(list);
  return flush();
}

// Puts a name on a level still waiting to be sent. False if it has gone.
export function nameQueued(playId, name) {
  const list = items();
  const item = list.find((i) => i.play_id === playId);
  if (!item) return false;
  item.name = name;
  save(list);
  flush();
  return true;
}

export function flush() {
  flushing ??= (async () => {
    try {
      for (;;) {
        const list = items();
        if (!list.length) return;
        const item = list[0];
        try {
          const result = await api.record(item);
          stalled = false;
          remember(item.play_id, result);
          save(items().filter((i) => i.play_id !== item.play_id));
          document.dispatchEvent(new CustomEvent("uwusort:recorded", { detail: { playId: item.play_id, result } }));
        } catch (err) {
          if (isRetryable(err) || !(err instanceof ApiError)) {
            stalled = true;
            document.dispatchEvent(new CustomEvent("uwusort:queue", { detail: { waiting: items().length, stalled } }));
            return;
          }
          // A refused name is the name's fault, not the level's: send the
          // level without it, and say so.
          if (["empty_name", "bad_name", "rude_name"].includes(err.code) && item.name) {
            const fixed = items();
            const same = fixed.find((i) => i.play_id === item.play_id);
            if (same) same.name = null;
            save(fixed);
            document.dispatchEvent(new CustomEvent("uwusort:refused", { detail: { playId: item.play_id, code: err.code, message: err.message, nameOnly: true } }));
            continue;
          }
          save(items().filter((i) => i.play_id !== item.play_id));
          remember(item.play_id, { refused: err.code, message: err.message });
          document.dispatchEvent(new CustomEvent("uwusort:refused", { detail: { playId: item.play_id, code: err.code, message: err.message } }));
        }
      }
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

export function initQueue() {
  window.addEventListener("online", () => flush());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") flush();
  });
  setInterval(() => {
    if (waiting()) flush();
  }, RETRY_MS);
  flush();
}
