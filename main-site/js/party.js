// Party games: two to four players, each on their own device, on the same
// network. One device hosts and shows a code, a link and a QR code; the
// others join with any of them. The host picks how to play:
//
//   Race        everyone gets the same level on their own board; the first
//               to solve it wins, and the rest finish for their place
//   Take turns  one board, one move each; finishing a column keeps the turn
//
// Pairing is js/p2p.js, STUN only, per STUN-p2p-spec.md at the repo root,
// the way uwuPromptr's remote pairs: PeerJS's public broker introduces the
// devices, then they talk directly. So they have to be on the same wifi, or
// one on a hotspot from the other.
//
// The host is authoritative. Its device runs every board with js/rules.js
// and sends each guest a full snapshot on every change and 20 times a
// second. A hidden nut is sent as hidden until it is uncovered, and the seed
// only once the game is over, so a guest cannot read the level out of a
// snapshot. Guests send what they want to do; the host applies it if the
// rules allow.
//
// Party scores never go on the leaderboard: the host deals the level.

import { CODE_LENGTH, Guest, Host, PROTOCOL_VERSION, generateCode, isValidCode, normaliseCode } from "./p2p.js";
import { qrToSvg } from "./qr.js";
import {
  DIFFICULTIES,
  EXTRA,
  HINT,
  JOIN,
  LEAVE,
  MAX_LEVEL,
  MODES,
  MOVE,
  RESTART,
  UNDO,
  applyEntry,
  cleanDifficulty,
  cleanLevel,
  cleanMode,
  createGame,
  finalScores,
  isStuck,
  levelShape,
  liveScore,
} from "./rules.js";
import { HIDDEN_FLAG, isHiddenUnit, moveCount, runLength, solve } from "./puzzle.js";
import { COLOURS } from "./palette.js";
import { newSeed, parseSeed } from "./seed.js";
import { REPLAY_VERSION, cleanReplay, cleanText } from "./replay-format.js";
import { shareReplay } from "./replay.js";
import { getSettings } from "./settings.js";
import { copyText, currentView, escapeHtml, formatTime, showView, store } from "./ui.js";

const MAX_PLAYERS = 4;
const HOST_CODE_KEY = "uwusort.hostCode";
const LAST_CODE_KEY = "uwusort.lastCode";
const CLIENT_ID_KEY = "uwusort.clientId";
// The host's party, in this tab only: a reload carries on with it.
const PARTY_KEY = "uwusort.party";
const STALE_MS = 2000;
const SILENT_GUEST_MS = 6000;
const MASKED = HIDDEN_FLAG + 15;
const FORMATS = ["race", "turns"];
const ACTS = { move: MOVE, undo: UNDO, hint: HINT, extra: EXTRA, restart: RESTART };

const $ = (id) => document.getElementById(id);

let board = null;
let replayer = null;
let role = null; // "host", "guest" or null

/* ---- shared ---- */

function clientId() {
  let id = store.get(CLIENT_ID_KEY);
  if (!/^[A-Za-z0-9]{12}$/.test(id ?? "")) {
    const abc = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => abc[b % abc.length]).join("");
    store.set(CLIENT_ID_KEY, id);
  }
  return id;
}

const joinLink = (code) => `${location.origin}/join?id=${code}`;

const STATUS_TEXT = {
  idle: "",
  connecting: "Connecting.",
  waiting: "Waiting for players. Everyone has to be on the same wifi, or on a hotspot from this device.",
  connected: "Connected.",
  dropped: "The connection dropped. Reconnecting.",
  unreachable:
    "Could not reach the other device. Both have to be on the same network: join the same wifi, or turn on a hotspot on one and join it from the other. Check the code is still the one on screen.",
};

function renderStatus(detail) {
  $("partyStatus").textContent = detail.status === "error" ? detail.message : STATUS_TEXT[detail.status] ?? "";
  $("partyStatus").classList.toggle("error", detail.status === "error" || detail.status === "unreachable");
  if (detail.status === "connected" || detail.status === "waiting") wakeLock(true);
  if (detail.status === "idle") wakeLock(false);
}

// Keeps the screen on while in a party: a phone that sleeps drops out.
let lock = null;
async function wakeLock(on) {
  try {
    if (on && !lock && document.visibilityState === "visible") {
      lock = await navigator.wakeLock?.request("screen");
      lock?.addEventListener?.("release", () => (lock = null));
    } else if (!on && lock) {
      await lock.release();
      lock = null;
    }
  } catch {
    lock = null;
  }
}

function showPanel(name) {
  for (const p of ["partyChoose", "partyLobby", "partyGame", "partyOver"]) $(p).hidden = p !== name;
}

/* ---- drawing a snapshot, on both ends ---- */

let drawn = { game: -1, seq: -1, pulse: -1 };
let picked = null; // this device's picked-up column
let snapNow = null;
let lastReplay = null;

function boardView(snap, extra = {}) {
  const b = snap.board;
  return {
    mode: b.mode,
    cap: b.cap,
    palette: b.palette,
    cols: b.cols,
    selected: picked,
    liftCount: picked === null ? 0 : runLength(b.cols[picked] ?? []),
    hint: b.hint,
    target: null,
    interactive: b.interactive,
    symbols: getSettings().symbols,
    ...extra,
  };
}

// Draws only while the party is on screen: a snapshot arriving while
// somebody watches the replay must not pull them away from it.
function renderParty(snap) {
  snapNow = snap;
  if (snap.phase === "over") lastReplay = snap.replay ? cleanReplay(snap.replay) : null;
  if (currentView() !== "party") return;
  const host = role === "host";
  document.querySelectorAll("#party .host-only").forEach((el) => (el.hidden = !host));
  document.querySelectorAll("#party .guest-only").forEach((el) => (el.hidden = host));
  const race = snap.options.format === "race";

  const players = snap.players
    .map((p, i) => {
      const bits = [];
      if (i === snap.you) bits.push("you");
      if (i === 0) bits.push("host");
      if (!p.connected) bits.push("away");
      const turn = snap.phase === "game" && !race && i === snap.current;
      const stat =
        snap.phase === "lobby"
          ? ""
          : race
            ? p.finished !== null
              ? `solved in ${formatTime(p.finished)} · ${p.score}`
              : `${p.done}/${snap.colours} done · ${p.score}`
            : `${p.score} · ${p.moves} moves`;
      return `<li class="${turn ? "turn" : ""}${p.connected ? "" : " away"}"><span class="pl-name">${escapeHtml(p.name)}${
        bits.length ? ` <small>(${bits.join(", ")})</small>` : ""
      }</span><span class="pl-score">${stat}</span></li>`;
    })
    .join("");

  if (snap.phase === "lobby") {
    showPanel("partyLobby");
    $("lobbyPlayers").innerHTML = players;
    $("lobbyCount").textContent = `${snap.players.length} of ${MAX_PLAYERS} players`;
    const o = snap.options;
    const press = (id, attr, value) =>
      document.querySelectorAll(`#${id} [data-${attr}]`).forEach((el) => {
        const on = el.dataset[attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] === String(value);
        el.classList.toggle("active", on);
        el.setAttribute("aria-pressed", String(on));
        el.disabled = !host;
      });
    press("pFormat", "format", o.format);
    press("pMode", "p-mode", o.mode);
    press("pDifficulty", "difficulty", o.difficulty);
    $("pLevel").value = String(o.level);
    $("pLevel").disabled = !host;
    $("pLevelDown").disabled = !host || o.level <= 1;
    $("pLevelUp").disabled = !host;
    const shape = levelShape(o.mode, o.difficulty, o.level);
    const m = MODES[o.mode];
    $("lobbySummary").textContent =
      `${race ? "Race" : "Take turns"}: ${m.label}, ${DIFFICULTIES[o.difficulty].label}, level ${o.level}, ` +
      `${shape.colours} colours in ${shape.colours + shape.empties} ${m.columns}.`;
    $("partyStartBtn").disabled = snap.players.length < 2;
    $("partyStartNote").textContent = snap.players.length < 2 ? "Waiting for at least one more player." : "";
    return;
  }

  if (snap.phase === "game") {
    showPanel("partyGame");
    const remount = $("partyStage") !== board.host.parentElement;
    if (remount) $("partyStage").append(board.host);
    board.onPick = onBoardPick;
    board.onDrop = onBoardDrop;
    board.onDragStart = onBoardDragStart;
    if (!snap.board.interactive) picked = null;
    if (remount || drawn.game !== snap.game) {
      picked = null;
      board.setup(boardView(snap));
      drawn = { game: snap.game, seq: snap.board.last?.seq ?? -1, pulse: snap.board.pulse?.seq ?? -1 };
    } else {
      const last = snap.board.last;
      const change = last && last.seq !== drawn.seq ? { a: last.a, b: last.b, n: last.n } : null;
      if (last) drawn.seq = last.seq;
      board.render(boardView(snap), change);
    }
    if (snap.board.pulse && snap.board.pulse.seq !== drawn.pulse) {
      drawn.pulse = snap.board.pulse.seq;
      board.pulse([snap.board.pulse.col], snap.board.pulse.kind);
    }
    $("partyPlayers").innerHTML = players;
    const mine = snap.board.interactive;
    $("partyTurn").textContent = race
      ? snap.players[snap.you]?.finished !== null
        ? "Solved. Waiting for the others."
        : "Race: solve it first."
      : mine
        ? "Your turn."
        : `${snap.players[snap.current]?.name ?? ""}'s turn.`;
    $("partyTurn").classList.toggle("mine", mine);
    $("partyCaption").textContent = snap.caption;
    $("pUndo").disabled = !mine;
    $("pHint").disabled = !mine;
    $("pExtra").disabled = !mine || snap.board.extra;
    $("pExtraLabel").textContent = `Extra ${MODES[snap.board.mode].column}`;
    return;
  }

  showPanel("partyOver");
  const results = snap.results ?? [];
  $("partyStandings").innerHTML = results
    .map(
      (r, i) =>
        `<li class="${i === 0 ? "lead" : ""}"><span>${i + 1}. ${escapeHtml(r.name)}${r.index === snap.you ? " <small>(you)</small>" : ""}</span><span>${
          race ? (r.finished !== null ? `solved in ${formatTime(r.finished)}, ` : `${r.done} done, `) : ""
        }${r.score} points</span></li>`
    )
    .join("");
  $("partyOverTitle").textContent = results.length ? `${results[0].name} wins` : "Game over";
  $("partySeed").textContent = snap.replay?.seed ?? "";
}

/* ---- picking and moving, on this device ---- */

function canLift(cols, cap, i) {
  if (!runLength(cols[i] ?? [])) return false;
  for (let b = 0; b < cols.length; b++) if (moveCount(cols, cap, i, b)) return true;
  return false;
}

function act(message) {
  if (role === "host") hostAct(0, message);
  else guest?.send({ type: "act", ...message });
}

function redraw() {
  if (snapNow?.phase === "game") board.render(boardView(snapNow));
}

function onBoardPick(i) {
  const b = snapNow?.board;
  if (!b?.interactive) return;
  if (i === null || picked === i) {
    picked = null;
    redraw();
    return;
  }
  if (picked === null) {
    if (canLift(b.cols, b.cap, i)) picked = i;
    else board.pulse([i], "bad");
    redraw();
    return;
  }
  if (moveCount(b.cols, b.cap, picked, i)) {
    act({ act: "move", a: picked, b: i });
    picked = null;
    return;
  }
  picked = canLift(b.cols, b.cap, i) ? i : null;
  if (picked === null) board.pulse([i], "bad");
  redraw();
}

function onBoardDragStart(a) {
  const b = snapNow?.board;
  if (b?.interactive && canLift(b.cols, b.cap, a)) {
    picked = a;
    redraw();
  }
}

function onBoardDrop(a, target) {
  const b = snapNow?.board;
  if (!b?.interactive) return;
  if (target !== null && moveCount(b.cols, b.cap, a, target)) act({ act: "move", a, b: target });
  else if (target !== null) board.pulse([target], "bad");
  picked = null;
  redraw();
}

/* ---- host ---- */

let hostConn = null;
let H = null; // the host's party
let retriedTaken = false;
let hostTimers = [];

function freshParty() {
  const s = getSettings();
  return {
    code: null,
    seats: [{ cid: clientId(), name: s.name ?? "Host", peer: null, connected: true, heard: 0 }],
    options: { format: "race", mode: s.mode, difficulty: s.difficulty, level: 1 },
    phase: "lobby",
    game: null,
    count: 0,
    caption: "",
    replay: null,
    seq: 0,
  };
}

const isRace = () => H.options.format === "race";
const gameTime = () => Date.now() - H.game.startEpoch;

// The board state player p plays on.
const stateOf = (p) => (isRace() ? H.game.states[p] : H.game.states[0]);
const logOf = (p) => (isRace() ? H.game.logs[p] : H.game.logs[0]);

function newGame() {
  const o = H.options;
  const seed = newSeed(o.mode, o.difficulty, o.level);
  const names = H.seats.map((s) => s.name);
  const race = o.format === "race";
  const states = race
    ? names.map((n) => createGame({ seed, timed: true, players: [n] }))
    : [createGame({ seed, timed: false, players: names, turns: true })];
  return {
    seed,
    states,
    logs: states.map(() => []),
    startEpoch: Date.now(),
    at: new Date().toISOString(),
    last: states.map(() => null),
    hint: states.map(() => null),
    pulse: states.map(() => null),
    finished: names.map(() => null),
  };
}

function saveParty() {
  if (!H) return;
  const g = H.game;
  const data = {
    code: H.code,
    seats: H.seats.map((s) => ({ cid: s.cid, name: s.name })),
    options: H.options,
    phase: H.phase,
    count: H.count,
    game: g && { seed: g.seed.text, logs: g.logs, startEpoch: g.startEpoch, at: g.at },
    replay: H.replay,
  };
  try {
    sessionStorage.setItem(PARTY_KEY, JSON.stringify(data));
  } catch {
    // Not kept across a reload.
  }
}

function cleanOptions(o) {
  return {
    format: FORMATS.includes(o?.format) ? o.format : "race",
    mode: cleanMode(o?.mode),
    difficulty: cleanDifficulty(o?.difficulty),
    level: cleanLevel(o?.level),
  };
}

function loadParty() {
  try {
    const data = JSON.parse(sessionStorage.getItem(PARTY_KEY) ?? "null");
    if (!data || !isValidCode(data.code) || !Array.isArray(data.seats) || !data.seats.length) return null;
    const party = freshParty();
    party.code = data.code;
    party.seats = data.seats.slice(0, MAX_PLAYERS).map((s, i) => ({ cid: String(s.cid), name: cleanText(s.name, 20) || `Player ${i + 1}`, peer: null, connected: i === 0, heard: 0 }));
    party.options = cleanOptions(data.options);
    party.count = Number(data.count) || 0;
    party.replay = data.replay ? cleanReplay(data.replay) : null;
    const seed = data.game ? parseSeed(data.game.seed) : null;
    party.phase = seed && (data.phase === "game" || (data.phase === "over" && party.replay)) ? data.phase : "lobby";
    if (party.phase === "game") {
      H = party;
      const g = newGame();
      g.seed = seed;
      const names = party.seats.map((s) => s.name);
      g.states = isRace()
        ? names.map((n) => createGame({ seed, timed: true, players: [n] }))
        : [createGame({ seed, timed: false, players: names, turns: true })];
      g.logs = g.states.map(() => []);
      g.startEpoch = Number(data.game.startEpoch) || Date.now();
      g.at = data.game.at;
      party.game = g;
      (data.game.logs ?? []).forEach((log, k) => {
        for (const entry of Array.isArray(log) ? log : []) {
          if (applyEntry(g.states[k], entry)) g.logs[k].push(entry);
        }
        if (isRace() && g.states[k]?.phase === "over") g.finished[k] = g.states[k].endedAt;
      });
      // Guests are away until they reconnect.
      if (!isRace()) party.seats.forEach((_, i) => i > 0 && logEntry(0, [gameTime(), LEAVE, i]));
    }
    return party;
  } catch {
    return null;
  }
}

function logEntry(k, entry) {
  const events = applyEntry(H.game.states[k], entry);
  if (events) H.game.logs[k].push(entry);
  return events ?? [];
}

// Hidden units go out as hidden, whatever colour they are.
const masked = (cols) => cols.map((col) => col.map((u) => (isHiddenUnit(u) ? MASKED : u)));

function snapshot(you) {
  const g = H.game;
  const race = isRace();
  const k = race ? you : 0;
  const state = g?.states[k];
  const players = H.seats.map((s, i) => {
    const st = g ? (race ? g.states[i] : g.states[0]) : null;
    const p = st ? (race ? 0 : i) : 0;
    return {
      name: s.name,
      connected: s.connected,
      score: st ? liveScore(st, p) : 0,
      moves: st ? st.players[p]?.moves ?? 0 : 0,
      done: st ? st.players.reduce((n, x) => n + x.completed, 0) : 0,
      finished: g && race ? g.finished[i] : null,
    };
  });
  const playing = H.phase === "game" && state && state.phase === "play";
  return {
    type: "state",
    v: PROTOCOL_VERSION,
    phase: H.phase,
    game: H.count,
    you,
    players,
    options: H.options,
    colours: state?.colours ?? 0,
    current: state && !race ? state.current : -1,
    board: state
      ? {
          mode: state.setup.seed.mode,
          cap: state.cap,
          palette: state.palette,
          cols: masked(state.cols),
          extra: state.extra,
          last: g.last[k],
          hint: g.hint[k] && (race || g.hint[k].p === you) ? { a: g.hint[k].a, b: g.hint[k].b } : null,
          pulse: g.pulse[k],
          interactive: Boolean(playing && (race ? g.finished[you] === null : state.current === you) && H.seats[you]?.connected !== false),
        }
      : null,
    caption: H.caption,
    results: H.phase === "over" ? results() : null,
    replay: H.phase === "over" ? H.replay : null,
  };
}

function results() {
  const g = H.game;
  if (!g) return [];
  if (isRace()) {
    return H.seats
      .map((s, i) => {
        const [r] = finalScores(g.states[i]);
        return { index: i, name: s.name, score: r.score, moves: r.moves, done: r.completed, finished: g.finished[i] };
      })
      .sort((a, b) => (a.finished ?? Infinity) - (b.finished ?? Infinity) || b.done - a.done || b.score - a.score);
  }
  return finalScores(g.states[0])
    .map((r, i) => ({ index: i, name: r.name, score: r.score, moves: r.moves, done: r.completed, finished: null }))
    .sort((a, b) => b.score - a.score);
}

function broadcast() {
  if (!H) return;
  if (role === "host") renderParty(snapshot(0));
  H.seats.forEach((s, i) => {
    if (i > 0 && s.peer) hostConn?.send(snapshot(i), s.peer);
  });
}

function endGame() {
  const g = H.game;
  H.phase = "over";
  H.replay = {
    v: REPLAY_VERSION,
    kind: isRace() ? "race" : "turns",
    seed: g.seed.text,
    timed: isRace(),
    players: H.seats.map((s) => s.name),
    logs: g.logs,
    at: g.at,
  };
  H.caption = "";
  saveParty();
  broadcast();
}

function hostAct(p, message) {
  const g = H?.game;
  if (H?.phase !== "game") return;
  const code = ACTS[message.act];
  if (code === undefined) return;
  const race = isRace();
  const k = race ? p : 0;
  const state = g.states[k];
  if (!state || state.phase !== "play") return;
  if (!race && state.current !== p) return;
  const t = Math.max(state.lastT, gameTime());
  const entry = code === MOVE ? [t, MOVE, message.a, message.b] : [t, code];
  if (code === MOVE && !(Number.isInteger(message.a) && Number.isInteger(message.b))) return;
  const events = applyEntry(state, entry);
  if (!events) {
    g.pulse[k] = { seq: ++H.seq, col: Number.isInteger(message.b) ? message.b : 0, kind: "bad" };
    broadcast();
    return;
  }
  g.logs[k].push(entry);
  const name = H.seats[p]?.name ?? "";
  const m = MODES[g.seed.mode];
  const e = events[0];
  g.hint[k] = null;
  if (e.type === "move") {
    g.last[k] = { seq: ++H.seq, a: e.a, b: e.b, n: e.n };
    if (e.completed) g.pulse[k] = { seq: ++H.seq, col: e.b, kind: "done" };
    if (!race) H.caption = `${name}: ${m.column} ${e.a + 1} to ${e.b + 1}${e.completed ? `, ${m.column} finished` : ""}.`;
  } else if (e.type === "undo") {
    g.last[k] = { seq: ++H.seq, a: e.b, b: e.a, n: e.n };
    if (!race) H.caption = `${name} took a move back.`;
  } else if (e.type === "restart") {
    g.last[k] = null;
    if (!race) H.caption = `${name} started the level again.`;
  } else if (e.type === "hint") {
    const plan = solve(state.cols, state.cap, { maxNodes: 120000 });
    if (plan?.length) g.hint[k] = { p, a: plan[0][0], b: plan[0][1] };
    if (!race) H.caption = `${name} asked for a hint.`;
  } else if (e.type === "extra") {
    if (!race) H.caption = `${name} opened the extra ${m.column}.`;
  }
  if (race && state.phase === "over") {
    g.finished[p] = state.endedAt;
    const place = g.finished.filter((f) => f !== null).length;
    H.caption = `${name} solved it${place === 1 ? " first" : ""}, in ${formatTime(state.endedAt)}.`;
    const left = H.seats.some((s, i) => s.connected && g.finished[i] === null);
    if (!left) endGame();
  } else if (!race && state.phase === "over") {
    endGame();
  } else if (!race && isStuck(state)) {
    H.caption += " No moves left: undo something.";
  }
  saveParty();
  broadcast();
}

function hostTick() {
  if (!H) return;
  const now = Date.now();
  // Guests heard from nothing for a while have gone, whatever PeerJS says.
  H.seats.forEach((s, i) => {
    if (i > 0 && s.peer && s.heard && now - s.heard > SILENT_GUEST_MS) {
      const link = hostConn?.links.get(s.peer);
      if (link) hostConn.drop(link);
      guestGone(s.peer);
    }
  });
}

function seatOf(peer) {
  return H.seats.findIndex((s, i) => i > 0 && s.peer === peer);
}

function guestJoined(peer, metadata) {
  const cid = typeof metadata?.cid === "string" ? metadata.cid.slice(0, 32) : "";
  const name = cleanText(metadata?.name, 20);
  let i = cid ? H.seats.findIndex((s, j) => j > 0 && s.cid === cid) : -1;
  if (i > 0) {
    H.seats[i].peer = peer;
    H.seats[i].connected = true;
    H.seats[i].heard = Date.now();
    if (H.phase === "game" && !isRace()) logEntry(0, [gameTime(), JOIN, i]);
  } else if (H.phase === "lobby" && H.seats.length < MAX_PLAYERS) {
    H.seats.push({ cid, name: name || `Player ${H.seats.length + 1}`, peer, connected: true, heard: Date.now() });
  } else {
    hostConn.send({ type: H.phase === "lobby" ? "full" : "started" }, peer);
    const link = hostConn.links.get(peer);
    setTimeout(() => link && hostConn.drop(link), 300);
    return;
  }
  saveParty();
  broadcast();
}

function guestGone(peer) {
  const i = seatOf(peer);
  if (i < 0) return;
  const seat = H.seats[i];
  seat.peer = null;
  seat.connected = false;
  if (H.phase === "lobby") H.seats.splice(i, 1);
  else if (H.phase === "game") {
    if (!isRace()) {
      const events = logEntry(0, [gameTime(), LEAVE, i]);
      if (events.some((e) => e.type === "over")) endGame();
    } else if (!H.seats.some((s, k) => s.connected && H.game.finished[k] === null)) endGame();
  }
  saveParty();
  broadcast();
}

function hostMessage({ message, from }) {
  const i = seatOf(from);
  if (i > 0) H.seats[i].heard = Date.now();
  switch (message.type) {
    case "hello":
      if (message.v !== PROTOCOL_VERSION) hostConn.send({ type: "reload" }, from);
      else if (i > 0) hostConn.send(snapshot(i), from);
      break;
    case "act":
      if (i > 0 && typeof message.act === "string") hostAct(i, { act: message.act, a: message.a, b: message.b });
      break;
    case "bye":
      guestGone(from);
      break;
    default:
      // ping, and anything unknown, which is never thrown on.
      break;
  }
}

async function startHosting() {
  if (hostConn) return;
  role = "host";
  H ??= loadParty() ?? freshParty();
  const stored = store.get(HOST_CODE_KEY);
  H.code ??= isValidCode(stored) ? stored : generateCode();
  store.set(HOST_CODE_KEY, H.code);
  showCode(H.code);
  saveParty();
  broadcast();

  hostConn = new Host({ maxGuests: MAX_PLAYERS - 1 });
  hostConn.addEventListener("status", ({ detail }) => {
    if (detail.taken && !retriedTaken) {
      retriedTaken = true;
      restartWithFreshCode();
      return;
    }
    if (detail.status === "waiting") retriedTaken = false;
    renderStatus(detail);
  });
  hostConn.addEventListener("join", ({ detail }) => guestJoined(detail.id, detail.metadata));
  hostConn.addEventListener("leave", ({ detail }) => guestGone(detail.id));
  hostConn.addEventListener("message", ({ detail }) => hostMessage(detail));
  hostTimers = [setInterval(hostTick, 500), setInterval(broadcast, 50)];

  try {
    await hostConn.start(H.code);
  } catch {
    renderStatus({ status: "error", message: "Could not load pairing. Check your connection." });
  }
}

function stopHosting() {
  hostTimers.forEach(clearInterval);
  hostTimers = [];
  hostConn?.close();
  hostConn = null;
}

async function restartWithFreshCode() {
  stopHosting();
  store.remove(HOST_CODE_KEY);
  if (H) H.code = null;
  await startHosting();
}

function showCode(code) {
  const link = joinLink(code);
  $("partyCode").textContent = `${code.slice(0, 3)} ${code.slice(3)}`;
  $("partyLink").textContent = link.replace(/^https?:\/\//, "");
  $("partyLink").href = link;
  $("partyQr").innerHTML = qrToSvg(link);
}

function hostStartGame() {
  if (!H || H.phase === "game" || H.seats.length < 2) return;
  H.game = newGame();
  H.count += 1;
  H.phase = "game";
  H.caption = isRace() ? "Go." : `${H.seats[0].name} goes first.`;
  H.replay = null;
  saveParty();
  broadcast();
}

// Back to the lobby with the same players, for another game.
function hostAgain() {
  if (!H) return;
  H.seats = H.seats.filter((s, i) => i === 0 || s.connected);
  H.phase = "lobby";
  H.game = null;
  if (isRace()) H.options.level = Math.min(MAX_LEVEL, H.options.level + 1);
  saveParty();
  broadcast();
}

let endArmed = 0;
function hostEnd() {
  if (H?.phase !== "game") return;
  if (Date.now() - endArmed > 3000) {
    endArmed = Date.now();
    $("partyEndLabel").textContent = "Tap again to end";
    setTimeout(() => ($("partyEndLabel").textContent = "End game"), 3000);
    return;
  }
  $("partyEndLabel").textContent = "End game";
  endGame();
}

let leaveArmed = 0;
function hostLeave() {
  if (H?.phase === "game" && Date.now() - leaveArmed > 3000) {
    leaveArmed = Date.now();
    $("partyLeaveLabel").textContent = "Tap again to end the party";
    setTimeout(() => ($("partyLeaveLabel").textContent = "Leave"), 3000);
    return;
  }
  stopHosting();
  H = null;
  role = null;
  try {
    sessionStorage.removeItem(PARTY_KEY);
  } catch {
    // Nothing kept.
  }
  wakeLock(false);
  showChoose();
}

/* ---- guest ---- */

let guest = null;
let guestCode = "";
let lastHeard = 0;
let staleTimer = null;
let rejoins = 0;

const int = (v, lo, hi, fallback = lo) => (Number.isInteger(v) && v >= lo && v <= hi ? v : fallback);

// A snapshot is input from another device: checked before it is drawn.
function cleanSnapshot(m) {
  if (m.phase !== "lobby" && m.phase !== "game" && m.phase !== "over") return null;
  if (!Array.isArray(m.players) || !m.players.length || m.players.length > MAX_PLAYERS) return null;
  const players = m.players.map((p, i) => ({
    name: cleanText(p?.name, 20) || `Player ${i + 1}`,
    connected: p?.connected === true,
    score: Math.max(0, Math.floor(Number(p?.score) || 0)),
    moves: Math.max(0, Math.floor(Number(p?.moves) || 0)),
    done: Math.max(0, Math.floor(Number(p?.done) || 0)),
    finished: Number.isInteger(p?.finished) && p.finished >= 0 ? p.finished : null,
  }));
  const options = cleanOptions(m.options);
  const snap = {
    phase: m.phase,
    game: int(m.game, 0, 1e6),
    you: int(m.you, 0, players.length - 1),
    players,
    options,
    colours: int(m.colours, 0, 16),
    current: int(m.current, -1, players.length - 1, -1),
    caption: cleanText(m.caption, 160),
    board: null,
    results: null,
    replay: null,
  };
  if (m.phase === "game") {
    const b = m.board;
    const shape = levelShape(options.mode, options.difficulty, options.level);
    if (!b || !Array.isArray(b.cols) || b.cols.length > shape.colours + shape.empties + 1) return null;
    const cols = b.cols.map((col) =>
      (Array.isArray(col) ? col.slice(0, shape.cap) : []).map((u) => (Number.isInteger(u) && ((u >= 0 && u < shape.colours) || u === MASKED) ? u : MASKED))
    );
    const palette = Array.isArray(b.palette) ? b.palette.slice(0, 16).map((c) => int(c, 0, COLOURS.length - 1)) : [];
    if (palette.length !== shape.colours) return null;
    const pair = (x) => (x && Number.isInteger(x.a) && Number.isInteger(x.b) && x.a >= 0 && x.b >= 0 && x.a < cols.length && x.b < cols.length ? x : null);
    const last = pair(b.last);
    snap.board = {
      mode: options.mode,
      cap: shape.cap,
      palette,
      cols,
      extra: b.extra === true,
      last: last && Number.isInteger(b.last.seq) ? { seq: b.last.seq, a: last.a, b: last.b, n: int(b.last.n, 1, shape.cap, 1) } : null,
      hint: pair(b.hint) ? { a: b.hint.a, b: b.hint.b } : null,
      pulse:
        b.pulse && Number.isInteger(b.pulse.seq) && (b.pulse.kind === "bad" || b.pulse.kind === "done")
          ? { seq: b.pulse.seq, col: int(b.pulse.col, 0, cols.length - 1), kind: b.pulse.kind }
          : null,
      interactive: b.interactive === true,
    };
  }
  if (m.phase === "over") {
    snap.replay = cleanReplay(m.replay);
    snap.results = Array.isArray(m.results)
      ? m.results.slice(0, MAX_PLAYERS).map((r) => {
          const index = int(r?.index, 0, players.length - 1);
          return {
            index,
            name: players[index]?.name ?? "Player",
            score: Math.max(0, Math.floor(Number(r?.score) || 0)),
            moves: Math.max(0, Math.floor(Number(r?.moves) || 0)),
            done: Math.max(0, Math.floor(Number(r?.done) || 0)),
            finished: Number.isInteger(r?.finished) && r.finished >= 0 ? r.finished : null,
          };
        })
      : [];
  }
  return snap;
}

async function join(input) {
  const code = normaliseCode(input);
  if (!isValidCode(code)) {
    renderStatus({ status: "error", message: `A code is ${CODE_LENGTH} characters.` });
    return;
  }
  guestCode = code;
  role = "guest";
  guest?.close();
  guest = new Guest();
  const mine = guest;
  guest.addEventListener("status", ({ detail }) => {
    if (guest !== mine) return;
    renderStatus(detail);
    if (detail.status === "connected") rejoins = 0;
    // Back by itself after a drop, a few times; never after unreachable,
    // since the network has not changed.
    if (detail.status === "dropped" && rejoins < 5) {
      rejoins += 1;
      setTimeout(() => guest === mine && join(guestCode), 1500);
    }
  });
  guest.addEventListener("message", ({ detail: { message } }) => {
    if (guest !== mine) return;
    lastHeard = Date.now();
    if (message.type === "state") {
      const snap = cleanSnapshot(message);
      if (snap) renderParty(snap);
    } else if (message.type === "full") renderStatus({ status: "error", message: "This party is full: four players at most." });
    else if (message.type === "started") renderStatus({ status: "error", message: "That game has already started. Join when it is back in the lobby." });
    else if (message.type === "reload") renderStatus({ status: "error", message: "The host is on a newer version. Reload this page to join." });
  });

  if (!$("partyChoose").hidden) $("partyStatus").textContent = "Connecting.";
  const name = cleanText($("joinName").value, 20) || getSettings().name || "";
  try {
    await guest.connect(code, { cid: clientId(), name });
    store.set(LAST_CODE_KEY, code);
  } catch {
    renderStatus({ status: "error", message: "Could not load pairing. Check your connection." });
  }
  clearInterval(staleTimer);
  staleTimer = setInterval(() => {
    if (guest?.status !== "connected") return;
    guest.send({ type: "ping" });
    $("partyStale").hidden = Date.now() - lastHeard < STALE_MS;
  }, 1000);
}

function guestLeave() {
  guest?.leave();
  guest = null;
  role = null;
  clearInterval(staleTimer);
  store.remove(LAST_CODE_KEY);
  wakeLock(false);
  showChoose();
}

/* ---- the choose panel ---- */

function showChoose() {
  showView("party");
  showPanel("partyChoose");
  $("partyStatus").textContent = navigator.onLine === false ? "Party games need a connection to pair." : "";
  $("partyStale").hidden = true;
  if (!$("joinName").value) $("joinName").value = getSettings().name ?? "";
}

export function openParty() {
  if (!role) {
    showChoose();
    return;
  }
  showView("party");
  if (role === "host") broadcast();
  else if (snapNow) renderParty(snapNow);
}

// Picks a party back up on load: a host's game in this tab, or a join link.
// True when the page opens on the party.
export function resumeParty() {
  const code = normaliseCode(new URLSearchParams(location.search).get("id"));
  if (location.pathname === "/join") {
    history.replaceState(null, "", "/");
    showChoose();
    $("joinCode").value = code;
    if (isValidCode(code)) join(code);
    return true;
  }
  let saved = null;
  try {
    saved = sessionStorage.getItem(PARTY_KEY);
  } catch {
    saved = null;
  }
  if (saved) {
    showView("party");
    startHosting();
    return true;
  }
  return false;
}

export function initParty({ board: b, replayer: r }) {
  board = b;
  replayer = r;
  const remembered = store.get(LAST_CODE_KEY) ?? "";
  if (remembered) $("joinCode").value = remembered;

  $("hostBtn").addEventListener("click", () => startHosting());
  $("joinForm").addEventListener("submit", (e) => {
    e.preventDefault();
    join($("joinCode").value);
  });
  $("partyStartBtn").addEventListener("click", hostStartGame);
  $("newCodeBtn").addEventListener("click", () => restartWithFreshCode());
  $("copyJoinBtn").addEventListener("click", async () => {
    const label = $("copyJoinLabel");
    label.textContent = (await copyText(joinLink(H.code))) ? "Copied" : "Copy failed";
    setTimeout(() => (label.textContent = "Copy link"), 2000);
  });
  const option = (id, attr, key, clean) =>
    $(id).addEventListener("click", (e) => {
      const btn = e.target.closest(`[data-${attr}]`);
      if (!btn || role !== "host" || H?.phase !== "lobby") return;
      H.options[key] = clean(btn.getAttribute(`data-${attr}`));
      saveParty();
      broadcast();
    });
  option("pFormat", "format", "format", (v) => (FORMATS.includes(v) ? v : "race"));
  option("pMode", "p-mode", "mode", cleanMode);
  option("pDifficulty", "difficulty", "difficulty", cleanDifficulty);
  const setLevel = (level) => {
    if (role !== "host" || H?.phase !== "lobby") return;
    H.options.level = cleanLevel(level);
    saveParty();
    broadcast();
  };
  $("pLevel").addEventListener("change", (e) => setLevel(e.target.value));
  $("pLevelDown").addEventListener("click", () => setLevel((H?.options.level ?? 1) - 1));
  $("pLevelUp").addEventListener("click", () => setLevel((H?.options.level ?? 1) + 1));
  document.querySelectorAll("[data-party-leave]").forEach((btn) =>
    btn.addEventListener("click", () => (role === "host" ? hostLeave() : guestLeave()))
  );
  $("pUndo").addEventListener("click", () => act({ act: "undo" }));
  $("pHint").addEventListener("click", () => act({ act: "hint" }));
  $("pExtra").addEventListener("click", () => act({ act: "extra" }));
  $("partyEndBtn").addEventListener("click", hostEnd);
  $("partyAgainBtn").addEventListener("click", hostAgain);
  $("partyReplayBtn").addEventListener("click", () => lastReplay && replayer.open(lastReplay, { verified: false }));
  $("partyShareBtn").addEventListener("click", () => lastReplay && shareReplay(lastReplay, null, $("partyShareLabel")));
  $("partyBackBtn").addEventListener("click", () => document.dispatchEvent(new CustomEvent("uwusort:home")));

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (role) wakeLock(true);
    if (role === "guest" && guest?.status === "dropped") join(guestCode);
  });
  document.addEventListener("uwusort:settings", () => {
    if (currentView() === "party") redraw();
  });
}

export const inParty = () => role !== null;
