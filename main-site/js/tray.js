// The Edge Tray, per edge-tray-spec.md: the app's global actions (party,
// leaderboard, settings, theme) as a column of glass buttons top right. The
// arrow tab beside it slides the column off the right edge and back. Whether
// it is open is remembered in this browser, and the pre-paint script in
// index.html applies a collapsed tray before first paint (spec section 6.4).

import { store } from "./ui.js";

const TRAY_KEY = "uwusort.trayOpen";

const $ = (id) => document.getElementById(id);
const root = document.documentElement;

/* ---- the tray (spec section 6.1) ---- */

function setTray(open, { save = true } = {}) {
  $("tray").classList.toggle("collapsed", !open);
  $("trayTab").setAttribute("aria-expanded", String(open));
  const label = open ? "Hide menu" : "Show menu";
  $("trayTab").setAttribute("aria-label", label);
  $("trayTab").title = label;
  // Off-screen buttons must not take focus or clicks.
  $("trayButtons").inert = !open;
  document.body.classList.toggle("tray-open", open);
  if (save) store.set(TRAY_KEY, open ? "1" : "0");
}

export function initTray() {
  const open = store.get(TRAY_KEY) !== "0";
  setTray(open, { save: false });
  // After the first frame, so later toggles animate (spec section 6.4).
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("tray-start-collapsed")));
  $("trayTab").addEventListener("click", () => setTray($("tray").classList.contains("collapsed")));
}
