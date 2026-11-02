// GET /api/replay?id=<id> -> { id, kind, verified, created_at, replay }
// A stored replay. Never changes once written, so the edge keeps it a day.

import { endpoint, HttpError } from "../_lib/http.js";
import { rest } from "../_lib/supabase.js";

export default endpoint("GET", async ({ req, res }) => {
  const id = String(req.query?.id ?? "");
  if (!/^[A-Za-z0-9]{8}$/.test(id)) throw new HttpError(400, "bad_id", "That replay link is not right.");

  const [row] = (await rest(`uwusort_replays?id=eq.${id}&select=id,kind,verified,created_at,body`)) ?? [];
  if (!row) throw new HttpError(404, "replay_not_found", "There is no replay at that link.");

  res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=86400, immutable");
  return { id: row.id, kind: row.kind, verified: row.verified, created_at: row.created_at, replay: row.body };
});
