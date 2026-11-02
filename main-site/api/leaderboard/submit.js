// POST /api/leaderboard/submit  { client_key, play_id, name }
//   -> { name, score, best_score, rank, total, levels, total_rank, top_level, level_rank }
//
// Puts a level recorded earlier (see /api/play/record) on the boards under
// a name: for a level finished before the player gave one, or with adding
// levels automatically turned off. Only the browser that recorded the level
// can name it, and only once.

import { clientKey, endpoint, uuid } from "../_lib/http.js";
import { cleanName } from "../_lib/names.js";
import { namePlay } from "../_lib/plays.js";

export default endpoint("POST", async ({ body }) => {
  const key = clientKey(body.client_key);
  const id = uuid(body.play_id, "bad_play_id");
  const name = cleanName(body.name);
  return namePlay({ id, key, name });
});
