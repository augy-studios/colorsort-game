// uwuSort's rules. Shared by the game (js/game.js), party games
// (js/party.js), replays (js/replay.js) and the API, so a score the server
// checks was made under the same rules the page plays by. Pure: no DOM, no
// fetch, no storage, and integers wherever a score is worked out, so the
// page and the server agree to the point.
//
// A game is its setup (seed, whether it is timed, players) and a log.
// Everything else, the columns, the turns and every score, is worked out
// from those two by replaying the log through applyEntry().
//
// Changing anything here that affects a deal or a score means games played
// on the old build stop verifying. See the README.

import { applyMove, cloneCols, deal, hasMoves, isComplete, isSolved, moveCount, undoMove } from "./puzzle.js";
import { COLOURS } from "./palette.js";

/* ---- modes, difficulties and levels ---- */

export const MODES = {
  water: { id: "water", letter: "W", label: "Water", column: "tube", columns: "tubes", unit: "layer", units: "layers" },
  bolts: { id: "bolts", letter: "B", label: "Bolts", column: "bolt", columns: "bolts", unit: "nut", units: "nuts" },
};

export const DIFFICULTIES = {
  easy: { id: "easy", letter: "E", label: "Easy", percent: 100 },
  medium: { id: "medium", letter: "M", label: "Medium", percent: 175 },
  hard: { id: "hard", letter: "H", label: "Hard", percent: 275 },
};

export const MAX_LEVEL = 99999;
export const EMPTIES = 2;

// Each difficulty starts at `from` colours and adds one every `every`
// levels up to `to`. `cap` is how many of a colour there are, and so how
// tall a column is. Bolts hide every nut but the top one on
// `hiddenPerTen` in ten of their bolts, rounded down.
const SHAPES = {
  water: {
    easy: { cap: 4, from: 3, to: 5, every: 3, hiddenPerTen: 0 },
    medium: { cap: 4, from: 6, to: 8, every: 4, hiddenPerTen: 0 },
    hard: { cap: 4, from: 9, to: 12, every: 5, hiddenPerTen: 0 },
  },
  bolts: {
    easy: { cap: 3, from: 3, to: 5, every: 3, hiddenPerTen: 0 },
    medium: { cap: 4, from: 5, to: 7, every: 4, hiddenPerTen: 4 },
    hard: { cap: 5, from: 7, to: 10, every: 5, hiddenPerTen: 5 },
  },
};

export function levelShape(mode, difficulty, level) {
  const s = SHAPES[mode][difficulty];
  const colours = Math.min(s.to, s.from + Math.floor((Math.max(1, level) - 1) / s.every));
  return { cap: s.cap, colours, empties: EMPTIES, hidden: Math.floor((colours * s.hiddenPerTen) / 10) };
}

export const cleanMode = (v) => (MODES[v] ? v : "water");
export const cleanDifficulty = (v) => (DIFFICULTIES[v] ? v : "easy");
export const cleanLevel = (v) => {
  const n = Math.floor(Number(v));
  return Number.isInteger(n) && n >= 1 && n <= MAX_LEVEL ? n : 1;
};

/* ---- randomness ---- */

// cyrb53's mixing, one 32 bit half of it: a string to a well mixed number.
export function hashString(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 ^ h2) >>> 0;
}

// mulberry32, seeded from a string. Returns unsigned 32 bit integers.
export function randomSource(key) {
  let a = hashString(key);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

// The level a seed deals: its columns, and which palette colours are in it.
const dealt = new Map();
export function dealSeed(seed) {
  if (!dealt.has(seed.text)) {
    const shape = levelShape(seed.mode, seed.difficulty, seed.level);
    const level = deal(randomSource(`deal|${seed.text}`), {
      colours: shape.colours,
      cap: shape.cap,
      empties: shape.empties,
      hiddenColumns: shape.hidden,
      paletteSize: COLOURS.length,
    });
    if (dealt.size > 50) dealt.clear();
    dealt.set(seed.text, { shape, cols: level.cols, palette: level.palette });
  }
  const d = dealt.get(seed.text);
  return { shape: d.shape, cols: cloneCols(d.cols), palette: d.palette.slice() };
}

// The fewest moves a level could take: every move joins at most one run of
// a colour onto another, and a finished level has one run per colour.
export function parOf(cols) {
  let runs = 0;
  for (const col of cols) for (let i = 0; i < col.length; i++) if (i === 0 || (col[i] & 15) !== (col[i - 1] & 15)) runs++;
  const colours = new Set(cols.flat().map((u) => u & 15)).size;
  return Math.max(1, runs - colours);
}

/* ---- scoring ----
   The score grows as the level goes on. Every move that puts a run onto its
   own colour earns points for each unit moved, and finishing a column
   earns more. Quick moves earn up to half as much again. Undo takes a
   move's points back and costs a little; a hint and the extra column cost
   more. Solving adds a bonus for few moves and, on a timed level, one for
   time to spare. Then it is all scaled by the difficulty and the level.

   A level started online is timed: the server saw it start, so its clock
   can be held to the server's. A level played offline, or on a seed the
   server did not deal, earns no speed or time bonus. */

export const MERGE_POINTS = 10; // per unit moved onto its own colour
export const COMPLETE_POINTS = 100;
export const QUICK_MS = 1000; // a move this quick earns the full speed bonus
export const SLOW_MS = 8000; // and one this slow, none
export const SPEED_MAX = 50; // percent
export const UNDO_POINTS = 20;
export const HINT_POINTS = 60;
export const EXTRA_POINTS = 150;
export const EFFICIENCY_POINTS = 40; // times colours, at par
export const TIME_BONUS_MAX = 50; // percent, with all the time left
export const WINDOW_PER_UNIT_MS = 4000; // the time bonus's clock
export const LEVEL_PERCENT_MAX = 100; // +1% a level, up to this much more

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function speedPercent(gapMs) {
  const used = clamp(gapMs, QUICK_MS, SLOW_MS);
  return 100 + Math.floor((SPEED_MAX * (SLOW_MS - used)) / (SLOW_MS - QUICK_MS));
}

export function percents(setup) {
  return {
    difficulty: DIFFICULTIES[setup.seed.difficulty].percent,
    level: 100 + Math.min(LEVEL_PERCENT_MAX, setup.seed.level - 1),
  };
}

// Raw points to score: each percentage in turn, rounding down at each step.
export function scale(raw, setup) {
  const p = percents(setup);
  return Math.floor((Math.floor((raw * p.difficulty) / 100) * p.level) / 100);
}

/* ---- playing ---- */

// The log, one entry per thing a player did, `t` in ms of game time:
//   [t, MOVE, from, to]   a move
//   [t, UNDO]             take the last move back
//   [t, HINT]             asked for a hint
//   [t, EXTRA]            opened the extra column
//   [t, RESTART]          took every move back
//   [t, LEAVE, p]         party: player p dropped out
//   [t, JOIN, p]          party: player p came back
export const MOVE = 0;
export const UNDO = 1;
export const HINT = 2;
export const EXTRA = 3;
export const RESTART = 4;
export const LEAVE = 5;
export const JOIN = 6;

// setup: { seed, timed, players: [names], turns }. One player is a solo game
// (or one racer's board); `turns` is a party game where players take turns
// on one board.
export function createGame(setup) {
  const { shape, cols, palette } = dealSeed(setup.seed);
  const names = setup.players?.length ? setup.players : ["Player"];
  return {
    setup,
    cap: shape.cap,
    colours: shape.colours,
    palette, // palette index per colour in play
    cols,
    columns: cols.length, // how many columns there are now; +1 with the extra
    extra: false,
    par: parOf(cols),
    history: [], // { a, b, n, points, player }
    players: names.map((name) => ({ name, raw: 0, moves: 0, undos: 0, hints: 0, completed: 0, active: true })),
    current: 0,
    lastT: 0,
    phase: "play",
    reason: null,
    endedAt: null,
  };
}

function passTurn(state) {
  const n = state.players.length;
  for (let k = 1; k <= n; k++) {
    const i = (state.current + k) % n;
    if (state.players[i].active) {
      state.current = i;
      return;
    }
  }
}

const penalise = (player, points) => (player.raw = Math.max(0, player.raw - points));

function takeBack(state) {
  const h = state.history.pop();
  undoMove(state.cols, h.a, h.b, h.n);
  const earner = state.players[h.player];
  earner.raw = Math.max(0, earner.raw - h.points);
  if (h.completed) earner.completed -= 1;
  return h;
}

// One move by the player whose turn it is, at `t`. Returns what happened as
// events, or null if the move cannot be made now.
export function move(state, a, b, t) {
  if (state.phase !== "play" || t < state.lastT) return null;
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a >= state.columns || b >= state.columns) return null;
  const merging = state.cols[b].length > 0;
  if (!moveCount(state.cols, state.cap, a, b)) return null;
  const gap = t - state.lastT;
  const done = applyMove(state.cols, state.cap, a, b);
  const who = state.current;
  const player = state.players[who];
  let points = (merging ? MERGE_POINTS * done.n : 0) + (done.completed ? COMPLETE_POINTS : 0);
  if (state.setup.timed && points) points = Math.floor((points * speedPercent(gap)) / 100);
  player.raw += points;
  player.moves += 1;
  if (done.completed) player.completed += 1;
  state.history.push({ a, b, n: done.n, points, player: who, completed: done.completed });
  state.lastT = t;
  const events = [{ type: "move", at: t, player: who, a, b, n: done.n, points, revealed: done.revealed, completed: done.completed }];
  if (isSolved(state.cols, state.cap)) {
    state.phase = "over";
    state.reason = "done";
    state.endedAt = t;
    events.push({ type: "over", reason: "done", at: t });
  } else if (state.players.length > 1 && state.setup.turns && !done.completed) {
    // Finishing a column keeps the turn.
    passTurn(state);
  }
  return events;
}

export function undo(state, t) {
  if (state.phase !== "play" || t < state.lastT || !state.history.length) return null;
  const who = state.current;
  const h = takeBack(state);
  const player = state.players[who];
  player.undos += 1;
  penalise(player, UNDO_POINTS);
  state.lastT = t;
  return [{ type: "undo", at: t, player: who, a: h.a, b: h.b, n: h.n, points: h.points }];
}

export function restart(state, t) {
  if (state.phase !== "play" || t < state.lastT || !state.history.length) return null;
  const who = state.current;
  const undone = [];
  while (state.history.length) {
    const h = takeBack(state);
    undone.push({ a: h.a, b: h.b, n: h.n });
  }
  const player = state.players[who];
  player.undos += 1;
  penalise(player, UNDO_POINTS);
  state.lastT = t;
  return [{ type: "restart", at: t, player: who, undone }];
}

export function hint(state, t) {
  if (state.phase !== "play" || t < state.lastT) return null;
  const who = state.current;
  const player = state.players[who];
  player.hints += 1;
  penalise(player, HINT_POINTS);
  state.lastT = t;
  return [{ type: "hint", at: t, player: who }];
}

// The extra column, once a level.
export function openExtra(state, t) {
  if (state.phase !== "play" || t < state.lastT || state.extra) return null;
  const who = state.current;
  state.extra = true;
  state.cols.push([]);
  state.columns = state.cols.length;
  penalise(state.players[who], EXTRA_POINTS);
  state.lastT = t;
  return [{ type: "extra", at: t, player: who }];
}

// A party player dropping out at `t`, or coming back. Leaving on their own
// turn hands it on; their score stays. Not part of game time order checks:
// these come from the host's clock, not a player's hand.
export function leave(state, p, t) {
  const player = state.players[p];
  if (state.phase !== "play" || !player || !player.active) return [];
  player.active = false;
  if (state.current === p) passTurn(state);
  if (state.players.every((x) => !x.active)) {
    state.phase = "over";
    state.reason = "abandoned";
    state.endedAt = t;
    return [{ type: "leave", at: t, player: p }, { type: "over", reason: "abandoned", at: t }];
  }
  return [{ type: "leave", at: t, player: p }];
}

export function join(state, p, t) {
  const player = state.players[p];
  if (state.phase !== "play" || !player || player.active) return [];
  player.active = true;
  return [{ type: "join", at: t, player: p }];
}

export function applyEntry(state, entry) {
  if (!Array.isArray(entry)) return null;
  const [t, code, x, y] = entry;
  if (!Number.isInteger(t) || t < 0) return null;
  switch (code) {
    case MOVE:
      return move(state, x, y, t);
    case UNDO:
      return undo(state, t);
    case HINT:
      return hint(state, t);
    case EXTRA:
      return openExtra(state, t);
    case RESTART:
      return restart(state, t);
    case LEAVE:
      return leave(state, x, t);
    case JOIN:
      return join(state, x, t);
    default:
      return null;
  }
}

// Whether the player is stuck: no move can be made, so only undo helps.
export const isStuck = (state) => state.phase === "play" && !hasMoves(state.cols.slice(0, state.columns), state.cap);

export { isComplete };

/* ---- results ---- */

// The score so far, as shown while playing.
export const liveScore = (state, p = 0) => scale(state.players[p].raw, state.setup);

export function finalScores(state) {
  const solo = state.players.length === 1;
  const done = state.reason === "done";
  return state.players.map((player) => {
    let efficiency = 0;
    let timeBonus = 0;
    if (solo && done) {
      efficiency = Math.floor((EFFICIENCY_POINTS * state.colours * state.par) / Math.max(state.par, player.moves));
      if (state.setup.timed) {
        const window = state.colours * state.cap * WINDOW_PER_UNIT_MS;
        timeBonus = Math.floor((TIME_BONUS_MAX * Math.max(0, window - state.endedAt)) / window);
      }
    }
    const base = player.raw + efficiency;
    const timed = Math.floor((base * (100 + timeBonus)) / 100);
    return {
      name: player.name,
      points: player.raw,
      efficiency,
      timeBonus,
      moves: player.moves,
      undos: player.undos,
      hints: player.hints,
      completed: player.completed,
      extra: state.extra,
      ...percents(state.setup),
      score: scale(timed, state.setup),
    };
  });
}

/* ---- checking a finished level (server side) ---- */

// A started level can be recorded for this long after it started.
export const RUN_TTL_MS = 6 * 60 * 60 * 1000;
// Vercel's clock and Supabase's, and a slow request, all in one allowance.
export const CLOCK_SLACK_MS = 15000;
export const MAX_LOG = 5000;
// Two moves closer together than this is quicker than a hand can pick a
// column and then another. A few in a level are a double tap; many are a
// script. Autoplay (js/autoplay.js) moves quicker than this on purpose, so
// a level it played is refused here even if the page's own lock is undone.
export const MIN_MOVE_GAP_MS = 250;
export const QUICK_MOVES_ALLOWED = 4;
export const QUICK_MOVES_SHARE = 0.1;
// And across the whole level, no quicker than this per move on average.
export const MIN_AVERAGE_MOVE_MS = 400;

// Whether a solo level's log is real play that solved it. Returns
// { reason } when it is not, or { reason: null, state, result } with the
// score the server works out itself. `elapsedMs` is the time the server
// saw pass since the level started, or null for a level it did not start.
//
// Bounds cheating rather than preventing it: the level is dealt in the
// browser from the seed, so a script can solve it. What it cannot do is
// play quicker than a hand, or longer than the server has known about it.
export function checkGame(setup, log, durationMs, elapsedMs) {
  if (!Array.isArray(log) || log.length === 0 || log.length > MAX_LOG) return { reason: "bad_log" };
  if (!Number.isInteger(durationMs) || durationMs < 0) return { reason: "bad_duration" };
  const state = createGame({ ...setup, players: setup.players?.slice(0, 1) ?? ["Player"], turns: false });
  let prev = 0;
  let quick = 0;
  let moves = 0;
  for (const entry of log) {
    if (!Array.isArray(entry) || entry.length > 4) return { reason: "bad_log" };
    const [t, code] = entry;
    if (code === LEAVE || code === JOIN) return { reason: "bad_log" };
    if (!Number.isInteger(t) || t < prev) return { reason: "bad_log" };
    if (code === MOVE) {
      moves += 1;
      if (t - prev < MIN_MOVE_GAP_MS) quick += 1;
    }
    prev = t;
    if (!applyEntry(state, entry)) return { reason: "bad_move" };
    if (state.phase !== "play" && entry !== log[log.length - 1]) return { reason: "bad_log" };
  }
  if (state.phase !== "over" || state.reason !== "done") return { reason: "not_finished" };
  if (state.endedAt !== durationMs) return { reason: "bad_duration" };
  if (elapsedMs !== null && durationMs > elapsedMs + CLOCK_SLACK_MS) return { reason: "too_long" };
  if (quick > QUICK_MOVES_ALLOWED + QUICK_MOVES_SHARE * moves) return { reason: "too_fast" };
  if (durationMs < moves * MIN_AVERAGE_MOVE_MS) return { reason: "too_fast" };
  return { reason: null, state, result: finalScores(state)[0] };
}
