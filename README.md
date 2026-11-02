# uwuSort

Pour water and spin nuts until every tube and bolt holds one colour. Two
modes, Water and Bolts, each with Easy, Medium and Hard, each an endless run
of levels. Every level has a seed that can be copied and played again, ends
with an instant replay that can be shared, and goes on its mode's
leaderboards. Party games for two to four players on the same wifi.

Live at <https://sortr.uwuapps.org>. A PWA drawn with three.js: once opened,
it plays offline, and levels finished offline go on the leaderboard once the
player is back online.

## What runs where

| Part | Runs on |
| --- | --- |
| `main-site/`, the PWA and its API (`main-site/api/`) | Vercel, root directory `main-site` |
| Database, `uwusort_*` tables | The shared uwuapps Supabase project |
| Party games | Browser to browser over WebRTC. PeerJS's public broker introduces the devices; nothing of ours is in between |

There is nothing on the VPS.

## Layout

```text
README.md
docs/            the specs this is built to
migrations/      SQL to run in the Supabase SQL editor, in number order
scripts/         pre-deploy checks and the rules test
main-site/       the site Vercel deploys, including api/
```

`docs/` holds the specs: `uwuapps-theme.md` and
`uwuapps-retrofit-time-mode.md` (theme, with time-based mode),
`update-bar-spec.md` (the update prompt), `edge-tray-spec.md` (the tray of
buttons top right) and `STUN-p2p-spec.md` (party pairing).
`main-site/README.md` covers the app itself.

## First setup

1. Run every file in `migrations/`, in number order, in the Supabase SQL
   editor of the shared uwuapps project. Each is safe to run again. Never edit
   one that has been run; a change is a new numbered file.
2. On the Vercel project (root directory `main-site`), set the variables in
   `main-site/.env.example`: `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`.
3. Add the domain `sortr.uwuapps.org` to the Vercel project.
4. Deploy.

Without the variables the site still plays in full; the API answers
`not_configured`, finished levels wait in each browser's queue, and shared
replays use long links.

| Migration | What it does |
| --- | --- |
| `001_uwusort_schema.sql` | Runs, plays (each browser's chain of levels), the three boards per mode, short replay links, and the record, name and prune functions. |

## Before every deploy

1. Bump `VERSION` in `main-site/sw.js`. Without it, returning visitors keep
   the previous build and never see the update bar.
2. Run the checks, from the repo root, with Node 20 or later and nothing to
   install:

```text
node scripts/check-sw.mjs          # the worker only activates when asked
node scripts/check-precache.mjs    # everything the app loads is precached
node scripts/check-theme.mjs       # pre-paint script matches js/theme.js
node scripts/check-p2p.mjs         # party pairing is STUN only
node scripts/test-rules.mjs        # seeds, dealing, the solver, scoring, the server's check, replay links
```

**If you change `js/puzzle.js`, `js/rules.js`, `js/seed.js` or
`js/palette.js`,** levels played on the old build stop verifying, and old
seeds deal different levels: the API replays every level with the code it has
now. Adding a colour at the end of the palette is safe; reordering one is not.

## Leaderboard integrity

A browser game cannot prove its score, and every level is dealt in the
browser from its seed, so a script can solve it. What the API does instead,
with `checkGame` in `main-site/js/rules.js`, is refuse a level real play
could not have made:

- it replays the log from the seed and works the score out itself, refusing
  any move the rules would not allow and any level the log does not solve
- moves quicker than a hand can pick two columns, more than now and then, or
  quicker than 0.4 s a move on average
- a timed level longer than the time the server saw pass since it dealt it
- a timed level played at the same time as another under the same name

A level played with autoplay is never sent, and its pace is one the check
above refuses anyway. A pasted seed is never sent: the level could have been
known in advance. Each browser finishes each level once, and the Top level
board only counts levels whose level before was finished in the same
browser, so a level number cannot be claimed without the levels under it.
Levels played offline count, without speed bonuses, since the server did not
see them start. This bounds cheating; it does not prevent it.
