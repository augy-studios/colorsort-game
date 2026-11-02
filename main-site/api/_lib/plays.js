// Recording a finished level and putting it under a name. Shared by
// /api/play/record, which does both when a name comes with the level, and
// /api/leaderboard/submit, which names a level recorded earlier.

import { HttpError } from "./http.js";
import { rest, rpc } from "./supabase.js";
import { CLOCK_SLACK_MS, RUN_TTL_MS, checkGame } from "../../js/rules.js";
import { parseSeed } from "../../js/seed.js";

const RECORD_REFUSALS = {
  not_yours: [409, "That level belongs to another browser."],
  run_not_found: [404, "That level is not one this browser started."],
  run_used: [409, "That level has already been recorded."],
  expired: [410, "That level is more than six hours old."],
  mismatch: [409, "That level's seed is not the one the server dealt."],
  too_long: [422, "That level's moves do not add up, so it was not recorded."],
  level_done: [409, "This browser has already finished that level."],
  implausible: [422, "That level's moves do not add up, so it was not recorded."],
};

const NAME_REFUSALS = {
  not_found: [404, "That level has not been recorded from this browser."],
  overlap: [409, "That level was played at the same time as another level already on the leaderboard under this name."],
};

const refuse = (table, reason) => {
  const [status, message] = table[reason] ?? [500, "Could not record that level."];
  return new HttpError(status, table[reason] ? reason : "server", message);
};

async function loadRun(id, key) {
  const [run] =
    (await rest(
      `uwusort_runs?select=id,created_at,used,seed&id=eq.${id}&client_key=eq.${encodeURIComponent(key)}&limit=1`
    )) ?? [];
  return run ?? null;
}

// Checks a finished level against the rules, and records it. Returns
// { status, in_order, score, timed }.
export async function recordPlay({ id, key, seedText, runId, log, durationMs, playedAt }) {
  const seed = parseSeed(seedText);
  if (!seed || seed.text !== String(seedText).toUpperCase()) throw new HttpError(400, "bad_seed", "That is not a seed.");

  // Sent twice: the first one stands, unchecked a second time.
  const [existing] = (await rest(`uwusort_plays?select=client_key,in_order,score,timed&id=eq.${id}&limit=1`)) ?? [];
  if (existing) {
    if (existing.client_key !== key) throw refuse(RECORD_REFUSALS, "not_yours");
    return { status: "duplicate", in_order: existing.in_order, score: existing.score, timed: existing.timed };
  }

  let elapsed = null;
  if (runId) {
    const run = await loadRun(runId, key);
    if (!run) throw refuse(RECORD_REFUSALS, "run_not_found");
    if (run.seed !== seed.text) throw refuse(RECORD_REFUSALS, "mismatch");
    elapsed = Date.now() - Date.parse(run.created_at);
  }

  const check = checkGame({ seed, timed: Boolean(runId), players: ["Player"] }, log, durationMs, elapsed);
  if (check.reason) {
    // The reason stays in the logs. Telling the caller which bound it hit
    // would only help tune the next attempt.
    const entries = Array.isArray(log) ? log.length : typeof log;
    console.warn(`implausible play ${id}: ${check.reason}`, { entries, duration: durationMs, elapsed });
    throw refuse(RECORD_REFUSALS, "implausible");
  }
  const r = check.result;

  const [row] =
    (await rpc("uwusort_record", {
      p_id: id,
      p_client_key: key,
      p_mode: seed.mode,
      p_difficulty: seed.difficulty,
      p_level: seed.level,
      p_seed: seed.text,
      p_run_id: runId ?? null,
      p_score: r.score,
      p_moves: r.moves,
      p_undos: r.undos,
      p_hints: r.hints,
      p_duration_ms: durationMs,
      p_log: log,
      p_played_at: playedAt,
      p_slack_ms: CLOCK_SLACK_MS,
      p_ttl_ms: RUN_TTL_MS,
    })) ?? [];
  if (row?.status !== "ok" && row?.status !== "duplicate") throw refuse(RECORD_REFUSALS, row?.status);
  return { status: row.status, in_order: row.in_order, score: row.score, timed: row.timed };
}

// Names a recorded level. Returns the name's standing in its mode. With
// `retry`, a level already named is not an error: it is a send whose reply
// was lost, and the name it has is returned.
export async function namePlay({ id, key, name, retry = false }) {
  const [row] = (await rpc("uwusort_name", { p_id: id, p_client_key: key, p_name: name })) ?? [];
  if (row?.status === "already_named" && retry) return { name: row.name };
  if (row?.status === "already_named") {
    throw new HttpError(409, "already_named", `That level is already on the leaderboard as ${row.name}.`);
  }
  if (row?.status !== "ok") throw refuse(NAME_REFUSALS, row?.status);
  return {
    name: row.name,
    score: row.score,
    best_score: row.best_score,
    rank: Number(row.best_rank),
    total: Number(row.total),
    levels: row.levels,
    total_rank: Number(row.total_rank),
    top_level: row.top_level,
    level_rank: row.level_rank === null ? null : Number(row.level_rank),
  };
}
