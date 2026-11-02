// POST /api/play/record
//   { client_key, play_id, seed, run_id?, log, duration_ms, at?, name? }
//   -> { play_id, score, in_order, timed, name?, best_score?, rank?, total?,
//        levels?, total_rank?, top_level?, level_rank?, name_refused? }
//
// Every finished level a browser played without autoplay, on a seed the
// game dealt, comes here: straight away online, from the page's queue once
// it is back online otherwise (js/queue.js). The level runs in the browser,
// so what arrives is its log. The server replays it from the seed with
// js/rules.js, the module the game plays by, works the score out itself,
// and refuses anything real play could not have made (checkGame there).
//
// With run_id, the level is the one the server dealt and timed, and earns
// speed bonuses; without, it was played offline and earns none.
//
// A name, if sent, puts the level on the boards straight away. A name the
// word filter refuses fails the whole request with a 400 before anything is
// recorded, so the queue can send the level again without it.

import { clientKey, endpoint, HttpError, uuid } from "../_lib/http.js";
import { cleanName } from "../_lib/names.js";
import { namePlay, recordPlay } from "../_lib/plays.js";

export default endpoint("POST", async ({ body }) => {
  const key = clientKey(body.client_key);
  const id = uuid(body.play_id, "bad_play_id");
  const runId = body.run_id ? uuid(body.run_id, "bad_run_id") : null;
  const name = body.name ? cleanName(body.name) : null;
  if (!Number.isInteger(body.duration_ms)) throw new HttpError(400, "bad_duration");
  const playedAt = typeof body.at === "string" && !Number.isNaN(Date.parse(body.at)) ? new Date(body.at).toISOString() : null;

  const recorded = await recordPlay({ id, key, seedText: body.seed, runId, log: body.log, durationMs: body.duration_ms, playedAt });
  const out = { play_id: id, score: recorded.score, in_order: recorded.in_order, timed: recorded.timed };
  if (!name) return out;

  try {
    return { ...out, ...(await namePlay({ id, key, name, retry: recorded.status === "duplicate" })) };
  } catch (err) {
    // Recorded either way: the level still counts towards this browser's
    // chain. Only the name did not go on.
    if (err instanceof HttpError && err.code !== "server") return { ...out, name_refused: err.code, message: err.message };
    throw err;
  }
});
