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

Playing on a Quest standalone? Pass the headset's LAN IP: `node server.mjs 192.168.1.50`

Until the game is reachable, the page runs a built-in demo match (yellow **DEMO** pill).
It switches to real data (green **LIVE** pill) as soon as `/session` answers.

## What's on it

- **Scoreboard**: points, clock, match status, possession arrow, goal flash
- **Rosters**: number, ping, points / assists / saves / stuns / steals, holding + stunned tags
- **Radar**: top-down arena with smoothed player positions, facing, disc trail, speed and altitude
- **Throw lab**: last throw speed with arm / wrist / movement breakdown, spin, session best, last 24 throws
- **Match feed**: goals, saves, stuns, steals, interceptions, joins and leaves

If the goals look like they're on the wrong ends, hit **Swap ends** (remembered per browser).
