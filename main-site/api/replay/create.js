// POST /api/replay/create  { replay, play_id?, client_key? } -> { id }
//
// Stores a replay, in js/replay-format.js's format, for the short link
// /r/<id>. Names are run through the leaderboard's word filter.
//
// A solo replay sent with the level it was recorded as, and with the same
// seed and log, is marked verified: the server checked that log when it was
// recorded. One replay per recorded level, so asking again returns the same
// id. Anything else, a party game or a level that was never recorded, is
// stored as sent and marked unverified.

import { randomInt } from "node:crypto";
import { clientKey, endpoint, HttpError, uuid } from "../_lib/http.js";
import { cleanName } from "../_lib/names.js";
import { rest } from "../_lib/supabase.js";
import { cleanReplay } from "../../js/replay-format.js";

const ID_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
const ID_LENGTH = 8;
const MAX_BYTES = 128 * 1024;

const newId = () => Array.from({ length: ID_LENGTH }, () => ID_ALPHABET[randomInt(ID_ALPHABET.length)]).join("");

function nameOrNull(value) {
  try {
    return cleanName(value);
  } catch {
    return null;
  }
}

async function existingFor(play) {
  const [row] = (await rest(`uwusort_replays?play_id=eq.${play}&select=id`)) ?? [];
  return row?.id ?? null;
}

async function store(row) {
  // Eight characters from 55 make a clash vanishingly rare, but a second try
  // costs nothing.
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = newId();
    try {
      await rest("uwusort_replays", { method: "POST", body: { id, ...row } });
      return id;
    } catch (err) {
      if (!/supabase 409/.test(err.message ?? "")) throw err;
      // Asked twice at once for one level: the other request stored it.
      if (row.play_id) {
        const id = await existingFor(row.play_id);
        if (id) return id;
      }
    }
  }
  throw new HttpError(503, "busy", "Could not store the replay. Try again.");
}

export default endpoint("POST", async ({ body }) => {
  const replay = cleanReplay(body.replay);
  if (!replay) throw new HttpError(400, "bad_replay", "That is not a replay.");
  replay.players = replay.players.map((p, i) => nameOrNull(p) ?? `Player ${i + 1}`);
  if (new TextEncoder().encode(JSON.stringify(replay)).length > MAX_BYTES) {
    throw new HttpError(413, "too_big", "That game is too long to store. Share the long link instead.");
  }

  let verified = false;
  let play = null;
  if (body.play_id && replay.kind === "solo") {
    const id = uuid(body.play_id, "bad_play_id");
    const key = clientKey(body.client_key);
    const [found] =
      (await rest(`uwusort_plays?select=id,seed,log,timed&id=eq.${id}&client_key=eq.${encodeURIComponent(key)}&limit=1`)) ?? [];
    if (found && found.seed === replay.seed && found.timed === replay.timed && JSON.stringify(found.log) === JSON.stringify(replay.logs[0])) {
      const existing = await existingFor(id);
      if (existing) return { id: existing };
      verified = true;
      play = id;
    }
  }

  return { id: await store({ kind: replay.kind, verified, play_id: play, body: replay }) };
});
