#!/usr/bin/env node
// The rules, without a browser or a database: seeds, dealing, the solver,
// scoring, the server's check of a finished level, and replay links.
//
// Run: node scripts/test-rules.mjs

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const JS = join(dirname(fileURLToPath(import.meta.url)), "..", "main-site", "js");
const load = (name) => import(pathToFileURL(join(JS, name)).href);

const rules = await load("rules.js");
const { newSeed, parseSeed } = await load("seed.js");
const { solve, isSolved, cloneCols } = await load("puzzle.js");
const fmt = await load("replay-format.js");

let failures = 0;
const check = (ok, what) => {
  if (!ok) {
    failures += 1;
    console.error(`FAIL ${what}`);
  }
};

// Bytes from a fixed sequence, so the test deals the same levels every run.
function bytes(seedNumber) {
  const next = rules.randomSource(`test|${seedNumber}`);
  return () => next() & 255;
}

/* ---- seeds ---- */

const s = newSeed("bolts", "hard", 27, bytes(1));
check(/^BH27-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(s.text), `seed text ${s.text}`);
check(parseSeed(s.text.toLowerCase().replace(/-/g, " "))?.text === s.text, "seed parses back, any case and spacing");
check(parseSeed(s.body, { mode: "water", difficulty: "medium", level: 3 })?.text.startsWith("WM3-"), "a bare body takes the fallback");
check(parseSeed("WE0-BBBB-BBBB") === null, "level 0 is not a seed");
check(parseSeed("XE1-BBBB-BBBB") === null, "unknown mode is not a seed");
check(parseSeed("WE12-2BBB-BBBB")?.level === 12, "a body starting with a digit keeps the level apart");

/* ---- dealing: every shape, many levels, all solvable, all the same twice ---- */

let dealt = 0;
let slowest = 0;
for (const mode of Object.keys(rules.MODES)) {
  for (const difficulty of Object.keys(rules.DIFFICULTIES)) {
    for (let level = 1; level <= 40; level += 3) {
      for (let k = 0; k < 6; k++) {
        const seed = newSeed(mode, difficulty, level, bytes(`${mode}${difficulty}${level}${k}`));
        const t0 = performance.now();
        const a = rules.dealSeed(seed);
        slowest = Math.max(slowest, performance.now() - t0);
        const again = rules.dealSeed(parseSeed(seed.text));
        check(JSON.stringify(a.cols) === JSON.stringify(again.cols), `${seed.text} deals the same twice`);
        check(a.cols.length + 1 <= 16, `${seed.text} fits 16 columns with the extra`);
        const path = solve(a.cols, a.shape.cap, { maxNodes: 300000 });
        check(path !== null, `${seed.text} is solvable`);
        dealt += 1;
      }
    }
  }
}
console.log(`dealt ${dealt} levels, slowest ${slowest.toFixed(0)} ms`);

/* ---- playing a level as a person would, and as autoplay would ---- */

function playLog(seed, gapMs, { undos = 0 } = {}) {
  const { cols, shape } = rules.dealSeed(seed);
  const path = solve(cols, shape.cap, { maxNodes: 300000 });
  const log = [];
  let t = 0;
  path.forEach(([a, b], i) => {
    t += gapMs;
    log.push([t, rules.MOVE, a, b]);
    if (i < undos) {
      t += gapMs;
      log.push([t, rules.UNDO]);
      t += gapMs;
      log.push([t, rules.MOVE, a, b]);
    }
  });
  return { log, end: t };
}

const seed = newSeed("water", "medium", 5, bytes(99));
const setup = { seed, timed: true, players: ["Tester"] };
const human = playLog(seed, 1800);
const ok = rules.checkGame(setup, human.log, human.end, human.end + 5000);
check(ok.reason === null, `a human-paced solve passes (${ok.reason})`);
check(ok.result?.score > 0, "and scores");

const withUndos = playLog(seed, 1800, { undos: 3 });
const undone = rules.checkGame(setup, withUndos.log, withUndos.end, withUndos.end + 5000);
check(undone.reason === null && undone.result.score < ok.result.score, "undos cost points");

const offline = rules.checkGame({ ...setup, timed: false }, human.log, human.end, null);
check(offline.reason === null && offline.result.score < ok.result.score, "an untimed level scores without speed bonuses");
check(offline.result.timeBonus === 0, "and without a time bonus");

const bot = playLog(seed, 170);
check(rules.checkGame(setup, bot.log, bot.end, bot.end + 5000).reason === "too_fast", "autoplay pace is refused");

check(rules.checkGame(setup, human.log, human.end, human.end - 60000).reason === "too_long", "longer than the server saw is refused");
check(rules.checkGame(setup, human.log.slice(0, -1), human.log.at(-2)[0], null).reason === "not_finished", "an unfinished level is refused");
const bad = human.log.map((e) => e.slice());
bad[0] = [bad[0][0], rules.MOVE, 0, 0];
check(rules.checkGame(setup, bad, human.end, null).reason === "bad_move", "an illegal move is refused");
check(rules.checkGame(setup, human.log, human.end + 1, null).reason === "bad_duration", "a duration past the last move is refused");

// Harder levels score more for the same play.
const easy = newSeed("water", "easy", 1, bytes(5));
const hard = newSeed("water", "hard", 1, bytes(5));
const se = playLog(easy, 1800);
const sh = playLog(hard, 1800);
const re = rules.checkGame({ seed: easy, timed: false }, se.log, se.end, null);
const rh = rules.checkGame({ seed: hard, timed: false }, sh.log, sh.end, null);
check(rh.result.score > re.result.score, "hard scores more than easy");

/* ---- hidden nuts stay revealed after undo ---- */

{
  let found = false;
  for (let k = 0; k < 40 && !found; k++) {
    const hs = newSeed("bolts", "medium", 1, bytes(`hidden${k}`));
    const state = rules.createGame({ seed: hs, timed: false });
    const path = solve(state.cols, state.cap);
    for (let i = 0; i < path.length && !found; i++) {
      const [a, b] = path[i];
      const ev = rules.move(state, a, b, (i + 1) * 1000);
      if (ev[0].revealed) {
        const under = state.cols[a][state.cols[a].length - 1];
        rules.undo(state, (i + 1) * 1000 + 500);
        const after = state.cols[a][state.cols[a].length - 1 - ev[0].n];
        check(after === under && under < 16, "an uncovered nut stays uncovered after undo");
        found = true;
      }
    }
  }
  check(found, "a bolts level uncovers a hidden nut");
}

/* ---- hard water hides layers too ---- */

{
  const ws = newSeed("water", "hard", 1, bytes("hiddenwater"));
  const state = rules.createGame({ seed: ws, timed: false });
  check(state.cols.flat().some((u) => u >= 16), "a hard water level starts with hidden layers");
  const path = solve(state.cols, state.cap);
  check(Array.isArray(path), "and can be solved");
  let revealed = false;
  path.forEach(([a, b], i) => (revealed = rules.move(state, a, b, (i + 1) * 1000)[0].revealed || revealed));
  check(revealed && state.cols.flat().every((u) => u < 16), "and shows every layer by the end");
  const medium = rules.createGame({ seed: newSeed("water", "medium", 1, bytes("hiddenwater")), timed: false });
  check(medium.cols.flat().every((u) => u < 16), "medium water hides nothing");
}

/* ---- turns: a finished column keeps the turn ---- */

{
  const ts = newSeed("water", "easy", 1, bytes("turns"));
  const state = rules.createGame({ seed: ts, timed: false, players: ["A", "B"], turns: true });
  const path = solve(state.cols, state.cap);
  let t = 0;
  for (const [a, b] of path) {
    const before = state.current;
    const ev = rules.move(state, a, b, (t += 1000));
    if (state.phase !== "play") break;
    check(ev[0].completed ? state.current === before : state.current !== before, "turn passes unless a column was finished");
  }
  check(isSolved(state.cols, state.cap), "a turns game solves");
}

/* ---- replay links ---- */

const replay = { v: fmt.REPLAY_VERSION, kind: "solo", seed: seed.text, timed: true, players: ["Tester"], logs: [withUndos.log], at: null };
const link = fmt.longLink("https://sortr.uwuapps.org", replay);
const back = fmt.readLongLink(new URL(link).searchParams);
check(JSON.stringify(back.logs) === JSON.stringify(replay.logs), "a long link carries the log exactly");
check(back.seed === replay.seed && back.timed === true, "and the seed and timing");
console.log(`long link for ${withUndos.log.length} entries: ${link.length} characters`);
check(fmt.readLongLink(new URLSearchParams("watch=%%%&seed=x")).damaged === true, "a broken link says so");

const race = { ...replay, kind: "race", players: ["A", "B"], logs: [human.log, withUndos.log] };
check(fmt.cleanReplay(race) !== null, "a race replay with a log per player is clean");
check(fmt.cleanReplay({ ...race, logs: [human.log] }) === null, "a race replay missing a log is not");

if (failures) {
  console.error(`${failures} failed`);
  process.exit(1);
}
console.log("rules ok");
