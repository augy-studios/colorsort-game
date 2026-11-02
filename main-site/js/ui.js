import { icon } from "./icons.js";

// Safe to call repeatedly; re-renders when data-icon changes.
export function hydrateIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((el) => {
    const name = el.dataset.icon;
    if (el.dataset.iconRendered === name) return;
    el.innerHTML = icon(name);
    el.dataset.iconRendered = name;
  });
}

export function setIcon(el, name) {
  const span = el.matches("[data-icon]") ? el : el.querySelector("[data-icon]");
  if (!span) return;
  span.setAttribute("data-icon", name);
  hydrateIcons(el);
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// localStorage that never throws: blocked or full storage keeps the value
// for this page view only, which is all a convenience setting needs.
const memory = new Map();
export const store = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return memory.get(key) ?? null;
    }
  },
  set(key, value) {
    memory.set(key, value);
    try {
      localStorage.setItem(key, value);
    } catch {
      // This page view only.
    }
  },
  remove(key) {
    memory.delete(key);
    try {
      localStorage.removeItem(key);
    } catch {
      // As above.
    }
  },
};

// Which card the page shows: choosing a level, a level in play, its
// result, a party game, or a replay. "uwusort:view" tells anything that cares, such as
// the game's clock, which pauses while the game is out of sight.
const VIEWS = ["setup", "play", "result", "party", "replay"];
let view = "setup";

export function showView(name) {
  if (!VIEWS.includes(name)) return;
  for (const id of VIEWS) document.getElementById(id).hidden = id !== name;
  if (view === name) return;
  view = name;
  document.dispatchEvent(new CustomEvent("uwusort:view", { detail: name }));
}

export const currentView = () => view;

// Focus goes into the modal on open and back to the opener on close.
const openers = new Map();

export function openModal(id) {
  const backdrop = document.getElementById(id);
  openers.set(id, document.activeElement);
  backdrop.classList.remove("hidden");
  document.body.classList.add("modal-open");
  backdrop.querySelector("button, [href], input")?.focus();
}

export function closeModal(id) {
  const backdrop = document.getElementById(id);
  if (backdrop.classList.contains("hidden")) return;
  backdrop.classList.add("hidden");
  backdrop.dispatchEvent(new CustomEvent("uwusort:closed"));
  if (!document.querySelector(".modal-backdrop:not(.hidden)")) {
    document.body.classList.remove("modal-open");
  }
  openers.get(id)?.focus?.();
  openers.delete(id);
}

export function closeTopModal() {
  const open = [...document.querySelectorAll(".modal-backdrop:not(.hidden)")].pop();
  if (!open) return false;
  closeModal(open.id);
  return true;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers and insecure contexts: the hidden textarea way.
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

// Through the share sheet where there is one, the clipboard otherwise.
export async function shareLink(url, title) {
  if (navigator.share) {
    try {
      await navigator.share({ title, url });
      return "shared";
    } catch (err) {
      if (err?.name === "AbortError") return "cancelled";
    }
  }
  return (await copyText(url)) ? "copied" : "failed";
}

// "1:05" from milliseconds.
export function formatTime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
