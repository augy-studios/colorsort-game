// POST /api/run/start  { client_key, mode, difficulty, level }
//   -> { run_id, seed, expires_in }
// Deals a timed level: the server picks the seed and starts its clock. A
// level finished under a run is held to this seed and to the time the
// server saw pass, and so may earn speed bonuses.

import { randomInt } from "node:crypto";
import { clientKey, endpoint } from "../_lib/http.js";
import { rest, rpc } from "../_lib/supabase.js";
import { RUN_TTL_MS, cleanDifficulty, cleanLevel, cleanMode } from "../../js/rules.js";
import { newSeed } from "../../js/seed.js";

export default endpoint("POST", async ({ body }) => {
  const key = clientKey(body.client_key);
  const mode = cleanMode(body.mode);
  const difficulty = cleanDifficulty(body.difficulty);
  const level = cleanLevel(body.level);
  const seed = newSeed(mode, difficulty, level, () => randomInt(256));

  const [run] = await rest("uwusort_runs", {
    method: "POST",
    body: { client_key: key, mode, difficulty, level, seed: seed.text },
    prefer: "return=representation",
  });

  // Now and then, clear out runs nobody finished.
  if (randomInt(50) === 0) rpc("uwusort_prune", {}).catch((err) => console.warn("prune failed:", err.message));

  return { run_id: run.id, seed: seed.text, expires_in: RUN_TTL_MS };
});
