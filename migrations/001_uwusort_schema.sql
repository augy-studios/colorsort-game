-- uwuSort (sortr.uwuapps.org) schema, in the shared uwuapps Supabase project.
-- Paste into the Supabase SQL editor and run once.
-- Safe to run again: everything is "if not exists" or "or replace".
-- Never edit this file once it has been run; a change is a new numbered file.
--
-- Access model: only the Vercel functions in main-site/api touch these
-- tables, with the service role key. There is no Supabase Auth here. RLS is
-- on with no policies, so an anon key reads nothing.
--
-- The game runs in the browser. What the server holds:
--
--   runs     a level the server dealt and started the clock on, so it can be
--            held to the server's time and earn speed bonuses
--   plays    every finished level a browser sent, checked by the API first
--            (main-site/js/rules.js, checkGame), with or without a name.
--            A browser's plays form a chain per mode and difficulty: a level
--            is "in order" when the level before it is in the chain too, and
--            only those count on the Top level board
--   replays  short replay links, /r/<id>

-- One run is one timed level. Created by POST /api/run/start.
create table if not exists uwusort_runs (
  id uuid primary key default gen_random_uuid(),
  client_key text not null,
  mode text not null check (mode in ('water', 'bolts')),
  difficulty text not null check (difficulty in ('easy', 'medium', 'hard')),
  level int not null check (level between 1 and 99999),
  -- "WE12-BXK4-M9TR": mode, difficulty, level, then the seed proper.
  seed text not null check (seed ~ '^[WB][EMH][1-9][0-9]{0,4}-[A-Z0-9]{4}-[A-Z0-9]{4}$'),
  used boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists uwusort_runs_created on uwusort_runs (created_at);

-- One row per finished level a browser sent. The id is made by the browser,
-- so sending the same level twice (a retry after a dropped reply) finds the
-- first. The score is the server's own, worked out from the log.
create table if not exists uwusort_plays (
  id uuid primary key,
  client_key text not null,
  mode text not null check (mode in ('water', 'bolts')),
  difficulty text not null check (difficulty in ('easy', 'medium', 'hard')),
  level int not null check (level between 1 and 99999),
  seed text not null check (seed ~ '^[WB][EMH][1-9][0-9]{0,4}-[A-Z0-9]{4}-[A-Z0-9]{4}$'),
  -- Set for a level the server dealt; null for one played offline.
  run_id uuid unique references uwusort_runs(id) on delete set null,
  timed boolean not null,
  score int not null check (score >= 0),
  moves int not null check (moves >= 0),
  undos int not null check (undos >= 0),
  hints int not null check (hints >= 0),
  duration_ms int not null check (duration_ms >= 0),
  log jsonb not null,
  in_order boolean not null,
  -- The server's clock when the level started, for a timed level.
  started_at timestamptz,
  -- What the browser said, for a level played offline. Shown, never trusted.
  played_at timestamptz,
  name text check (name is null or char_length(name) between 1 and 20),
  named_at timestamptz,
  created_at timestamptz not null default now(),
  check ((name is null) = (named_at is null))
);

-- A browser finishes each level once.
create unique index if not exists uwusort_plays_level
  on uwusort_plays (client_key, mode, difficulty, level);
create index if not exists uwusort_plays_name
  on uwusort_plays (mode, lower(name)) where name is not null;

-- The boards, per mode. One row per name, names compared case-insensitively.

-- Each name's best level. The earliest of an equal top score wins, and the
-- casing shown is the one attached to that score.
create or replace view uwusort_leaderboard_best
with (security_invoker = true) as
select distinct on (mode, lower(name)) mode, name, score, named_at
from uwusort_plays
where name is not null
order by mode, lower(name), score desc, named_at asc;

-- Every named level's score added up. The casing shown is the name's most
-- recent. Ties go to fewer levels, then to whoever got there first.
create or replace view uwusort_leaderboard_total
with (security_invoker = true) as
select
  mode,
  (array_agg(name order by named_at desc))[1] as name,
  sum(score)::bigint as total,
  count(*)::int as levels,
  max(named_at) as last_at
from uwusort_plays
where name is not null
group by mode, lower(name);

-- Each name's highest level finished in order, per mode and difficulty.
-- Ties go to whoever got there first.
create or replace view uwusort_leaderboard_level
with (security_invoker = true) as
select distinct on (mode, difficulty, lower(name)) mode, difficulty, name, level, named_at
from uwusort_plays
where name is not null and in_order
order by mode, difficulty, lower(name), level desc, named_at asc;

-- Short replay links, /r/<id>. A solo replay matching a recorded level is
-- verified; party games and anything else are stored as sent.
create table if not exists uwusort_replays (
  id text primary key check (id ~ '^[A-Za-z0-9]{8}$'),
  kind text not null check (kind in ('solo', 'race', 'turns')),
  verified boolean not null default false,
  play_id uuid unique references uwusort_plays(id) on delete set null,
  body jsonb not null check (octet_length(body::text) <= 131072),
  created_at timestamptz not null default now()
);

alter table uwusort_runs enable row level security;
alter table uwusort_plays enable row level security;
alter table uwusort_replays enable row level security;

-- Records a finished level the API has checked and scored. Repeats the
-- checks that depend on rows under a lock, so two sends at once cannot both
-- go through. A timed level must come from the browser its run was dealt
-- to, on the run's own seed, within the time the server has known about it.
--
--   ok           recorded; in_order says whether it extends the chain
--   duplicate    this browser already sent this play id; nothing changes
--   not_yours    a play with this id belongs to another browser
--   run_not_found, run_used, expired, mismatch, too_long   about the run
--   level_done   this browser already has a play at this level
create or replace function uwusort_record(
  p_id uuid,
  p_client_key text,
  p_mode text,
  p_difficulty text,
  p_level int,
  p_seed text,
  p_run_id uuid,
  p_score int,
  p_moves int,
  p_undos int,
  p_hints int,
  p_duration_ms int,
  p_log jsonb,
  p_played_at timestamptz,
  p_slack_ms int,
  p_ttl_ms int
)
returns table (status text, in_order boolean, score int, timed boolean)
language plpgsql
volatile
as $$
#variable_conflict use_column
declare
  v_play uwusort_plays%rowtype;
  v_run uwusort_runs%rowtype;
  v_in_order boolean;
begin
  select * into v_play from uwusort_plays p where p.id = p_id;
  if found then
    if v_play.client_key <> p_client_key then
      return query select 'not_yours'::text, null::boolean, null::int, null::boolean;
      return;
    end if;
    return query select 'duplicate'::text, v_play.in_order, v_play.score, v_play.timed;
    return;
  end if;

  if p_run_id is not null then
    select * into v_run from uwusort_runs r
    where r.id = p_run_id and r.client_key = p_client_key
    for update;
    if not found then
      return query select 'run_not_found'::text, null::boolean, null::int, null::boolean;
      return;
    end if;
    if v_run.used then
      return query select 'run_used'::text, null::boolean, null::int, null::boolean;
      return;
    end if;
    if v_run.created_at < now() - make_interval(secs => p_ttl_ms / 1000.0) then
      return query select 'expired'::text, null::boolean, null::int, null::boolean;
      return;
    end if;
    if v_run.seed <> p_seed or v_run.mode <> p_mode or v_run.difficulty <> p_difficulty or v_run.level <> p_level then
      return query select 'mismatch'::text, null::boolean, null::int, null::boolean;
      return;
    end if;
    -- A level cannot have lasted longer than the server has known about it.
    if p_duration_ms > extract(epoch from (now() - v_run.created_at)) * 1000 + p_slack_ms then
      return query select 'too_long'::text, null::boolean, null::int, null::boolean;
      return;
    end if;
  end if;

  -- One chain at a time per browser, so two levels sent together cannot
  -- both miss each other below.
  perform pg_advisory_xact_lock(hashtext('uwusort_record:' || p_client_key));

  if exists (
    select 1 from uwusort_plays p
    where p.client_key = p_client_key and p.mode = p_mode and p.difficulty = p_difficulty and p.level = p_level
  ) then
    return query select 'level_done'::text, null::boolean, null::int, null::boolean;
    return;
  end if;

  v_in_order := p_level = 1 or exists (
    select 1 from uwusort_plays p
    where p.client_key = p_client_key and p.mode = p_mode and p.difficulty = p_difficulty
      and p.level = p_level - 1 and p.in_order
  );

  if p_run_id is not null then
    update uwusort_runs r set used = true where r.id = p_run_id;
  end if;

  insert into uwusort_plays (
    id, client_key, mode, difficulty, level, seed, run_id, timed, score, moves, undos, hints,
    duration_ms, log, in_order, started_at, played_at
  )
  values (
    p_id, p_client_key, p_mode, p_difficulty, p_level, p_seed, p_run_id, p_run_id is not null, p_score, p_moves,
    p_undos, p_hints, p_duration_ms, p_log, v_in_order, v_run.created_at, p_played_at
  );

  return query select 'ok'::text, v_in_order, p_score, p_run_id is not null;
end;
$$;

-- Puts a recorded level on the boards under a name, and returns the name's
-- standing in that level's mode. Refuses a timed level played at the same
-- time as another timed level already on the boards under the same name.
--
--   ok, already_named, not_found, overlap
create or replace function uwusort_name(p_id uuid, p_client_key text, p_name text)
returns table (
  status text,
  name text,
  score int,
  best_score int,
  best_rank bigint,
  total bigint,
  levels int,
  total_rank bigint,
  top_level int,
  level_rank bigint
)
language plpgsql
volatile
as $$
#variable_conflict use_column
declare
  v_play uwusort_plays%rowtype;
  v_best int;
  v_best_at timestamptz;
  v_total bigint;
  v_levels int;
  v_top int;
  v_top_at timestamptz;
begin
  select * into v_play from uwusort_plays p
  where p.id = p_id and p.client_key = p_client_key
  for update;
  if not found then
    status := 'not_found';
    return next;
    return;
  end if;
  if v_play.name is not null then
    status := 'already_named';
    name := v_play.name;
    return next;
    return;
  end if;

  -- One name at a time, so two levels named together cannot both miss each
  -- other in the overlap check.
  perform pg_advisory_xact_lock(hashtext('uwusort_name:' || lower(p_name)));

  if v_play.started_at is not null and exists (
    select 1 from uwusort_plays p
    where p.name is not null
      and lower(p.name) = lower(p_name)
      and p.started_at is not null
      and p.id <> p_id
      and p.started_at < v_play.started_at + make_interval(secs => v_play.duration_ms / 1000.0)
      and p.started_at + make_interval(secs => p.duration_ms / 1000.0) > v_play.started_at
  ) then
    status := 'overlap';
    return next;
    return;
  end if;

  update uwusort_plays p set name = p_name, named_at = now() where p.id = p_id;

  select p.score, p.named_at into v_best, v_best_at
  from uwusort_plays p
  where p.mode = v_play.mode and p.name is not null and lower(p.name) = lower(p_name)
  order by p.score desc, p.named_at asc
  limit 1;

  select sum(p.score)::bigint, count(*)::int into v_total, v_levels
  from uwusort_plays p
  where p.mode = v_play.mode and p.name is not null and lower(p.name) = lower(p_name);

  select p.level, p.named_at into v_top, v_top_at
  from uwusort_plays p
  where p.mode = v_play.mode and p.difficulty = v_play.difficulty and p.in_order
    and p.name is not null and lower(p.name) = lower(p_name)
  order by p.level desc, p.named_at asc
  limit 1;

  status := 'ok';
  name := p_name;
  score := v_play.score;
  best_score := v_best;
  best_rank := (
    select count(*) + 1
    from uwusort_leaderboard_best b
    where b.mode = v_play.mode
      and (b.score > v_best or (b.score = v_best and b.named_at < v_best_at))
  );
  total := v_total;
  levels := v_levels;
  total_rank := (
    select count(*) + 1
    from uwusort_leaderboard_total t
    where t.mode = v_play.mode
      and lower(t.name) <> lower(p_name)
      and (
        t.total > v_total
        or (t.total = v_total and t.levels < v_levels)
        -- This name's total was only just reached, so an equal one got there first.
        or (t.total = v_total and t.levels = v_levels)
      )
  );
  top_level := v_top;
  level_rank := case when v_top is null then null else (
    select count(*) + 1
    from uwusort_leaderboard_level l
    where l.mode = v_play.mode and l.difficulty = v_play.difficulty
      and (l.level > v_top or (l.level = v_top and l.named_at < v_top_at))
  ) end;
  return next;
end;
$$;

-- Housekeeping, called now and then by /api/run/start: runs nobody finished
-- that are past any use.
create or replace function uwusort_prune()
returns void
language sql
volatile
as $$
  delete from uwusort_runs r
  where r.created_at < now() - interval '1 day'
    and not r.used;
$$;

-- Service role only.
revoke all on function uwusort_record(uuid, text, text, text, int, text, uuid, int, int, int, int, int, jsonb, timestamptz, int, int) from public, anon, authenticated;
revoke all on function uwusort_name(uuid, text, text) from public, anon, authenticated;
revoke all on function uwusort_prune() from public, anon, authenticated;
grant execute on function uwusort_record(uuid, text, text, text, int, text, uuid, int, int, int, int, int, jsonb, timestamptz, int, int) to service_role;
grant execute on function uwusort_name(uuid, text, text) to service_role;
grant execute on function uwusort_prune() to service_role;
