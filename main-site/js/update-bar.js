// Update prompt bar, per update-bar-spec.md.
//
// A new worker never activates on its own. It downloads, installs, and
// waits. The only thing that promotes it is a person pressing Reload.
// Nothing here reloads on a timer.
//
// The bar sits at the top of the page, in the flow, and publishes its height
// as --banner-h so the Edge Tray starts below it (edge-tray-spec.md, section 6.3).

import { escapeHtml } from "./ui.js";

const SW_URL = "/sw.js";

const COPY = {
  label: "Update",
  ready: "A new version of uwuSort is ready.",
  reload: "Reload",
  later: "Not now",
};

let registration = null;
let waitingWorker = null;
let reloading = false;
let dismissed = false;

const sizer = "ResizeObserver" in window ? new ResizeObserver(() => syncHeight()) : null;

function syncHeight() {
  const bar = document.querySelector(".update-notice");
  document.documentElement.style.setProperty("--banner-h", `${bar ? bar.offsetHeight : 0}px`);
}

function render() {
  const existing = document.querySelector(".update-notice");

  if (!waitingWorker || dismissed) {
    if (existing) {
      sizer?.unobserve(existing);
      existing.remove();
    }
    syncHeight();
    return;
  }

  const bar = existing ?? document.createElement("div");
  bar.className = "update-notice";
  // role="status", not role="alert". Nothing is wrong.
  bar.setAttribute("role", "status");
  bar.setAttribute("aria-label", COPY.label);
  bar.innerHTML = `
    <div class="update-notice-inner">
      <p>${escapeHtml(COPY.ready)}</p>
      <button type="button" class="btn btn-primary" data-sw-update>
        ${escapeHtml(COPY.reload)}
      </button>
      <button type="button" class="btn btn-quiet" data-sw-later>
        ${escapeHtml(COPY.later)}
      </button>
    </div>
  `;

  bar.querySelector("[data-sw-update]").addEventListener("click", () => {
    // The only place anything asks for skipWaiting. The reload happens on
    // controllerchange, not here.
    waitingWorker?.postMessage("skip-waiting");
  });

  bar.querySelector("[data-sw-later]").addEventListener("click", () => {
    // This page view only. Never stored: persisting it would mean somebody
    // who dismisses once never hears about an update again.
    dismissed = true;
    render();
  });

  if (!existing) {
    document.body.prepend(bar);
    sizer?.observe(bar);
  }
  syncHeight();
}

function watchForUpdate() {
  if (!registration) return;

  // A worker already waiting when the page opened. The ordinary case on the
  // second page view after a deploy.
  if (registration.waiting && navigator.serviceWorker.controller) {
    waitingWorker = registration.waiting;
    render();
  }

  registration.addEventListener("updatefound", () => {
    const installing = registration.installing;
    if (!installing) return;

    installing.addEventListener("statechange", () => {
      // `installed` with no controller is a first install, which has no
      // previous version on screen to protect and nothing to prompt about.
      if (installing.state === "installed" && navigator.serviceWorker.controller) {
        waitingWorker = registration.waiting ?? installing;
        render();
      }
    });
  });

  // A game is often left open for a long time. Coming back to the tab asks
  // for the worker again, at most hourly, so a deploy reaches that player
  // through the updatefound path rather than on their next visit.
  let lastCheck = Date.now();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || Date.now() - lastCheck < 60 * 60 * 1000) return;
    lastCheck = Date.now();
    registration.update().catch(() => {});
  });
}

function registerWorker() {
  if (!("serviceWorker" in navigator)) return;

  navigator.serviceWorker
    .register(SW_URL)
    .then((reg) => {
      registration = reg;
      watchForUpdate();
    })
    .catch((cause) => {
      // A refused registration is not a reason to break the page.
      console.warn("service worker registration failed:", cause);
    });

  // Reloading here rather than in the click handler is what brings the page
  // back on the new version. The flag stops a second event reload-looping.
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}

export function initUpdateBar() {
  // On load, not immediately, so precaching does not compete with the
  // page's own first fetches.
  if (document.readyState === "complete") registerWorker();
  else window.addEventListener("load", registerWorker, { once: true });
}
