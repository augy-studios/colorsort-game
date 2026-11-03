// Service worker for uwuSort.
//
// BUMP VERSION ON EVERY CHANGE TO THIS SITE. Not only when this file
// changes: any edit under main-site/ is a new build, and the browser only
// sees an update when this file differs byte for byte.
//
// What happens to each request:
//
//   navigation              the shell this worker owns, network if absent;
//                           /join and /r/<id> are the game page too
//   /api/                   not intercepted: timed levels, recording levels,
//                           the leaderboard and short replay links need the
//                           network
//   same origin assets      cache first
//   other cross origin      not intercepted (analytics, ads, the PeerJS broker)
//   anything but GET        not intercepted
//
// Everything the site serves is precached, so the whole game plays offline
// from the first visit: three.js and PeerJS are vendored for exactly this,
// and the Jua font is self-hosted. Levels finished offline wait in the
// page's queue (js/queue.js), not here.
//
// Rules that are easy to break here:
//
// 1. skipWaiting and clients.claim happen only when a person presses Reload
//    on the update bar, which posts 'skip-waiting'. Neither appears in
//    install or activate. scripts/check-sw.mjs fails if that stops being true.
//
// 2. Navigations are answered from this worker's own shell, not the network.
//    The shell's modules are cache first, so a network page would pair a new
//    index.html with the previous build's JavaScript. New versions arrive
//    through the update bar, all at once.
//
// 3. Precache entries are fetched with cache: 'reload', each on its own. addAll
//    fails the whole install on one bad path, and without 'reload' a bumped
//    worker can fill its new cache from the HTTP cache's old files.
//
// 4. Nothing under /api/ is ever cached. A cached leaderboard is a wrong
//    answer, not a stale one, and a cached level start would be somebody
//    else's.

const VERSION = "uwusort-v10";

const SHELL = `uwusort-shell-${VERSION}`;

// Everything else is deleted on activate, including the template's old
// "uwusort-v1" cache.
const KEEP = new Set([SHELL]);

// Addresses the browser asks for. "/index.html" is absent because cleanUrls
// redirects it to "/", and a redirected response cannot answer a
// navigation. 404.html is absent: offline, an unknown path gets the game.
const PRECACHE = [
  "/",

  "/css/theme.css",
  "/css/style.css",

  "/js/api.js",
  "/js/app.js",
  "/js/board.js",
  "/js/board3d.js",
  "/js/confetti.js",
  "/js/game.js",
  "/js/icons.js",
  "/js/leaderboard.js",
  "/js/p2p.js",
  "/js/palette.js",
  "/js/party.js",
  "/js/puzzle.js",
  "/js/qr.js",
  "/js/queue.js",
  "/js/replay-format.js",
  "/js/replay.js",
  "/js/rules.js",
  "/js/seed.js",
  "/js/settings.js",
  "/js/theme.js",
  "/js/tray.js",
  "/js/ui.js",
  "/js/update-bar.js",

  "/vendor/three/build/three.module.js",
  "/vendor/three/build/three.core.js",
  "/vendor/peerjs/peerjs.min.js",

  "/fonts/jua-latin.woff2",

  "/manifest.json",
  "/favicon.ico",
  "/UCS-192.png",
  "/UCS-512.png",
  "/UCS-main.png",
  "/images/screenshot_1.png",
  "/images/screenshot_2.png",
];

const PARALLEL = 6;

self.addEventListener("install", (event) => {
  event.waitUntil(fillShell());
  // No skipWaiting. The new worker waits until somebody accepts the update.
});

async function fillShell() {
  const cache = await caches.open(SHELL);
  const failed = [];
  const queue = [...PRECACHE];

  const worker = async () => {
    while (queue.length) {
      const path = queue.shift();
      try {
        const response = await fetch(new Request(path, { cache: "reload" }));
        if (!response.ok) throw new Error(`${response.status}`);
        if (response.redirected) throw new Error("redirected");
        await cache.put(path, response);
      } catch (cause) {
        failed.push(`${path} (${cause?.message ?? cause})`);
      }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));

  if (failed.length) {
    console.warn(
      `[uwusort] ${failed.length} of ${PRECACHE.length} precache entries failed. ` +
        `Offline is degraded, not off:\n  ${failed.join("\n  ")}`
    );
  }
}

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => !KEEP.has(key)).map((key) => caches.delete(key)));
    })()
  );
  // No clients.claim, for the same reason there is no skipWaiting above.
});

self.addEventListener("message", (event) => {
  const data = event.data;
  const type = typeof data === "string" ? data : data?.type;

  if (type === "version") {
    event.source?.postMessage({ type: "version", version: VERSION });
    return;
  }

  // The only way either of these is ever called. js/update-bar.js posts it
  // when the reader presses Reload, and reloads on controllerchange.
  if (type === "skip-waiting") {
    event.waitUntil(self.skipWaiting().then(() => self.clients.claim()));
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  if (request.headers.has("range")) return;

  const url = new URL(request.url);

  // Analytics, ads and the PeerJS broker go straight to the network, and
  // simply fail offline.
  if (url.origin !== self.location.origin) return;

  // The API: network only, and the page says so offline.
  if (url.pathname.startsWith("/api/")) return;

  event.respondWith(request.mode === "navigate" ? navigation(request, url) : staticAsset(request, url));
});

async function navigation(request, url) {
  const shell = await caches.open(SHELL);

  // A join link and a short replay link open the game page, which reads its
  // own address.
  const page = url.pathname === "/join" || /^\/r\/[A-Za-z0-9]{8}\/?$/.test(url.pathname) ? "/" : url.pathname;
  const own = await shell.match(page);
  if (own) return own;

  try {
    return await fetch(request);
  } catch {
    // Offline and not a page this worker holds: the game is the only page.
    return (await shell.match("/")) ?? Response.error();
  }
}

async function staticAsset(request, url) {
  const shell = await caches.open(SHELL);

  const cached = await shell.match(url.pathname);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (isCacheable(response)) await shell.put(url.pathname, response.clone());
    return response;
  } catch {
    return new Response("Offline", { status: 503 });
  }
}

// Whether a same origin response may be stored. Every shell write after
// install goes through here.
function isCacheable(response) {
  if (!response || response.status !== 200) return false;
  if (response.type !== "basic" && response.type !== "default") return false;
  if (response.redirected) return false;

  const control = (response.headers.get("Cache-Control") ?? "").toLowerCase();
  if (control.includes("no-store") || control.includes("private")) return false;

  return true;
}
