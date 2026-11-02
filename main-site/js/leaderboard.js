// The leaderboard window. Water and Bolts each have their own three boards,
// one row per name, after MRT Station Guesser's:
//   Best score    each name's single best level
//   Total points  every level added under a name, added up
//   Top level     each name's highest level finished in order, per difficulty

import { api } from "./api.js";
import { DIFFICULTIES, MODES } from "./rules.js";
import { getSettings } from "./settings.js";
import { escapeHtml, openModal } from "./ui.js";

const BOARDS = {
  best: {
    head: ["#", "Name", "Score"],
    row: (e) => [e.rank, e.name, e.score],
    about: "Each name's single best level.",
  },
  total: {
    head: ["#", "Name", "Total", "Levels"],
    row: (e) => [e.rank, e.name, e.total, e.levels],
    about: "Every level added under a name, scores added up.",
  },
  level: {
    head: ["#", "Name", "Level"],
    row: (e) => [e.rank, e.name, e.level],
    about: "Each name's highest level finished on this difficulty, with every level before it finished in the same browser.",
  },
};

let mode = "water";
let board = "best";
let difficulty = "easy";
let loading = 0;

function press(selector, attr, value) {
  document.querySelectorAll(selector).forEach((el) => {
    const on = el.dataset[attr] === value;
    el.classList.toggle("active", on);
    el.setAttribute("aria-selected", String(on));
  });
}

function sync() {
  press("#boardModes [data-lb-mode]", "lbMode", mode);
  press("#boardTabs [data-board]", "board", board);
  press("#boardDifficulty [data-lb-difficulty]", "lbDifficulty", difficulty);
  document.getElementById("boardDifficulty").hidden = board !== "level";
}

async function load() {
  const body = document.getElementById("boardBody");
  const note = document.getElementById("boardNote");
  const ticket = ++loading;
  const spec = BOARDS[board];
  body.setAttribute("aria-busy", "true");
  note.textContent = `${MODES[mode].label}${board === "level" ? `, ${DIFFICULTIES[difficulty].label}` : ""}. ${spec.about}`;
  body.innerHTML = `<p class="board-empty">Loading.</p>`;

  try {
    const data = await api.leaderboard(mode, board, difficulty);
    if (ticket !== loading) return;
    const entries = data.entries ?? [];
    const me = getSettings().name?.toLowerCase();
    body.innerHTML = entries.length
      ? `<table class="board-table">
          <thead><tr>${spec.head.map((h) => `<th scope="col">${h}</th>`).join("")}</tr></thead>
          <tbody>${entries
            .map(
              (e) =>
                `<tr${me && e.name.toLowerCase() === me ? ' class="me"' : ""}>${spec
                  .row(e)
                  .map((v) => `<td>${escapeHtml(v)}</td>`)
                  .join("")}</tr>`
            )
            .join("")}</tbody>
        </table>`
      : `<p class="board-empty">No levels here yet. Finish one and it is added under your name.</p>`;
  } catch (err) {
    if (ticket !== loading) return;
    body.innerHTML = `<p class="board-empty">${
      err.code === "offline" ? "The leaderboard needs a connection." : "The leaderboard did not load. Try again in a moment."
    }</p>`;
  } finally {
    if (ticket === loading) body.removeAttribute("aria-busy");
  }
}

export function openLeaderboard(which = {}) {
  const s = getSettings();
  mode = which.mode ?? s.mode ?? mode;
  difficulty = which.difficulty ?? s.difficulty ?? difficulty;
  board = which.board ?? board;
  sync();
  openModal("boardModal");
  load();
}

export function initLeaderboard() {
  const wire = (id, attr, set) =>
    document.getElementById(id).addEventListener("click", (e) => {
      const tab = e.target.closest(`[data-${attr}]`);
      if (!tab) return;
      set(tab.dataset[attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase())]);
      sync();
      load();
    });
  wire("boardModes", "lb-mode", (v) => (mode = MODES[v] ? v : "water"));
  wire("boardTabs", "board", (v) => (board = BOARDS[v] ? v : "best"));
  wire("boardDifficulty", "lb-difficulty", (v) => (difficulty = DIFFICULTIES[v] ? v : "easy"));
}
