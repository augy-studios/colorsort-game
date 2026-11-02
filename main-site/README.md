# main-site

What Vercel deploys, served at <https://sortr.uwuapps.org>. No build step:
the files are served as they are, and `api/` holds the serverless functions.

| Path | What it is |
| --- | --- |
| `index.html` | The only page. Its `<head>` is the template for any page added later. |
| `404.html`, `404.css` | The template's not-found page, as it was. |
| `sw.js` | Service worker: the offline shell, and the update bar's waiting worker. |
| `manifest.json` | PWA manifest. |
| `css/theme.css` | The uwuapps theme, verbatim from `docs/uwuapps-theme.md`, time-based mode included. |
| `css/style.css` | Layout, the Edge Tray, the flat board. Fixed-meaning colours (QR, metal, heart) are tokens at the top. |
| `js/` | ES modules, below. |
| `api/` | The API, below. |
| `vendor/` | three.js (MIT) and PeerJS 1.5.4 (MIT), served from here so they are precached. |
| `fonts/` | Jua, self-hosted, with its licence. |
| `images/` | Manifest screenshots. |
| `UCS-main.png`, `UCS-192.png`, `UCS-512.png`, `favicon.ico` | The icon, kept inside the circle a round mask leaves. |

## js

Every file here is precached; `scripts/check-precache.mjs` fails if one is
not. `puzzle.js`, `rules.js`, `seed.js`, `palette.js` and `replay-format.js`
are pure, with no DOM, and the API imports them, so the browser and the
server always agree on a level.

| File | What it does |
| --- | --- |
| `puzzle.js` | The columns, what a move does, hidden nuts, the solver, and dealing a level. |
| `rules.js` | Modes, difficulties and how each level is shaped; the game and its log; scoring; the server's check of a finished level. |
| `seed.js` | Seeds. |
| `palette.js` | The colours, each with a symbol. |
| `replay-format.js` | The replay format, and packing a whole game into a long link. |
| `board.js` | The board on screen, flat or 3D, and all input: tap, drag, keyboard. |
| `board3d.js` | The 3D board, with three.js. Loaded only when the 3D view is on. |
| `game.js` | A solo level: choosing, starting, playing, autoplay, the result, progress. |
| `queue.js` | Finished levels on their way to the server, kept until they get there. |
| `replay.js` | The instant replay, and sharing replays. |
| `party.js` | Party games on top of `p2p.js`: hosting, joining, the lobby, races and turns. |
| `p2p.js` | Pairing over PeerJS, STUN only, verbatim from `docs/STUN-p2p-spec.md`. |
| `qr.js` | QR encoder for the join link, from uwuPromptr, so it works offline. |
| `tray.js` | The Edge Tray (`docs/edge-tray-spec.md`) and full screen. |
| `api.js`, `leaderboard.js`, `settings.js` | The API client, and the leaderboard and settings windows, after MRT Station Guesser's. |
| `theme.js`, `icons.js`, `ui.js`, `update-bar.js`, `app.js` | Theme, inline SVG icons, view, modal and storage helpers, the update bar, and boot. |

## The game

**Playing.** Tap a tube or bolt, then another, or drag (swipe) from one to
the other. The whole run of one colour on top moves, as much as fits, onto
an empty column or its own colour. A finished column is locked. The board
takes every touch, so a swipe never scrolls the page or pulls to refresh.
The keyboard works too: arrow keys move between columns, Enter picks up and
puts down, `U` undoes, `P` pauses (which hides the board and stops the
clock).

**Modes.**

| | Water | Bolts |
| --- | --- | --- |
| Easy | 4 a tube, 3 colours rising to 5 | 3 a bolt, 3 colours rising to 5 |
| Medium | 4 a tube, 6 rising to 8 | 4 a bolt, 5 rising to 7; 4 in 10 bolts hide all but their top nut |
| Hard | 4 a tube, 9 rising to 12 | 5 a bolt, 7 rising to 10; half the bolts hide all but their top nut |

Each difficulty adds a colour every few levels up to its cap, and there are
always two empty columns. A hidden nut shows its colour when it reaches the
top, and stays shown, undo or not. Every colour carries a symbol, in both
views, so no two are told apart by colour alone.

**Helpers.** Unlimited undo, restart, a hint (the next move of a solution,
from where you are), and once a level an extra empty column. Each costs a
little; a setting asks before a hint or the extra column.

**Levels and progress.** Each mode and difficulty keeps its own level count
in this browser. Solving a level moves it on. A level on a pasted seed, or
one autoplay played, does not.

**3D and flat.** The board is three.js by default: glass tubes that tip and
pour, and bolts whose nuts lift off and spin across. Settings has a flat
view, which is also what plays where WebGL is missing, and what keyboards
and screen readers use underneath the 3D one.

**Seeds.** A seed looks like `WE12-BXK4-M9TR`: mode, difficulty, level, and
eight characters. It shows during play and on the result, where it can be
copied; paste one on the first card or the result to play that level.

**Scoring.** The score grows as the level goes on.

| | Points |
| --- | --- |
| Each unit moved onto its own colour | 10 |
| Finishing a column | 100 |
| A quick move (timed levels) | up to +50% on that move: full at 1 s, none at 8 s |
| Undo or restart | the move's points back, and minus 20 |
| A hint | minus 60 |
| The extra column | minus 150 |
| Solving in few moves | 40 x colours x (fewest possible moves / your moves) |
| Time to spare (timed levels) | up to +50%, against 4 s a unit |

Then scaled by the difficulty (100%, 175%, 275%) and the level (+1% a level,
up to +100%). A level is timed when it was started online: the server dealt
it and saw it start. A level played offline scores the same without the two
speed bonuses.

**Replay.** Watch replay on the result, or automatically (a setting). Every
move, undo, hint and restart plays back on the board, with a caption, the
score as it was, and ticks on the timeline at each undo and hint. Play and
pause, step back or forward, drag the timeline, 0.5x to 4x, as Word Rain's;
the speed is remembered. `Space`, arrows and `Esc` work too.

**Sharing a replay.** Online the link is short, `/r/<id>`, stored by
`/api/replay/create`. Offline, or if the API will not take it, the link
holds the whole game, as chess-game's do: `/?watch=<moves>&seed=...`. Every
score in a replay is worked out again from its moves. A solo replay of a
recorded level is checked by the server and says so.

**Settings,** kept in this browser, after MRT Station Guesser's:

| Setting | Default | What it does |
| --- | --- | --- |
| Leaderboard name | asked before the first level | Checked by `/api/leaderboard/name`. |
| Add finished levels to the leaderboard | on | Needs a name. |
| Play the replay when a level ends | off | |
| Ask before a hint or the extra column | on | A second tap, naming the cost. |
| Board | 3D | 3D or flat. |
| Show a symbol on each colour | on | |

**Leaderboards.** Water and Bolts each have three: Best score, Total points,
and Top level (per difficulty), one row per name, as MRT Station Guesser's.
See the root README for what is checked.

**Offline.** Everything is precached on the first visit. A level finished
offline is saved in `js/queue.js` and sent, in order, when the connection is
back (on `online`, on returning to the tab, and every minute).

## Party games

The people button. One device hosts and shows a code, a QR code and a link
(`/join?id=CODE`); up to three more join. The host picks Race (everyone the
same level on their own board; first to solve wins, the rest finish for
their place) or Take turns (one board, a move each; finishing a column keeps
the turn), and the mode, difficulty and level. The host's device runs every
board with `rules.js` and sends each guest a snapshot 20 times a second;
hidden nuts are sent as hidden, and the seed only at the end. Everyone gets
the replay, to watch or share. Party games never go on the leaderboard.

Pairing follows `docs/STUN-p2p-spec.md`, the way uwuPromptr's remote pairs:
STUN only, no TURN relay. **Everyone has to be on the same network**: the
same wifi, or one device sharing a hotspot and the others joining it.

**Privacy:** in a party game each device learns the others' public IP
addresses, as any peer-to-peer connection does, and PeerJS's broker sees
peer ids and IP addresses, never the game. The privacy policy should say so.

## Updates

A new service worker installs and waits. The update bar offers Reload or Not
now, and nothing reloads until the player asks (`docs/update-bar-spec.md`).
Bump `VERSION` in `sw.js` on every change to anything in this directory.

## API

| Endpoint | Body | Returns |
| --- | --- | --- |
| `POST /api/run/start` | `client_key, mode, difficulty, level` | `run_id, seed, expires_in` |
| `POST /api/play/record` | `client_key, play_id, seed, run_id?, log, duration_ms, at?, name?` | `play_id, score, in_order, timed`, and the standing if named |
| `POST /api/leaderboard/submit` | `client_key, play_id, name` | `name, score, best_score, rank, total, levels, total_rank, top_level, level_rank` |
| `POST /api/leaderboard/name` | `name` | `name`, cleaned, or a `400` saying why not |
| `GET /api/leaderboard` | `?mode=water\|bolts&board=best\|total\|level&difficulty=easy\|medium\|hard` | `entries`, cached 30 s |
| `POST /api/replay/create` | `replay`, and `play_id, client_key` for a recorded level | `id`, for `/r/<id>` |
| `GET /api/replay` | `?id=<id>` | `id, kind, verified, created_at, replay`, cached a day |

`log` is everything the player did, `[ms, code, ...]`, as `js/rules.js`
describes. The score is never taken from the browser. Errors are
`{ error, message? }`: `400` bad input or name, `404` no such level for this
browser, `409` already recorded or overlapping, `410` older than six hours,
`422` a level real play could not have made (the reason goes to the logs, not
the caller). There is no login and there are no rate limits.

## Environment variables (Vercel)

Documented in `.env.example`. `.vercelignore` keeps every env file out of
deployments, since anything in this directory would otherwise be served.

| Variable | Used for |
| --- | --- |
| `SUPABASE_URL` | The shared uwuapps project. |
| `SUPABASE_SERVICE_KEY` | Service role key. Server side only, never sent to a browser. |
