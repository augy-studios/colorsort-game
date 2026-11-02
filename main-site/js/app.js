import { COLOR_THEMES, applyColorTheme, applyMode, getStoredColorTheme, getStoredMode, getModePreference, initTheme } from "./theme.js";
import { closeModal, closeTopModal, currentView, hydrateIcons, openModal, showView } from "./ui.js";
import { initUpdateBar } from "./update-bar.js";
import { Board } from "./board.js";
import { backToResult, initGame, pause, playSeed, toSetup, toggleAutoplay } from "./game.js";
import { initLeaderboard, openLeaderboard } from "./leaderboard.js";
import { getSettings, initSettings, openSettings } from "./settings.js";
import { initParty, inParty, openParty, resumeParty } from "./party.js";
import { ReplayPlayer, replayFromLocation } from "./replay.js";
import { initTrayAndFullscreen } from "./tray.js";
import { initQueue } from "./queue.js";

/* Theme modal, per uwuapps-theme.md section 6. */

function buildThemeModal() {
  const grid = document.getElementById("swatchGrid");
  grid.innerHTML = COLOR_THEMES.map(
    (t) => `
      <button class="swatch" data-theme-id="${t.id}" style="--swatch-color:${t.hex}" type="button" aria-label="${t.label}">
        <span class="swatch-dot"></span>
        <span class="swatch-label">${t.label}</span>
      </button>`
  ).join("");

  syncThemeModalState();

  grid.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-theme-id]");
    if (!btn) return;
    applyColorTheme(btn.dataset.themeId);
    syncThemeModalState();
  });

  document.getElementById("modeToggle").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-mode]");
    if (!btn) return;
    applyMode(btn.dataset.mode);
    syncThemeModalState();
  });

  // A tab left open across 09:00 or 18:00 re-resolves itself; redraw the
  // modal so the note and pressed state stay in step with the change.
  document.addEventListener("uwu:modechange", syncThemeModalState);
}

function syncThemeModalState() {
  const activeTheme = getStoredColorTheme();
  const activePreference = getModePreference();
  const resolvedMode = getStoredMode();

  document.querySelectorAll("#swatchGrid .swatch").forEach((el) => {
    el.classList.toggle("active", el.dataset.themeId === activeTheme);
  });
  document.querySelectorAll("#modeToggle .mode-btn").forEach((el) => {
    const isActive = el.dataset.mode === activePreference;
    el.classList.toggle("active", isActive);
    el.setAttribute("aria-pressed", String(isActive));
  });

  const note = document.getElementById("modeNote");
  if (note) {
    note.hidden = activePreference !== "time";
    if (activePreference === "time") {
      note.textContent = `Following the clock. Currently ${resolvedMode}.`;
    }
  }

  updateThemeButtonIcon();
}

function updateThemeButtonIcon() {
  const span = document.querySelector("#themeBtn [data-icon]");
  span.setAttribute("data-icon", getStoredMode() === "dark" ? "moon" : "sun");
  hydrateIcons(document.getElementById("themeBtn"));
}

function wireModals() {
  document.querySelectorAll("[data-close-modal]").forEach((btn) => {
    btn.addEventListener("click", () => closeModal(btn.dataset.closeModal));
  });
  document.querySelectorAll(".modal-backdrop").forEach((backdrop) => {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeModal(backdrop.id);
    });
  });
  document.addEventListener("keydown", (e) => {
    // Handled, so nothing else takes the same Esc.
    if (e.key === "Escape" && closeTopModal()) e.preventDefault();
  });

  // Every window stops a level's clock first. Closing it leaves the level
  // paused, so the columns are not studied behind a window.
  const pausing = (open) => () => {
    pause();
    open();
  };
  document.getElementById("themeBtn").addEventListener("click", pausing(() => openModal("themeModal")));
  document.getElementById("boardBtn").addEventListener("click", pausing(() => openLeaderboard()));
  document.getElementById("settingsBtn").addEventListener("click", pausing(openSettings));
  document.getElementById("resultBoardBtn").addEventListener("click", () => openLeaderboard({ board: "best" }));
  document.getElementById("setupBoardBtn").addEventListener("click", () => openLeaderboard());
}

// Autoplay has no button and no hint anywhere. F2 on a keyboard; three
// quick taps on the game's name in the corner on a touch screen.
function wireAutoplay() {
  document.addEventListener("keydown", (e) => {
    if (e.key !== "F2" || currentView() !== "play" || document.body.classList.contains("modal-open")) return;
    e.preventDefault();
    toggleAutoplay();
  });
  const TAPS = 3;
  const WINDOW_MS = 650;
  let taps = [];
  document.getElementById("brandName").addEventListener("pointerdown", (e) => {
    const now = e.timeStamp;
    taps = taps.filter((t) => now - t < WINDOW_MS);
    taps.push(now);
    if (taps.length >= TAPS) {
      taps = [];
      toggleAutoplay();
    }
  });
}

function goHome() {
  pause();
  toSetup();
}

function boot() {
  initTheme();
  hydrateIcons();
  updateThemeButtonIcon();
  buildThemeModal();
  wireModals();
  initTrayAndFullscreen();
  initLeaderboard();
  initSettings();
  initQueue();

  const board = new Board(document.createElement("div"), {
    onFallback: () => {
      document.getElementById("viewNote").textContent = "3D is not available in this browser, so the board is flat.";
    },
  });
  board.setView(getSettings().view === "3d");
  document.addEventListener("uwusort:settings", (e) => board.setView(e.detail.view === "3d"));

  const replayer = new ReplayPlayer({
    board,
    onPlaySeed: (seed) => {
      history.replaceState(null, "", "/");
      playSeed(seed);
    },
    onClose: (back) => {
      if (back === "result" && backToResult()) return;
      if (back === "party" && inParty()) {
        openParty();
        return;
      }
      toSetup();
    },
  });

  initGame({ board, replayer });
  initParty({ board, replayer });
  wireAutoplay();
  document.getElementById("partyBtn").addEventListener("click", () => {
    pause();
    openParty();
  });
  document.getElementById("setupPartyBtn").addEventListener("click", openParty);
  document.addEventListener("uwusort:home", goHome);

  // A replay link or a join link opens on that; a host's party in this tab
  // carries on; otherwise choosing a level.
  const link = replayFromLocation();
  if (link) replayer.open(link.id ? { id: link.id } : link, { verified: false });
  else if (!resumeParty()) {
    toSetup();
    showView("setup");
  }
  if (currentView() === "setup") document.getElementById("startBtn").focus({ preventScroll: true });

  initUpdateBar();
}

boot();
