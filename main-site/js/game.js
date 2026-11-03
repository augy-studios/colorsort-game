// The solo game: choosing a level, playing it, and its result.
//
// Each mode has three difficulties, and each difficulty its own endless run
// of levels, kept in this browser. Play asks /api/run/start for the next
// level, which deals its seed and starts the server's clock, so the level
// is timed and earns speed bonuses. Offline, the level is dealt here and
// plays the same, without speed bonuses.
//
// A finished level goes to js/queue.js, which records it on the server now
// or once the connection is back, under the player's name if they gave one.
// A pasted seed or a level autoplay touched is never recorded and does not
// move the player on to the next level.
//
// The clock is the game's own: it stops while paused or while the tab is
// out of sight, and everything the player does is logged in its
// milliseconds. js/rules.js turns that log into the columns and the score,
// the same way the server will.

import { api } from "./api.js";
import { askName, getSettings, saveSettings } from "./settings.js";
import { celebrate } from "./confetti.js";
import {
  DIFFICULTIES,
  EXTRA,
  EXTRA_POINTS,
  HINT,
  HINT_POINTS,
  MODES,
  MOVE,
  RESTART,
  UNDO,
  applyEntry,
  createGame,
  finalScores,
  isStuck,
  levelShape,
  liveScore,
  scale,
} from "./rules.js";
import { moveCount, runLength, solve } from "./puzzle.js";
import { newSeed, parseSeed } from "./seed.js";
import { enqueue, isQueued, isStalled, nameQueued, recordedResult, remember, waiting } from "./queue.js";
import { REPLAY_VERSION } from "./replay-format.js";
import { replayLinkFor, shareReplay } from "./replay.js";
import { copyText, currentView, escapeHtml, formatTime, reducedMotion, setIcon, showView, store } from "./ui.js";

const SAVE_KEY = "uwusort.game";
const PROGRESS_KEY = "uwusort.progress";
// Autoplay: quicker than a hand on purpose. The server refuses a level
// played at this pace (MIN_MOVE_GAP_MS in js/rules.js), whatever the page
// says about it.
const AUTOPLAY_MS = 170;
const ARM_MS = 3000;

const $ = (id) => document.getElementById(id);

let board = null;
let replayer = null;

let g = null; // the level in play
let last = null; // the level just finished, for its result, replay and submit
let running = false;
let clockFrom = 0;
let ticker = null;
let auto = null; // autoplay, while it runs: { timer, plan }
const armed = {}; // two-tap buttons: name -> time first tapped

const now = () => (running ? g.elapsed + (performance.now() - clockFrom) : g.elapsed);
const gameTime = () => Math.max(g.state.lastT, Math.round(now()));

/* ---- progress: the next level per mode and difficulty ---- */

function progress() {
  try {
    return JSON.parse(store.get(PROGRESS_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

export function nextLevel(mode, difficulty) {
  const n = Number(progress()?.[mode]?.[difficulty]);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

function advance(mode, difficulty, level) {
  const p = progress();
  p[mode] ??= {};
  p[mode][difficulty] = Math.max(nextLevel(mode, difficulty), level + 1);
  store.set(PROGRESS_KEY, JSON.stringify(p));
}

/* ---- the setup card ---- */

function renderSetup() {
  const s = getSettings();
  const press = (selector, attr, value) =>
    document.querySelectorAll(selector).forEach((el) => {
      const on = el.dataset[attr] === value;
      el.classList.toggle("active", on);
      el.setAttribute("aria-checked", String(on));
    });
  press("#modePick [data-mode-pick]", "modePick", s.mode);
  press("#difficultyPick [data-difficulty]", "difficulty", s.difficulty);
  const level = nextLevel(s.mode, s.difficulty);
  const shape = levelShape(s.mode, s.difficulty, level);
  const m = MODES[s.mode];
  $("playLabel").textContent = `Play level ${level}`;
  $("setupSummary").textContent =
    `${m.label}, ${DIFFICULTIES[s.difficulty].label}: ${shape.colours} colours, ${shape.cap} ${m.units} each, ` +
    `${shape.colours + shape.empties} ${m.columns}` +
    (shape.hidden ? `, ${shape.hidden} with hidden ${m.units}.` : ".");
  $("rulesText").textContent =
    s.mode === "bolts"
      ? "Move nuts between bolts until every bolt holds one colour. A nut only goes onto an empty bolt or a nut of its own colour."
      : "Pour between tubes until every tube holds one colour. Water only goes into an empty tube or onto its own colour.";
  $("resumeBtn").hidden = !store.get(SAVE_KEY);
  renderQueueNote();
}

function renderQueueNote() {
  const n = waiting();
  $("queueNote").textContent = n ? `${n} finished ${n === 1 ? "level is" : "levels are"} waiting to be sent. They go once you are back online.` : "";
}

/* ---- starting ---- */

async function start({ seedText = null } = {}) {
  const s = getSettings();
  if (!seedText) await askName();
  $("startBtn").disabled = true;
  $("startNote").textContent = "";
  let seed = null;
  let run = null;
  let pasted = false;

  if (seedText) {
    seed = parseSeed(seedText, { mode: s.mode, difficulty: s.difficulty, level: nextLevel(s.mode, s.difficulty) });
    pasted = true;
  } else {
    const level = nextLevel(s.mode, s.difficulty);
    $("startNote").textContent = "Dealing.";
    try {
      const r = await api.startRun({ mode: s.mode, difficulty: s.difficulty, level });
      seed = parseSeed(r.seed);
      if (seed) run = { id: r.run_id };
    } catch {
      // Offline or refused: dealt here, untimed.
    }
    seed ??= newSeed(s.mode, s.difficulty, level);
  }
  $("startBtn").disabled = false;
  $("startNote").textContent = "";
  begin({ seed: seed.text, run, pasted, assisted: false, at: new Date().toISOString(), log: [], elapsed: 0, playId: crypto.randomUUID() });
}

// Sets a level up from its saved form, new or resumed.
function begin(saved, { paused = false } = {}) {
  stopAuto();
  const seed = parseSeed(saved.seed);
  const setup = { seed, timed: Boolean(saved.run), players: [getSettings().name ?? "Player"] };
  const state = createGame(setup);
  for (const entry of saved.log) applyEntry(state, entry);
  g = {
    state,
    log: [...saved.log],
    run: saved.run ?? null,
    pasted: Boolean(saved.pasted),
    assisted: Boolean(saved.assisted),
    at: saved.at,
    elapsed: saved.elapsed,
    playId: saved.playId,
    selected: null,
    hint: null,
  };
  last = null;

  showView("play");
  $("playStage").append(board.host);
  board.onPick = onPick;
  board.onDrop = onDrop;
  board.onDragStart = onDragStart;
  board.setup(view());
  shownScore = null; // a new level shows its score as it is
  const m = MODES[seed.mode];
  $("hudLevel").textContent = `${m.label} · ${DIFFICULTIES[seed.difficulty].label} · Level ${seed.level}`;
  $("seedChip").textContent = seed.text;
  $("extraLabel").textContent = `Extra ${m.column}`;
  syncScoredChip();
  say(paused ? "" : seed.mode === "bolts" ? "Tap a bolt, then another, or drag between them." : "Tap a tube, then another, or drag between them.");
  save();
  draw();
  if (paused) pause();
  else resume();
  if (!paused) board.focus();
}

function syncScoredChip() {
  const chip = $("scoredChip");
  chip.textContent = g.assisted
    ? "Autoplay, not scored"
    : g.pasted
      ? "Pasted seed, not scored"
      : g.run
        ? "Scored"
        : "Offline, no speed bonus";
  chip.classList.toggle("muted", g.assisted || g.pasted);
}

/* ---- drawing ---- */

function view(extra = {}) {
  const { state } = g;
  const s = getSettings();
  const selected = g.selected;
  return {
    mode: state.setup.seed.mode,
    cap: state.cap,
    palette: state.palette,
    cols: state.cols,
    selected,
    liftCount: selected === null ? 0 : runLength(state.cols[selected]),
    hint: g.hint,
    target: null,
    interactive: running && state.phase === "play" && !auto,
    symbols: s.symbols,
    ...extra,
  };
}

function draw(change = null) {
  if (!g) return;
  const { state } = g;
  board.render(view(), change);
  const p = state.players[0];
  setScore(liveScore(state));
  $("hudMoves").textContent = String(p.moves);
  $("hudDone").textContent = `${p.completed}/${state.colours}`;
  $("undoBtn").disabled = !state.history.length || !running;
  $("restartBtn").disabled = !state.history.length || !running;
  $("extraBtn").disabled = state.extra || !running;
  $("hintBtn").disabled = !running;
  drawClock();
}

function drawClock() {
  $("hudTime").textContent = formatTime(now());
}

function say(text) {
  $("caption").textContent = text;
}

/* ---- the score on screen ----
   Points earned rise from under the score box into the number, and the
   number then counts up to its new value rather than jumping. */

const POP_MS = 620; // how long the points take to rise into the score
let shownScore = null; // the number on screen right now
let scoreTween = null; // { to, raf } while it counts
let scoreHoldUntil = 0; // counting waits for a rising pop to arrive

function setScore(target) {
  const el = $("hudScore");
  if (shownScore === null || reducedMotion()) {
    if (scoreTween) cancelAnimationFrame(scoreTween.raf);
    scoreTween = null;
    shownScore = target;
    el.textContent = String(target);
    return;
  }
  if (scoreTween ? scoreTween.to === target : shownScore === target) return;
  if (scoreTween) cancelAnimationFrame(scoreTween.raf);
  const from = shownScore;
  const start = Math.max(performance.now(), scoreHoldUntil);
  const dur = Math.min(900, 380 + Math.abs(target - from) * 3);
  const step = (now) => {
    const p = Math.max(0, Math.min(1, (now - start) / dur));
    shownScore = Math.round(from + (target - from) * (1 - (1 - p) ** 3));
    el.textContent = String(shownScore);
    if (p < 1) scoreTween.raf = requestAnimationFrame(step);
    else {
      scoreTween = null;
      shownScore = target;
      el.textContent = String(target);
    }
  };
  scoreTween = { to: target, raf: requestAnimationFrame(step) };
}

function popScore(points) {
  if (!points) return;
  const box = $("hudScoreBox");
  const pop = document.createElement("span");
  pop.className = "score-pop";
  pop.textContent = `+${scale(points, g.state.setup)}`;
  pop.setAttribute("aria-hidden", "true");
  box.append(pop);
  // From just under the box to the middle of the number, measured, so it
  // lands on the score whatever size the box is.
  const value = $("hudScore").getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  const rise = value.top + value.height / 2 - (popRect.top + popRect.height / 2);
  pop.style.setProperty("--rise", `${Math.round(rise)}px`);
  pop.style.animationDuration = `${POP_MS}ms`;
  if (!reducedMotion()) scoreHoldUntil = performance.now() + POP_MS * 0.8;
  setTimeout(() => {
    box.classList.remove("score-bump");
    void box.offsetWidth;
    box.classList.add("score-bump");
  }, POP_MS * 0.8);
  setTimeout(() => pop.remove(), POP_MS + 50);
}

/* ---- playing ---- */

const canPlay = () => g && running && g.state.phase === "play";
const liftable = (i) => runLength(g.state.cols[i] ?? []) > 0 && moveCountAny(i);

// Whether anything can be done with column i's top: somewhere it can go.
function moveCountAny(i) {
  const { cols, cap } = g.state;
  for (let b = 0; b < cols.length; b++) if (moveCount(cols, cap, i, b)) return true;
  return false;
}

function onPick(i) {
  if (!canPlay() || auto) return;
  disarmAll();
  if (i === null) {
    if (g.selected !== null) {
      g.selected = null;
      draw();
    }
    return;
  }
  if (g.selected === null) {
    if (runLength(g.state.cols[i]) > 0 && liftable(i)) {
      g.selected = i;
      draw();
    } else {
      board.pulse([i], "bad");
      say(g.state.cols[i].length ? "Nothing on that one can move anywhere yet." : "That one is empty. Pick one with something to move.");
    }
    return;
  }
  if (g.selected === i) {
    g.selected = null;
    draw();
    return;
  }
  const from = g.selected;
  if (doMove(from, i)) return;
  // Not a move: pick up the new column instead, if it can go anywhere.
  if (runLength(g.state.cols[i]) > 0 && liftable(i)) {
    g.selected = i;
    draw();
  } else {
    board.pulse([i], "bad");
    g.selected = null;
    draw();
    say(refusal(from, i));
  }
}

function onDragStart(a) {
  if (!canPlay() || auto) return;
  if (runLength(g.state.cols[a]) > 0 && liftable(a)) {
    g.selected = a;
    draw();
  }
}

function onDrop(a, b) {
  if (!canPlay() || auto) return;
  if (b === null) {
    g.selected = null;
    draw();
    return;
  }
  if (!doMove(a, b)) {
    board.pulse([b], "bad");
    say(refusal(a, b));
    g.selected = null;
    draw();
  }
}

function refusal(a, b) {
  const m = MODES[g.state.setup.seed.mode];
  const { cols, cap } = g.state;
  if (!cols[a].length) return `That ${m.column} is empty.`;
  if (cols[b].length >= cap) return `That ${m.column} is full.`;
  return m.id === "bolts" ? "A nut only goes onto its own colour or an empty bolt." : "Water only goes onto its own colour or into an empty tube.";
}

// One move, logged. False if it cannot be made.
function doMove(a, b, { fast = false } = {}) {
  const t = gameTime();
  const events = applyEntry(g.state, [t, MOVE, a, b]);
  if (!events) return false;
  g.log.push([t, MOVE, a, b]);
  g.selected = null;
  g.hint = null;
  const e = events[0];
  // The points start rising first, so the score counts up as they land.
  popScore(e.points);
  draw({ a, b, n: e.n, fast });
  const m = MODES[g.state.setup.seed.mode];
  if (e.completed) {
    board.pulse([b], "done");
    say(`${m.column.charAt(0).toUpperCase()}${m.column.slice(1)} finished.`);
  } else if (e.revealed) say(`A hidden ${m.unit} showed its colour.`);
  else say("");
  afterAction(events);
  return true;
}

function afterAction(events) {
  save();
  if (g.state.phase === "over") {
    finish();
    return;
  }
  if (!events.some((e) => e.type === "hint") && isStuck(g.state)) say("No moves left. Undo, or start the level again.");
}

function doUndo({ fast = false } = {}) {
  if (!canPlay()) return;
  const t = gameTime();
  const events = applyEntry(g.state, [t, UNDO]);
  if (!events) return;
  g.log.push([t, UNDO]);
  g.selected = null;
  g.hint = null;
  const e = events[0];
  draw({ a: e.b, b: e.a, n: e.n, fast });
  if (!auto) say("Move taken back.");
  afterAction(events);
}

function armOrGo(name, label, text, go) {
  if (!getSettings().confirm_costs && name !== "restart" && name !== "exit") return go();
  if (Date.now() - (armed[name] ?? 0) < ARM_MS) {
    disarm(name);
    return go();
  }
  disarmAll();
  armed[name] = Date.now();
  label.dataset.original ??= label.textContent;
  label.textContent = text;
  setTimeout(() => disarm(name), ARM_MS);
}

const LABELS = { hint: "hintLabel", extra: "extraLabel", restart: "restartLabel", exit: "exitLabel" };

function disarm(name) {
  delete armed[name];
  const label = $(LABELS[name]);
  if (label?.dataset.original) {
    label.textContent = label.dataset.original;
    delete label.dataset.original;
  }
}

function disarmAll() {
  for (const name of Object.keys(LABELS)) disarm(name);
}

function doRestart() {
  if (!canPlay() || !g.state.history.length) return;
  armOrGo("restart", $("restartLabel"), "Tap again to restart", () => {
    const t = gameTime();
    const events = applyEntry(g.state, [t, RESTART]);
    if (!events) return;
    g.log.push([t, RESTART]);
    g.selected = null;
    g.hint = null;
    draw();
    say("Back to the start. What you uncovered stays uncovered.");
    afterAction(events);
  });
}

function doHint() {
  if (!canPlay()) return;
  const cost = scale(HINT_POINTS, g.state.setup);
  armOrGo("hint", $("hintLabel"), `Tap again: -${cost}`, () => {
    const plan = solve(g.state.cols, g.state.cap, { maxNodes: 120000 });
    if (!plan || !plan.length) {
      say("No way forward from here. Undo a few moves.");
      return;
    }
    const t = gameTime();
    const events = applyEntry(g.state, [t, HINT]);
    g.log.push([t, HINT]);
    const [a, b] = plan[0];
    g.hint = { a, b };
    g.selected = null;
    draw();
    const m = MODES[g.state.setup.seed.mode];
    say(`Try ${m.column} ${a + 1} to ${m.column} ${b + 1}.`);
    afterAction(events);
  });
}

function doExtra() {
  if (!canPlay() || g.state.extra) return;
  const cost = scale(EXTRA_POINTS, g.state.setup);
  armOrGo("extra", $("extraLabel"), `Tap again: -${cost}`, () => {
    const t = gameTime();
    const events = applyEntry(g.state, [t, EXTRA]);
    if (!events) return;
    g.log.push([t, EXTRA]);
    draw();
    say(`An extra ${MODES[g.state.setup.seed.mode].column} is open.`);
    afterAction(events);
  });
}

function tick() {
  if (g && running) drawClock();
}

function resume() {
  if (!g || g.state.phase !== "play") return;
  if (!running) {
    running = true;
    clockFrom = performance.now();
  }
  $("playStage").classList.remove("paused");
  $("pauseOverlay").hidden = true;
  setIcon($("pauseBtn"), "pause");
  $("pauseBtn").setAttribute("aria-label", "Pause");
  clearInterval(ticker);
  ticker = setInterval(tick, 250);
  draw();
}

// Stops the clock and hides the columns, so a pause is not thinking time.
export function pause() {
  if (!g || g.state.phase !== "play") return;
  stopAuto();
  if (running) {
    g.elapsed = now();
    running = false;
  }
  clearInterval(ticker);
  g.selected = null;
  $("playStage").classList.add("paused");
  $("pauseOverlay").hidden = false;
  setIcon($("pauseBtn"), "play");
  $("pauseBtn").setAttribute("aria-label", "Resume");
  save();
  draw();
}

export const isPlaying = () => Boolean(g && running && g.state.phase === "play" && currentView() === "play");

// Kept after every action, so a reload comes back to the level, paused.
function save() {
  if (!g || g.state.phase !== "play") return;
  store.set(
    SAVE_KEY,
    JSON.stringify({
      seed: g.state.setup.seed.text,
      run: g.run,
      pasted: g.pasted,
      assisted: g.assisted,
      at: g.at,
      log: g.log,
      elapsed: Math.round(now()),
      playId: g.playId,
    })
  );
}

function exitLevel() {
  armOrGo("exit", $("exitLabel"), "Tap again to leave", () => {
    stopAuto();
    clearInterval(ticker);
    running = false;
    g = null;
    store.remove(SAVE_KEY);
    toSetup();
  });
}

export function toSetup() {
  renderSetup();
  showView("setup");
}

/* ---- autoplay ----
   A secret: F2, or three quick taps on the game's name. It plays the level
   out, quicker than a person, and the level is then not scored, not sent
   to the leaderboard and does not count as finished. The mark is per level:
   the next level starts clean. */

export function toggleAutoplay() {
  if (!g || g.state.phase !== "play" || currentView() !== "play") return;
  if (auto) {
    stopAuto();
    draw();
    return;
  }
  if (!running) resume();
  g.assisted = true;
  g.selected = null;
  g.hint = null;
  syncScoredChip();
  save();
  auto = { timer: null, plan: null };
  draw();
  autoStep();
}

function stopAuto() {
  if (!auto) return;
  clearTimeout(auto.timer);
  auto = null;
}

function autoStep() {
  if (!auto || !g || g.state.phase !== "play" || !running) {
    stopAuto();
    return;
  }
  const { state } = g;
  if (!auto.plan?.length) auto.plan = solve(state.cols, state.cap, { maxNodes: 200000 });
  if (!auto.plan) {
    // A dead end: take moves back until there is a way through.
    if (state.history.length) doUndo({ fast: true });
    else {
      stopAuto();
      draw();
      return;
    }
  } else {
    const [a, b] = auto.plan.shift();
    if (!moveCount(state.cols, state.cap, a, b) || !doMove(a, b, { fast: true })) auto.plan = null;
  }
  if (auto) auto.timer = setTimeout(autoStep, AUTOPLAY_MS);
}

/* ---- the result ---- */

function replayOf(game) {
  return {
    v: REPLAY_VERSION,
    kind: "solo",
    seed: game.state.setup.seed.text,
    timed: game.state.setup.timed,
    players: [getSettings().name ?? "Player"],
    logs: [game.log],
    at: game.at,
  };
}

function finish() {
  stopAuto();
  clearInterval(ticker);
  running = false;
  store.remove(SAVE_KEY);
  draw();
  celebrate();
  const game = g;
  const [r] = finalScores(game.state);
  const seed = game.state.setup.seed;
  const counts = !game.pasted && !game.assisted;
  last = { ...game, result: r, replay: replayOf(game), counts };
  g = null;

  if (counts) {
    advance(seed.mode, seed.difficulty, seed.level);
    const s = getSettings();
    enqueue({
      play_id: game.playId,
      seed: seed.text,
      run_id: game.run?.id ?? null,
      log: game.log,
      duration_ms: game.state.endedAt,
      at: game.at,
      name: s.auto_submit && s.name ? s.name : null,
    });
  }
  // The result waits for the last move to finish playing out on the board,
  // and a moment more to see the solved board, but never for long.
  const shown = { done: false };
  const show = () => {
    if (shown.done) return;
    shown.done = true;
    setTimeout(() => showResult(), 700);
  };
  board.whenIdle().then(show);
  setTimeout(show, 8000);
}

function showResult() {
  if (!last) return;
  const { state, result: r } = last;
  const seed = state.setup.seed;
  showView("result");
  $("resultTitle").textContent = `Level ${seed.level} solved`;
  $("resultMeta").textContent = `${MODES[seed.mode].label} · ${DIFFICULTIES[seed.difficulty].label}`;
  $("resultScore").textContent = String(r.score);
  $("resultStats").innerHTML = [
    ["Moves", r.moves],
    ["Undos", r.undos],
    ["Hints", r.hints],
    ["Time", formatTime(state.endedAt)],
  ]
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${escapeHtml(v)}</dd></div>`)
    .join("");
  $("resultBreakdown").innerHTML = [
    ["Points from moves", `${r.points}`],
    ["Few moves bonus", `+${r.efficiency}`],
    r.timeBonus ? ["Time to spare", `+${r.timeBonus}%`] : null,
    ["Difficulty", `${r.difficulty}%`],
    r.level !== 100 ? ["Level", `${r.level}%`] : null,
  ]
    .filter(Boolean)
    .map(([k, v]) => `<li><span>${k}</span><span>${v}</span></li>`)
    .join("");
  document.querySelectorAll("#result .seed-code").forEach((el) => (el.textContent = seed.text));
  $("nextBtnLabel").textContent = last.counts ? `Next: level ${seed.level + 1}` : `Play level ${nextLevel(seed.mode, seed.difficulty)}`;
  $("shareLabel").textContent = "Share replay";
  renderRecord();

  const s = getSettings();
  if (s.auto_replay) replayer.open(last.replay, { own: true, playId: last.counts ? last.playId : null });
  else $("nextBtn").focus();
}

// What became of the level on its way to the leaderboard.
function renderRecord() {
  if (!last) return;
  const s = getSettings();
  const form = $("submitForm");
  const status = $("recordStatus");
  form.hidden = true;
  status.classList.remove("ok");
  if (!last.counts) {
    status.textContent = last.assisted
      ? "Autoplay played this level, so it is not scored and does not count towards your levels."
      : "Levels on a pasted seed are not scored and do not count towards your levels.";
    return;
  }
  const done = recordedResult(last.playId);
  const timedNote = last.state.setup.timed ? "" : " It was played offline, so it earns no speed bonus.";
  if (done?.refused) {
    status.textContent = `The server did not take this level: ${done.message || done.refused}.`;
    return;
  }
  if (done?.name_refused) {
    status.textContent = `Recorded: ${done.score} points, but not added under that name. ${done.message ?? ""}`.trim();
    form.hidden = false;
    $("nameInput").value = "";
    $("submitMsg").textContent = "";
    return;
  }
  if (done?.name) {
    status.classList.add("ok");
    status.textContent =
      `Added as ${done.name}: ${done.score} points.` +
      (done.rank ? ` Best ${done.best_score}, rank ${done.rank}. Total ${done.total} over ${done.levels} levels, rank ${done.total_rank}.` : "") +
      (done.top_level ? ` Top level ${done.top_level} on ${DIFFICULTIES[last.state.setup.seed.difficulty].label}, rank ${done.level_rank}.` : "") +
      timedNote;
    return;
  }
  const queuedNamed = isQueued(last.playId) && s.auto_submit && s.name;
  if (queuedNamed) {
    status.textContent =
      navigator.onLine === false || isStalled()
        ? `Saved. It goes on the leaderboard under ${s.name} once the server can be reached.${timedNote}`
        : `Adding to the leaderboard as ${s.name}.`;
    return;
  }
  // Recorded or waiting without a name: offer one.
  status.textContent = done ? `Recorded: ${done.score} points.${timedNote}` : `Saved on this device.${timedNote}`;
  form.hidden = false;
  $("nameInput").value = s.name ?? "";
  $("submitMsg").textContent = "";
}

async function submit(name) {
  if (!last?.counts) return;
  $("submitBtn").disabled = true;
  $("submitMsg").textContent = "Adding.";
  try {
    if (nameQueued(last.playId, name)) {
      $("submitMsg").textContent = "It goes on the leaderboard once it reaches the server.";
      saveSettings({ name });
      return;
    }
    const res = await api.submit(last.playId, name);
    saveSettings({ name: res.name });
    remember(last.playId, { ...(recordedResult(last.playId) ?? {}), ...res });
    renderRecord();
  } catch (err) {
    $("submitMsg").textContent =
      err.code === "offline" ? "Adding a level needs a connection. Try again once you are back online." : err.message || "That did not go through.";
  } finally {
    $("submitBtn").disabled = false;
  }
}

/* ---- seeds ---- */

function wireSeedForms() {
  document.querySelectorAll(".seed-form").forEach((form) => {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = form.querySelector(".seed-input");
      const msg = form.querySelector(".seed-msg");
      const s = getSettings();
      const seed = parseSeed(input.value, { mode: s.mode, difficulty: s.difficulty, level: nextLevel(s.mode, s.difficulty) });
      if (!seed) {
        msg.textContent = "That is not a seed. A seed looks like WE12-BXK4-M9TR.";
        input.focus();
        return;
      }
      msg.textContent = "";
      input.value = "";
      start({ seedText: seed.text });
    });
  });
  document.querySelectorAll("[data-copy-seed]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const text = btn.closest(".seed-line").querySelector(".seed-code").textContent;
      const label = btn.querySelector(".copy-label");
      label.textContent = (await copyText(text)) ? "Copied" : "Copy failed";
      setTimeout(() => (label.textContent = "Copy"), 2000);
    });
  });
}

export function playSeed(text) {
  start({ seedText: text });
}

export function initGame({ board: b, replayer: r }) {
  board = b;
  replayer = r;
  $("startBtn").addEventListener("click", () => start());
  $("resumeBtn").addEventListener("click", () => {
    try {
      const saved = JSON.parse(store.get(SAVE_KEY));
      if (!parseSeed(saved?.seed) || !Array.isArray(saved.log) || typeof saved.playId !== "string") throw new Error("bad save");
      begin(saved, { paused: true });
    } catch {
      store.remove(SAVE_KEY);
      renderSetup();
    }
  });
  $("modePick").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-mode-pick]");
    if (btn) saveSettings({ mode: btn.dataset.modePick });
  });
  $("difficultyPick").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-difficulty]");
    if (btn) saveSettings({ difficulty: btn.dataset.difficulty });
  });
  $("pauseBtn").addEventListener("click", () => (running ? pause() : resume()));
  $("continueBtn").addEventListener("click", resume);
  $("undoBtn").addEventListener("click", () => {
    stopAuto();
    doUndo();
  });
  $("restartBtn").addEventListener("click", doRestart);
  $("hintBtn").addEventListener("click", doHint);
  $("extraBtn").addEventListener("click", doExtra);
  $("exitBtn").addEventListener("click", exitLevel);
  $("menuBtn").addEventListener("click", toSetup);
  $("nextBtn").addEventListener("click", () => {
    if (last) saveSettings({ mode: last.state.setup.seed.mode, difficulty: last.state.setup.seed.difficulty });
    start();
  });
  $("sameSeedBtn").addEventListener("click", () => last && start({ seedText: last.state.setup.seed.text }));
  $("replayBtn").addEventListener("click", () => last && replayer.open(last.replay, { own: true, playId: last.counts ? last.playId : null }));
  $("shareBtn").addEventListener("click", () => last && shareReplay(last.replay, last.counts ? last.playId : null, $("shareLabel")));
  $("submitForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("nameInput").value.trim();
    if (!name) {
      $("submitMsg").textContent = "Enter a name.";
      $("nameInput").focus();
      return;
    }
    submit(name);
  });
  wireSeedForms();

  document.addEventListener("uwusort:recorded", (e) => {
    if (last?.playId === e.detail.playId) renderRecord();
    renderQueueNote();
    // Made now, while the level is fresh, so Share is instant later.
    if (last?.playId === e.detail.playId) replayLinkFor(last.replay, last.playId).catch(() => {});
  });
  document.addEventListener("uwusort:refused", (e) => {
    if (e.detail.nameOnly) {
      saveSettings({ name: null });
      $("startNote").textContent = `Your leaderboard name was not accepted (${e.detail.message || e.detail.code}). Pick another in Settings.`;
    }
    if (last?.playId === e.detail.playId) renderRecord();
    renderQueueNote();
  });
  document.addEventListener("uwusort:queue", () => {
    renderQueueNote();
    if (last && currentView() === "result") renderRecord();
  });

  // Out of sight, the clock stops: a level in a background tab is paused.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && isPlaying()) pause();
  });
  document.addEventListener("uwusort:view", (e) => {
    if (e.detail !== "play" && g && running) pause();
  });
  document.addEventListener("uwusort:settings", () => {
    if (currentView() === "setup") renderSetup();
    if (g && currentView() === "play") draw();
  });
  document.addEventListener("keydown", (e) => {
    if (currentView() !== "play" || document.body.classList.contains("modal-open")) return;
    if (e.target.closest("input, textarea")) return;
    if (e.key === "p" || e.key === "P") {
      e.preventDefault();
      running ? pause() : resume();
    } else if ((e.key === "z" || e.key === "Z" || e.key === "u" || e.key === "U") && running) {
      e.preventDefault();
      stopAuto();
      doUndo();
    }
  });
  renderSetup();
}

// Back from a replay to the result it came from.
export function backToResult() {
  if (last) {
    showView("result");
    return true;
  }
  return false;
}
