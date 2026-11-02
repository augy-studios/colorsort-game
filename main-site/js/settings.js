// Player settings, kept in this browser, after MRT Station Guesser's. The
// game reads them through getSettings() and hears about changes on the
// "uwusort:settings" event.
//
// The leaderboard name is asked for before the first level (askName()), so
// every level after it goes on the boards under that name and its progress
// is tracked from the start. Offline, a name is kept after the same check
// the server makes on letters and length; the server's word filter sees it
// when the first level is sent, and the queue says if it was refused.

import { api } from "./api.js";
import { cleanDifficulty, cleanMode } from "./rules.js";
import { closeModal, openModal, store } from "./ui.js";

const STORAGE = "uwusort.settings";

const DEFAULTS = {
  name: null,
  asked_name: false,
  auto_submit: true,
  auto_replay: false,
  confirm_costs: true,
  symbols: true,
  view: "3d",
  mode: "water",
  difficulty: "easy",
};

let current = null;

function load() {
  let saved = {};
  try {
    saved = JSON.parse(store.get(STORAGE) ?? "{}") ?? {};
  } catch {
    // Unreadable: the defaults.
  }
  const out = { ...DEFAULTS };
  if (typeof saved.name === "string" && saved.name.trim()) out.name = saved.name.trim();
  for (const key of ["asked_name", "auto_submit", "auto_replay", "confirm_costs", "symbols"]) {
    if (typeof saved[key] === "boolean") out[key] = saved[key];
  }
  out.view = saved.view === "flat" ? "flat" : "3d";
  out.mode = cleanMode(saved.mode);
  out.difficulty = cleanDifficulty(saved.difficulty);
  return out;
}

export function getSettings() {
  current ??= load();
  return { ...current };
}

export function saveSettings(changes) {
  current = { ...getSettings(), ...changes };
  store.set(STORAGE, JSON.stringify(current));
  render();
  document.dispatchEvent(new CustomEvent("uwusort:settings", { detail: getSettings() }));
  return getSettings();
}

const $ = (id) => document.getElementById(id);

// The server's own rule for letters and length, for checking a name
// offline. The word filter stays on the server.
const NAME_SHAPE = /^(?:[\p{L}\p{N}]\p{M}{0,2}|[ _-])+$/u;

function localName(value) {
  const name = Array.from(String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim()).slice(0, 20).join("").trim();
  if (!name) return { error: "Enter a name." };
  if (!NAME_SHAPE.test(name) || !/[\p{L}\p{N}]/u.test(name)) return { error: "Use letters, numbers, spaces, hyphens and underscores only." };
  return { name };
}

// Checked by the API when online; kept on the local check when not.
async function checkName(value) {
  const local = localName(value);
  if (local.error) return local;
  try {
    const result = await api.checkName(local.name);
    return { name: result.name };
  } catch (err) {
    // Only the server saying no is a no. Offline, or the API down, the name
    // is kept and checked when the first level is sent.
    if (err.status === 400) return { error: err.message || "Pick a different name." };
    return { name: local.name, offline: true };
  }
}

function render() {
  const s = getSettings();
  $("clearNameBtn").classList.toggle("hidden", !s.name);
  $("savedName").textContent = `Now: ${s.name ?? "Not set"}`;

  document.querySelectorAll("#settingsModal [data-setting]").forEach((el) => {
    const on = s[el.dataset.setting];
    el.setAttribute("aria-checked", String(on));
    el.querySelector(".switch-state").textContent = on ? "On" : "Off";
  });
  document.querySelector('[data-setting="auto_submit"]').disabled = !s.name;
  $("autoNote").classList.toggle("hidden", Boolean(s.name));

  document.querySelectorAll("#viewToggle [data-view]").forEach((el) => {
    const on = el.dataset.view === s.view;
    el.classList.toggle("active", on);
    el.setAttribute("aria-pressed", String(on));
  });
}

async function onSaveName(event) {
  event.preventDefault();
  const input = $("settingsName");
  const msg = $("nameMsg");
  $("saveNameBtn").disabled = true;
  msg.textContent = "";
  const result = await checkName(input.value);
  $("saveNameBtn").disabled = false;
  if (result.error) {
    msg.textContent = result.error;
    input.focus();
    return;
  }
  saveSettings({ name: result.name, asked_name: true });
  input.value = "";
  msg.textContent = result.offline ? "Saved. It is checked when you are back online." : "Saved.";
}

export function openSettings() {
  $("nameMsg").textContent = "";
  $("settingsName").value = "";
  render();
  openModal("settingsModal");
}

/* ---- the name, before the first level ---- */

let pendingAsk = null;

// Resolves once there is a name, or the player chose to play without one.
// Asks once per browser; Settings changes it later.
export function askName() {
  const s = getSettings();
  if (s.name || s.asked_name) return Promise.resolve(s.name);
  if (pendingAsk) return pendingAsk.promise;
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  pendingAsk = { promise, resolve };
  $("gateMsg").textContent = "";
  $("gateName").value = "";
  openModal("nameModal");
  setTimeout(() => $("gateName").focus(), 50);
  return promise;
}

function finishAsk(name) {
  closeModal("nameModal");
  const p = pendingAsk;
  pendingAsk = null;
  p?.resolve(name);
}

export function initSettings() {
  $("nameForm").addEventListener("submit", onSaveName);
  $("clearNameBtn").addEventListener("click", () => {
    saveSettings({ name: null });
    $("nameMsg").textContent = "Name cleared. Levels from now on are not added to the leaderboard.";
  });
  document.querySelectorAll("#settingsModal [data-setting]").forEach((el) => {
    el.addEventListener("click", () => saveSettings({ [el.dataset.setting]: !getSettings()[el.dataset.setting] }));
  });
  $("viewToggle").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-view]");
    if (btn) saveSettings({ view: btn.dataset.view === "flat" ? "flat" : "3d" });
  });

  $("gateForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("gateSave").disabled = true;
    $("gateMsg").textContent = "Checking.";
    const result = await checkName($("gateName").value);
    $("gateSave").disabled = false;
    if (result.error) {
      $("gateMsg").textContent = result.error;
      $("gateName").focus();
      return;
    }
    saveSettings({ name: result.name, asked_name: true, auto_submit: true });
    finishAsk(result.name);
  });
  $("gateSkip").addEventListener("click", () => {
    saveSettings({ asked_name: true });
    finishAsk(null);
  });
  // Closing the window any other way is the same as playing without a name
  // for now; it asks again next time.
  document.getElementById("nameModal").addEventListener("uwusort:closed", () => {
    if (pendingAsk) {
      const p = pendingAsk;
      pendingAsk = null;
      p.resolve(null);
    }
  });
  render();
}
