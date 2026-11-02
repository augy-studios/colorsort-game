// The sorting puzzle itself: the columns, what a move does, a solver, and
// dealing a level from a random source. Pure and deterministic: no DOM, no
// clock, no Math.random. The page, replays, party hosts and the API all go
// through this file, so a level dealt anywhere is the same level.
//
// A column is an array of units, bottom first. A unit is its colour index
// (into js/palette.js), plus HIDDEN_FLAG while it is still hidden. Water
// never has hidden units; bolts on Medium and Hard do.
//
// Changing anything here that affects a deal or a move means games played on
// the old build stop verifying, and old seeds deal different levels. See
// the README.

export const HIDDEN_FLAG = 16;

export const colourOfUnit = (u) => u & 15;
export const isHiddenUnit = (u) => u >= HIDDEN_FLAG;

const top = (col) => col[col.length - 1];

// How many units would come off the top of `col` together: the revealed
// units of the top unit's colour, in a row. Hidden units never come along.
export function runLength(col) {
  if (!col.length) return 0;
  const t = top(col);
  if (isHiddenUnit(t)) return 0;
  let n = 1;
  while (n < col.length && col[col.length - 1 - n] === t) n++;
  return n;
}

export function isComplete(col, cap) {
  if (col.length !== cap) return false;
  const c = colourOfUnit(col[0]);
  return col.every((u) => colourOfUnit(u) === c);
}

export const isSolved = (cols, cap) => cols.every((col) => col.length === 0 || isComplete(col, cap));

// How many units a move from `a` to `b` would carry, or 0 if it cannot be
// made: something to move, room for it, and an empty column or the same
// colour on top.
export function moveCount(cols, cap, a, b) {
  if (a === b || !cols[a] || !cols[b]) return 0;
  const from = cols[a];
  const to = cols[b];
  const run = runLength(from);
  if (!run || to.length >= cap) return 0;
  // A finished column is done: it cannot be broken up again.
  if (isComplete(from, cap)) return 0;
  if (to.length && top(to) !== top(from)) return 0;
  return Math.min(run, cap - to.length);
}

// Makes a move in place. Returns what changed, so it can be undone and
// drawn: { n, revealed, completed }, or null if the move cannot be made.
// `revealed` is true when a hidden unit came to the top of `a` and showed
// its colour; `completed` when `b` is now a finished column.
export function applyMove(cols, cap, a, b) {
  const n = moveCount(cols, cap, a, b);
  if (!n) return null;
  const moving = cols[a].splice(cols[a].length - n, n);
  cols[b].push(...moving);
  let revealed = false;
  const from = cols[a];
  if (from.length && isHiddenUnit(top(from))) {
    from[from.length - 1] = colourOfUnit(top(from));
    revealed = true;
  }
  const completed = isComplete(cols[b], cap);
  // A finished column shows every nut in it.
  if (completed) for (let i = 0; i < cols[b].length; i++) cols[b][i] = colourOfUnit(cols[b][i]);
  return { n, revealed, completed };
}

// Takes a move back: `n` units from the top of `b` onto `a`. Anything that
// was uncovered stays uncovered, so undo is not a way to hide a colour again.
export function undoMove(cols, a, b, n) {
  const moving = cols[b].splice(cols[b].length - n, n);
  cols[a].push(...moving);
}

export const cloneCols = (cols) => cols.map((c) => c.slice());

/* ---- the solver ----
   Depth first, with the positions already seen kept so it never goes round
   in circles, and moves tried best first: finishing a column, then moving a
   whole run onto its colour, then pouring part of one, then using an empty
   column. Not the shortest answer, a quick one. Columns are interchangeable,
   so a position is remembered by its sorted columns. Stops after `maxNodes`
   positions and returns null, which for a dealt level means deal again. */

function keyOf(cols) {
  const parts = cols.map((c) => String.fromCharCode(...c.map((u) => u + 65)));
  parts.sort();
  return parts.join("|");
}

function candidateMoves(cols, cap) {
  const moves = [];
  let firstEmpty = -1;
  for (let i = 0; i < cols.length; i++) if (!cols[i].length) {
    firstEmpty = i;
    break;
  }
  for (let a = 0; a < cols.length; a++) {
    const from = cols[a];
    const run = runLength(from);
    if (!run) continue;
    const uniform = run === from.length;
    if (uniform && from.length === cap) continue; // a finished column stays put
    for (let b = 0; b < cols.length; b++) {
      if (a === b) continue;
      const to = cols[b];
      if (!to.length) {
        // Into one empty column only: the others are the same move. A column
        // that is all one colour gains nothing by moving.
        if (b !== firstEmpty || uniform) continue;
        moves.push([a, b, 3, run]);
        continue;
      }
      const n = moveCount(cols, cap, a, b);
      if (!n) continue;
      const toUniform = runLength(to) === to.length;
      let rank;
      if (toUniform && to.length + n === cap && n === run) rank = 0;
      else if (n === run) rank = toUniform ? 1 : 2;
      else rank = toUniform ? 2 : 4;
      // A run that already sits alone on its colour gains nothing by moving
      // onto a column that is not all that colour.
      if (uniform && !toUniform) continue;
      moves.push([a, b, rank, n]);
    }
  }
  moves.sort((x, y) => x[2] - y[2] || y[3] - x[3] || x[0] - y[0] || x[1] - y[1]);
  return moves;
}

export function solve(start, cap, { maxNodes = 150000 } = {}) {
  const cols = cloneCols(start);
  if (isSolved(cols, cap)) return [];
  const seen = new Set([keyOf(cols)]);
  // Each frame: the moves to try from here, where we are in them, and the
  // two columns as they were before the move that led here, to put back on
  // the way out (which also hides again anything that move uncovered).
  const stack = [{ moves: candidateMoves(cols, cap), i: 0, back: null }];
  const path = [];
  let nodes = 0;
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.i >= frame.moves.length) {
      stack.pop();
      if (frame.back) {
        const [a, b, oldA, oldB] = frame.back;
        cols[a] = oldA;
        cols[b] = oldB;
        path.pop();
      }
      continue;
    }
    const [a, b] = frame.moves[frame.i++];
    const oldA = cols[a].slice();
    const oldB = cols[b].slice();
    if (!applyMove(cols, cap, a, b)) continue;
    const key = keyOf(cols);
    if (seen.has(key) || ++nodes > maxNodes) {
      cols[a] = oldA;
      cols[b] = oldB;
      if (nodes > maxNodes) return null;
      continue;
    }
    seen.add(key);
    path.push([a, b]);
    if (isSolved(cols, cap)) return path.slice();
    stack.push({ moves: candidateMoves(cols, cap), i: 0, back: [a, b, oldA, oldB] });
  }
  return null;
}

// Whether any move at all can be made. With none, the player has to undo.
export function hasMoves(cols, cap) {
  for (let a = 0; a < cols.length; a++) for (let b = 0; b < cols.length; b++) if (moveCount(cols, cap, a, b)) return true;
  return false;
}

/* ---- dealing ---- */

function shuffle(items, next) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

// A level from `next` (unsigned 32 bit integers): `colours` colours picked
// from a palette of `paletteSize`, `cap` of each, dealt into `colours` full
// columns plus `empties` empty ones. `hiddenColumns` of the full columns
// show only their top unit. Dealt again until no column starts finished
// and the solver can finish it, so every level can be solved.
export function deal(next, { colours, cap, empties, hiddenColumns, paletteSize }) {
  const palette = shuffle(Array.from({ length: paletteSize }, (_, i) => i), next).slice(0, colours);
  for (let attempt = 0; attempt < 60; attempt++) {
    // Units are the level's own colour numbers, 0 up; `palette` says which
    // palette colour each one is.
    const units = shuffle(palette.flatMap((_, c) => new Array(cap).fill(c)), next);
    const cols = [];
    for (let i = 0; i < colours; i++) cols.push(units.slice(i * cap, (i + 1) * cap));
    if (cols.some((c) => isComplete(c, cap))) continue;
    // No column that starts with all but one unit the same colour on top:
    // it would be a free finish.
    if (cols.some((c) => runLength(c) >= cap - 1)) continue;
    const hidden = shuffle(Array.from({ length: colours }, (_, i) => i), next).slice(0, hiddenColumns);
    for (const i of hidden) for (let k = 0; k < cap - 1; k++) cols[i][k] += HIDDEN_FLAG;
    for (let i = 0; i < empties; i++) cols.push([]);
    if (solve(cols, cap, { maxNodes: 60000 })) return { cols, palette, attempt };
  }
  // Never seen in testing; scripts/test-rules.mjs deals thousands of levels.
  throw new Error("could not deal a solvable level");
}
