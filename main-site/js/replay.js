// Instant replay, and shareable replays.
//
// A replay plays back on the same board, one thing at a time: every move,
// undo, hint and restart, so a player can see where a level went wrong.
// Play and pause, a step back or forward, a timeline to drag, and 0.5x to
// 4x, as Word Rain's replay; the speed picked last is remembered in this
// browser. A hint shows the move it suggested. Every score shown is worked
// out again from the log by js/rules.js. A race shows one racer's board at
// a time, picked above the board.
//
// Sharing: online, the API stores the replay and the link is short,
// /r/<id>, as MRT Station Guesser's. Offline, or when the API will not take
// it, the link carries the whole game, as chess-game's links do.

import { api } from "./api.js";
import { DIFFICULTIES, MODES, applyEntry, createGame, finalScores, liveScore } from "./rules.js";
import { cloneCols, solve } from "./puzzle.js";
import { cleanReplay, longLink, readLongLink, setupOf, shortLink } from "./replay-format.js";
import { getSettings } from "./settings.js";
import { currentView, escapeHtml, formatTime, setIcon, shareLink, showView, store } from "./ui.js";

const SPEEDS = [0.5, 1, 2, 4];
const SPEED_STORAGE = "uwusort.replaySpeed";
// How long each moment shows at 1x: its real gap, held to this range so a
// long think does not stall the replay and a quick move is still seen.
const MIN_GAP_MS = 380;
const MAX_GAP_MS = 2000;

const $ = (id) => document.getElementById(id);

/* ---- building the moments ---- */

export function buildMoments(replay, boardIndex = 0) {
  const setup = setupOf(replay, boardIndex);
  const state = createGame(setup);
  const log = replay.logs[replay.kind === "race" ? boardIndex : 0];
  const m = MODES[setup.seed.mode];
  const names = setup.players;
  const party = names.length > 1;
  const who = (p) => (party ? `${names[p]}: ` : "");
  const moments = [];
  const snap = (t, caption, extra = {}) =>
    moments.push({
      t,
      cols: cloneCols(state.cols),
      scores: state.players.map((_, p) => liveScore(state, p)),
      moves: state.players.reduce((n, p) => n + p.moves, 0),
      done: state.players.reduce((n, p) => n + p.completed, 0),
      caption,
      change: null,
      hint: null,
      mark: null,
      ...extra,
    });

  snap(0, `The level, dealt from the seed: ${state.colours} colours.`);
  for (const entry of log) {
    const before = cloneCols(state.cols);
    const events = applyEntry(state, entry);
    // A log entry the rules refuse ends the replay there.
    if (!events) break;
    const e = events[0];
    const t = entry[0];
    switch (e?.type) {
      case "move": {
        const bits = [`${who(e.player)}${m.column} ${e.a + 1} to ${m.column} ${e.b + 1}`];
        if (e.points) bits.push(`+${e.points} points`);
        if (e.completed) bits.push(`${m.column} finished`);
        if (e.revealed) bits.push(`a hidden ${m.unit} showed its colour`);
        snap(t, bits.join(", "), { change: { a: e.a, b: e.b, n: e.n } });
        break;
      }
      case "undo":
        snap(t, `${who(e.player)}Undo`, { change: { a: e.b, b: e.a, n: e.n }, mark: "undo" });
        break;
      case "restart":
        snap(t, `${who(e.player)}Started the level again`, { mark: "undo" });
        break;
      case "hint": {
        const plan = solve(before, state.cap, { maxNodes: 120000 });
        const hint = plan?.length ? { a: plan[0][0], b: plan[0][1] } : null;
        snap(t, `${who(e.player)}Asked for a hint${hint ? `: ${m.column} ${hint.a + 1} to ${m.column} ${hint.b + 1}` : ""}`, {
          hint,
          mark: "hint",
        });
        break;
      }
      case "extra":
        snap(t, `${who(e.player)}Opened the extra ${m.column}`);
        break;
      case "leave":
        snap(t, `${names[e.player]} left`);
        break;
      case "join":
        snap(t, `${names[e.player]} came back`);
        break;
      default:
        break;
    }
    if (events.some((x) => x.type === "over")) {
      moments[moments.length - 1].caption += ". Solved";
      break;
    }
  }
  return { state, moments };
}

/* ---- sharing ---- */

const links = new WeakMap(); // replay -> link already made

export async function replayLinkFor(replay, playId) {
  if (links.has(replay)) return links.get(replay);
  let link;
  try {
    const { id } = await api.createReplay(replay, playId);
    link = shortLink(location.origin, id);
  } catch {
    link = longLink(location.origin, replay);
  }
  links.set(replay, link);
  return link;
}

export async function shareReplay(replay, playId, label) {
  const original = label?.textContent;
  if (label) label.textContent = "Making link";
  const link = await replayLinkFor(replay, playId);
  const outcome = await shareLink(link, "uwuSort replay");
  if (label) {
    label.textContent = { shared: "Shared", copied: "Link copied", cancelled: original, failed: "Copy failed" }[outcome];
    setTimeout(() => (label.textContent = original), 2500);
  }
}

// The replay a page address asks for: { id } for a short link, a replay or
// { damaged: true } for a long one, or null.
export function replayFromLocation() {
  const short = location.pathname.match(/^\/r\/([A-Za-z0-9]{8})\/?$/);
  if (short) return { id: short[1] };
  return readLongLink(new URLSearchParams(location.search));
}

/* ---- the player ---- */

export class ReplayPlayer {
  constructor({ board, onPlaySeed, onClose }) {
    this.board = board;
    this.onPlaySeed = onPlaySeed;
    this.onClose = onClose;
    this.replay = null;
    this.moments = [];
    this.index = 0;
    this.timer = null;
    this.boardIndex = 0;
    this.returnTo = "setup";
    const saved = Number(store.get(SPEED_STORAGE));
    this.speed = SPEEDS.includes(saved) ? saved : 1;
    this.syncSpeed();

    $("rpSpeed").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-speed]");
      if (btn) this.setSpeed(Number(btn.dataset.speed));
    });
    $("rpBack").addEventListener("click", () => this.step(-1));
    $("rpForward").addEventListener("click", () => this.step(1));
    $("rpPlay").addEventListener("click", () => (this.timer ? this.pause() : this.play()));
    $("rpSeek").addEventListener("input", (e) => {
      this.pause();
      this.show(Number(e.target.value));
    });
    $("rpDone").addEventListener("click", () => this.close());
    $("rpShare").addEventListener("click", () => shareReplay(this.replay, this.playId, $("rpShareLabel")));
    $("rpSeed").addEventListener("click", () => this.onPlaySeed?.(this.replay.seed));
    $("rpBoards").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-board-index]");
      if (btn) this.pickBoard(Number(btn.dataset.boardIndex));
    });
    document.addEventListener("keydown", (e) => {
      if (currentView() !== "replay" || document.body.classList.contains("modal-open")) return;
      if (e.target.closest("input, textarea, .fcol")) return;
      if (e.key === " ") this.timer ? this.pause() : this.play();
      else if (e.key === "ArrowLeft") this.step(-1);
      else if (e.key === "ArrowRight") this.step(1);
      else if (e.key === "Escape") this.close();
      else return;
      e.preventDefault();
    });
    document.addEventListener("uwusort:view", (e) => {
      if (e.detail !== "replay") this.pause();
    });
    document.addEventListener("uwusort:settings", () => {
      if (currentView() === "replay" && this.moments.length) this.show(this.index);
    });
  }

  // Opens a replay: from a level just played (`own`), or from a link. A
  // link by id is fetched first.
  async open(source, { own = false, playId = null, verified = null, autoplay = true } = {}) {
    if (currentView() !== "replay") this.returnTo = currentView();
    this.pause();
    showView("replay");
    $("rpStage").append(this.board.host);
    this.board.onPick = null;
    this.board.onDrop = null;
    this.board.onDragStart = null;
    $("rpMeta").textContent = "Loading the replay.";
    $("rpTrust").textContent = "";
    $("rpCaption").textContent = "";
    $("rpSummary").innerHTML = "";
    $("rpBoards").hidden = true;

    let replay = source;
    try {
      if (source?.id) {
        const r = await api.replay(source.id);
        replay = cleanReplay(r.replay);
        verified = r.verified === true;
        if (replay) links.set(replay, shortLink(location.origin, r.id));
      }
    } catch (err) {
      $("rpMeta").textContent =
        err.code === "offline"
          ? "This replay link needs a connection to open."
          : err.code === "replay_not_found"
            ? "There is no replay at that link."
            : "The replay did not load. Try again in a moment.";
      return;
    }
    if (!replay || replay.damaged) {
      $("rpMeta").textContent = "That replay link is damaged or incomplete, so it cannot be played back.";
      return;
    }

    this.replay = replay;
    this.playId = playId;
    this.own = own;
    const seed = setupOf(replay).seed;
    const kind = { solo: "", race: "Race. ", turns: "Taking turns. " }[replay.kind];
    $("rpMeta").textContent =
      `${kind}${replay.kind === "solo" ? (own ? "Your level. " : `${replay.players[0]}'s level. `) : `${replay.players.join(", ")}. `}` +
      `${MODES[seed.mode].label}, ${DIFFICULTIES[seed.difficulty].label}, level ${seed.level}. Seed ${replay.seed}.`;
    $("rpTrust").textContent = own
      ? ""
      : verified === true
        ? "Checked by the server."
        : "Not checked by the server: scores are worked out from the moves in the link.";
    $("rpSeed").hidden = own;

    if (replay.kind === "race") {
      $("rpBoards").hidden = false;
      $("rpBoards").innerHTML = replay.players
        .map((n, i) => `<button class="mode-btn" type="button" role="radio" aria-checked="false" data-board-index="${i}">${escapeHtml(n)}</button>`)
        .join("");
    }
    this.pickBoard(0, autoplay);
  }

  pickBoard(i, autoplay = false) {
    this.pause();
    this.boardIndex = i;
    document.querySelectorAll("#rpBoards [data-board-index]").forEach((el) => {
      const on = Number(el.dataset.boardIndex) === i;
      el.classList.toggle("active", on);
      el.setAttribute("aria-checked", String(on));
    });
    const { state, moments } = buildMoments(this.replay, i);
    this.moments = moments;
    this.final = state;
    $("rpSeek").max = String(moments.length - 1);
    $("rpMarks").innerHTML = moments
      .map((m, k) => (m.mark ? `<span class="${m.mark}" style="left:${(k / Math.max(1, moments.length - 1)) * 100}%"></span>` : ""))
      .join("");
    this.board.setup(this.viewOf(moments[0]));
    this.showSummary(false);
    if (autoplay && moments.length > 1) {
      this.show(0);
      this.timer = setTimeout(() => this.play(), 600);
      this.syncPlayButton(true);
    } else {
      this.show(autoplay ? 0 : moments.length - 1);
    }
  }

  viewOf(m) {
    return {
      mode: this.final.setup.seed.mode,
      cap: this.final.cap,
      palette: this.final.palette,
      cols: m.cols,
      selected: null,
      liftCount: 0,
      hint: m.hint,
      target: null,
      interactive: false,
      symbols: getSettings().symbols,
    };
  }

  showSummary(visible) {
    const box = $("rpSummary");
    if (!visible) {
      box.innerHTML = "";
      return;
    }
    const results = finalScores(this.final);
    const best = Math.max(...results.map((r) => r.score));
    box.innerHTML = `<ol class="standings">${results
      .map(
        (r) =>
          `<li${results.length > 1 && r.score === best ? ' class="lead"' : ""}><span>${escapeHtml(r.name)}</span><span>${r.score} points, ${r.moves} moves</span></li>`
      )
      .join("")}</ol>`;
  }

  show(i, change = null) {
    const m = this.moments[i];
    if (!m) return;
    this.index = i;
    this.board.render(this.viewOf(m), change);
    $("rpSeek").value = String(i);
    $("rpCaption").textContent = m.caption;
    $("rpTime").textContent = `${formatTime(m.t)} · ${i} of ${this.moments.length - 1}`;
    const names = setupOf(this.replay, this.boardIndex).players;
    $("rpScore").textContent =
      names.length > 1
        ? names.map((n, p) => `${n} ${m.scores[p]}`).join(" · ")
        : `Score ${m.scores[0]} · Moves ${m.moves} · Finished ${m.done}/${this.final.colours}`;
    $("rpBack").disabled = i === 0;
    $("rpForward").disabled = i === this.moments.length - 1;
    this.showSummary(i === this.moments.length - 1);
  }

  step(delta, fromTimer = false) {
    if (!fromTimer) this.pause();
    const next = this.index + delta;
    if (next < 0 || next >= this.moments.length) return false;
    // Forward a step animates the move; back a step plays it in reverse.
    const m = delta > 0 ? this.moments[next] : this.moments[this.index];
    const change = m.change ? (delta > 0 ? { ...m.change, fast: this.speed >= 4 } : { a: m.change.b, b: m.change.a, n: m.change.n, fast: true }) : null;
    this.show(next, Math.abs(delta) === 1 ? change : null);
    return true;
  }

  gapAfter(i) {
    const a = this.moments[i];
    const b = this.moments[i + 1];
    const real = b ? b.t - a.t : MIN_GAP_MS;
    return Math.max(MIN_GAP_MS, Math.min(MAX_GAP_MS, real)) / this.speed;
  }

  play() {
    clearTimeout(this.timer);
    // Played to the end already: start over.
    if (this.index >= this.moments.length - 1) this.show(0);
    this.syncPlayButton(true);
    const tick = () => {
      if (!this.step(1, true) || this.index >= this.moments.length - 1) {
        this.pause();
        return;
      }
      this.timer = setTimeout(tick, this.gapAfter(this.index));
    };
    this.ticking = tick;
    this.timer = setTimeout(tick, this.gapAfter(this.index));
  }

  pause() {
    clearTimeout(this.timer);
    this.timer = null;
    this.ticking = null;
    this.syncPlayButton(false);
  }

  // A replay that is playing picks the new pace up from its next moment.
  setSpeed(speed) {
    if (!SPEEDS.includes(speed)) return;
    this.speed = speed;
    store.set(SPEED_STORAGE, String(speed));
    this.syncSpeed();
    if (this.timer && this.ticking) {
      clearTimeout(this.timer);
      this.timer = setTimeout(this.ticking, this.gapAfter(this.index));
    }
  }

  syncSpeed() {
    document.querySelectorAll("#rpSpeed [data-speed]").forEach((el) => {
      const on = Number(el.dataset.speed) === this.speed;
      el.classList.toggle("active", on);
      el.setAttribute("aria-checked", String(on));
    });
  }

  syncPlayButton(playing) {
    const btn = $("rpPlay");
    btn.setAttribute("aria-label", playing ? "Pause replay" : "Play replay");
    setIcon(btn, playing ? "pause" : "play");
  }

  close() {
    this.pause();
    // Off the address, so a reload does not open it again.
    if (location.pathname !== "/" || location.search) history.replaceState(null, "", "/");
    this.onClose?.(this.returnTo === "replay" ? "setup" : this.returnTo);
  }
}

