// The Edge Tray, per edge-tray-spec.md: the app's global actions (full
// screen, party, leaderboard, settings, theme) as a column of glass buttons
// top right. The arrow tab beside it slides the column off the right edge
// and back. Whether it is open is remembered in this browser, and the
// pre-paint script in index.html applies a collapsed tray before first
// paint (spec section 6.4).
//
// Also full screen: the real thing where the browser allows it, filling
// the window where it does not (Safari on iPhone).

import { setIcon, store } from "./ui.js";

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

function initTray() {
  const open = store.get(TRAY_KEY) !== "0";
  setTray(open, { save: false });
  // After the first frame, so later toggles animate (spec section 6.4).
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("tray-start-collapsed")));
  $("trayTab").addEventListener("click", () => setTray($("tray").classList.contains("collapsed")));
}

/* ---- full screen ---- */

let fallback = false;

const canReallyGoFull = () => Boolean(document.fullscreenEnabled || document.webkitFullscreenEnabled);
const fullElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
export const isFull = () => Boolean(fullElement()) || fallback;

async function enter() {
  if (canReallyGoFull()) {
    try {
      await (root.requestFullscreen?.call(root, { navigationUI: "hide" }) ?? root.webkitRequestFullscreen?.call(root));
      return;
    } catch {
      // Refused: fill the window instead.
    }
  }
  fallback = true;
  syncFull();
}

async function leave() {
  fallback = false;
  if (fullElement()) {
    try {
      await (document.exitFullscreen?.call(document) ?? document.webkitExitFullscreen?.call(document));
    } catch {
      // Already out.
    }
  }
  syncFull();
}

function syncFull() {
  const full = isFull();
  root.classList.toggle("is-full", full);
  const btn = $("fullBtn");
  const label = full ? "Leave full screen" : "Full screen";
  btn.setAttribute("aria-label", label);
  btn.title = label;
  setIcon(btn, full ? "shrink" : "expand");
  window.dispatchEvent(new Event("resize"));
}

export function initTrayAndFullscreen() {
  initTray();
  $("fullBtn").addEventListener("click", () => (isFull() ? leave() : enter()));
  document.addEventListener("fullscreenchange", syncFull);
  document.addEventListener("webkitfullscreenchange", syncFull);
  document.addEventListener("keydown", (e) => {
    // Esc already leaves real full screen; this covers the window-filling kind.
    if (e.key === "Escape" && fallback && !document.body.classList.contains("modal-open")) leave();
  });
  syncFull();
}
