// GET /api/leaderboard?mode=water|bolts&board=best|total|level&difficulty=easy|medium|hard
//   best  (default) -> { mode, board, entries: [{ rank, name, score }] }
//   total           -> { mode, board, entries: [{ rank, name, total, levels }] }
//   level           -> { mode, board, difficulty, entries: [{ rank, name, level }] }
// Public, no login, one row per name, cached briefly at the edge. Water and
// Bolts have their own boards; Top level has one per difficulty.

import { endpoint, HttpError } from "../_lib/http.js";
import { rest } from "../_lib/supabase.js";
import { DIFFICULTIES, MODES } from "../../js/rules.js";

const LIMIT = 100;

const BOARDS = {
  best: {
    query: (mode) => `uwusort_leaderboard_best?select=name,score&mode=eq.${mode}&order=score.desc,named_at.asc&limit=${LIMIT}`,
    row: (r) => ({ name: r.name, score: r.score }),
  },
  total: {
    query: (mode) =>
      `uwusort_leaderboard_total?select=name,total,levels&mode=eq.${mode}&order=total.desc,levels.asc,last_at.asc&limit=${LIMIT}`,
    // bigint sums arrive as numbers well within range for this game.
    row: (r) => ({ name: r.name, total: Number(r.total), levels: r.levels }),
  },
  level: {
    query: (mode, difficulty) =>
      `uwusort_leaderboard_level?select=name,level&mode=eq.${mode}&difficulty=eq.${difficulty}&order=level.desc,named_at.asc&limit=${LIMIT}`,
    row: (r) => ({ name: r.name, level: r.level }),
  },
};

export default endpoint("GET", async ({ req, res }) => {
  const board = req.query?.board ?? "best";
  const mode = req.query?.mode ?? "water";
  const difficulty = req.query?.difficulty ?? "easy";
  const spec = BOARDS[board];
  if (!spec) throw new HttpError(400, "bad_board", "board is best, total or level.");
  if (!MODES[mode]) throw new HttpError(400, "bad_mode", "mode is water or bolts.");
  if (!DIFFICULTIES[difficulty]) throw new HttpError(400, "bad_difficulty", "difficulty is easy, medium or hard.");

  const rows = await rest(spec.query(mode, difficulty));
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=30, stale-while-revalidate=60");
  return {
    mode,
    board,
    difficulty: board === "level" ? difficulty : undefined,
    entries: (rows ?? []).map((r, i) => ({ rank: i + 1, ...spec.row(r) })),
  };
});
