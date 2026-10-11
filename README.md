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
the MVP card and last throw speed bottom-right, and toasts for goals and Autoclip. The centre stays clear.
Out of a match it draws nothing except a small status chip that fades after a few seconds.
Set `ECHO_SCOREBOARD_DATA` to a directory to keep `autoclip.json` somewhere writable.

## MVP prediction

`GET /api/mvp` scores every player with the game's award multipliers (`mvp-awards.json`, extracted from
`player_rewards.json`), shows each player's top 3 awards and predicts the MVP: the top scorer on the leading team
(overall top scorer when tied). This is a guess, not the official rule; it lives in `pickMvp()` in `server.mjs`.

Some award stats aren't in the API and are derived from the stream (marked with ≈): three-point and bounce goals,
jousts won, clears, longest possession. They only count what happened while the server was running.
The API's `interceptions` is also marked ≈ because the game under-reports it. The dashboard shows it under **MVP watch**.
Stats reset when the session id changes; players who leave keep their row until then.

Spectating with the desktop build: `echovr.exe -spectatorstream -windowed`.
