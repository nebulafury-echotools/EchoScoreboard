# Echo Scoreboard

A live scoreboard, arena radar and throw tracker for Echo VR, driven by the game's local API.
Works with any server, including EchoRelay. No dependencies, just Node 18+.

## Run

1. In Echo VR: **Settings → Game → Enable API Access**.
2. Start the scoreboard:

   ```
   node server.mjs
   ```

3. Open http://localhost:6730 and join a match.

### Build the app (Windows .exe)

Prefer a window instead of a browser tab? Double-click **`build.bat`**. It installs dependencies and builds
`dist\EchoScoreboard-win32-x64\EchoScoreboard.exe`. You need [Node.js](https://nodejs.org) (LTS); the first
build downloads Electron (~100 MB). Close a running EchoScoreboard.exe before rebuilding.

Run the exe: the window shows the scoreboard, and the tray icon toggles the in-game overlay (and has
Open dashboard / Quit). Closing the window quits the app. Start with `EchoScoreboard.exe --tray` to launch
hidden, with only the tray icon and overlay.

Playing on a Quest standalone? Pass the headset's LAN IP: `node server.mjs 192.168.1.50`

Until the game is reachable, the page runs a built-in demo match (yellow **DEMO** pill).
It switches to real data (green **LIVE** pill) as soon as `/session` answers.

## What's on it

- **Scoreboard**: points, clock, match status, possession arrow, goal flash
- **Rosters**: number, ping, points / assists / saves / stuns / steals, holding + stunned tags
- **Radar**: top-down arena with smoothed player positions, facing, disc trail, speed and altitude
- **Throw lab**: last throw speed with arm / wrist / movement breakdown, spin, session best, last 24 throws
- **Match feed**: goals, saves, stuns, steals, interceptions, joins and leaves

- **Autoclip**: presses your Medal hotkey a few seconds after *you* score, save or assist

## Autoclip

Runs inside `server.mjs`, so it works even with the browser tab closed.

- Watches the player in **Track** (default: you, from Echo's `client_name`).
- When their `goals`, `saves` or `assists` stat goes up, it waits **Wait** seconds (default 5) and presses **Medal key** (default F2).
- Several events inside one wait window (save → assist → goal) become a single clip.
- While you're spectating it stays idle; pick another player in **Track** to try it out, then switch back to **Me**.
- **Test clip** queues a press right now with your current settings.
- Settings are saved to `autoclip.json` next to the server.

Medal needs its clip hotkey set to the same key, and the clip length should be longer than the wait
(e.g. 30 s) so the play itself is in the clip.

## Overlay

`/overlay.html` is a transparent spectator HUD meant for a click-through, always-on-top window laid over
Echo's game window (any size, 720p to 4K). Score bar on top, rosters on the edges, a small radar bottom-left,
the MVP card and last throw speed bottom-right. The centre stays clear.
A feed in the top-left corner pops up a card for each event: Echo loaded or closed, joining or leaving a match,
players joining or leaving a team, goals, overtime, the final score, and Autoclip (countdown and saved clips).
It keeps the newest three and also shows between matches; everything else is hidden out of a match.
Set `ECHO_SCOREBOARD_DATA` to a directory to keep `autoclip.json` somewhere writable.

## MVP prediction

`GET /api/mvp` scores every player with the game's award multipliers (`mvp-awards.json`, extracted from
`player_rewards.json`), shows each player's top 3 awards and predicts the MVP: the highest award total on either
team, without Jouster (jousts don't count toward MVP) and with interceptions doubled (the API under-reports them).
Players who drop out in the last 10 seconds still count. It lives in `pickMvp()` in `server.mjs` and was tuned
against the game's real MVP (see below): 28 of 30 matches, against 18 of 30 for the old "top of the leading team".

Some award stats aren't in the API and are derived from the stream (marked with ≈): three-point and bounce goals,
jousts won, clears (the disc leaving a hand in your own half, flying fast toward the other end), longest possession
(counts only while the game clock runs). They only count what happened while the server was running.
The API's `interceptions` is also marked ≈ because the game under-reports it. The dashboard shows it under **MVP watch**.
Stats reset when the session id changes; players who leave keep their row until then.

Spectating with the desktop build: `echovr.exe -spectatorstream -windowed`.

## MVP verification

At the end of every match (`post_match`) the server snapshots its MVP prediction and all player stats, then tries to
read the game's real MVP and appends one line to `mvp-log.jsonl` (next to the server, or in `ECHO_SCOREBOARD_DATA`).

- The API has no MVP or award fields, so the real result is read from the screen: after a match Echo shows the MVP
  and award cards ("MVP", "Bruiser", "Long Arm", ...) in the middle of the arena. When spectating, the server points
  the camera at them through Echo's camera API (4 m from the centre on the long axis, the same API Spark's camera
  write uses) and puts it back in sideline mode afterwards. `tools\capture-ocr.ps1` grabs background screenshots
  of the Echo window (no focus or input needed; PrintWindow), saves them to `captures\` (newest 60 kept) and runs
  the built-in Windows OCR on them; it keeps looking for up to ~50 s until the MVP card is read.
  `mvp-verify.mjs` matches the text against the roster.
- `GET /api/mvp-log` returns the newest entries and a summary (matches, verified, correct, accuracy). The dashboard
  shows it under **MVP watch**.
- `node tools\mvp-rules.mjs` scores candidate rules (award total, points, win bonus, ...) against the verified
  entries, to tune `pickMvp()` in `server.mjs`.

Limitations: it only reads what is on screen. When you play, the cards are in front of you; if they are not, or OCR
misses the MVP, the entry is logged unverified (`actual.reason`). The MVP card sometimes shows a player's custom
display name instead of their account name; those entries are left unverified rather than guessed. OCR can misread
names; the log keeps the raw text and screenshots so entries can be checked by hand.
