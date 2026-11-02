// POST /api/leaderboard/name  { name } -> { name }
// Checks a display name without submitting anything, so a client can save
// one ahead of time under the same rules submit applies.

import { endpoint } from "../_lib/http.js";
import { cleanName } from "../_lib/names.js";

export default endpoint("POST", async ({ body }) => {
  return { name: cleanName(body.name) };
});
