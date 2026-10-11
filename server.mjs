// Echo Scoreboard — local server.
// Polls Echo VR's local API, serves the scoreboard page, and runs Autoclip
// (presses your Medal hotkey a few seconds after you score, save or assist).
//
//   node server.mjs                 -> reads 127.0.0.1:6721 (PC Echo)
//   node server.mjs 192.168.1.50    -> reads a Quest on your LAN
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ECHO_HOST = process.argv[2] || process.env.ECHO_HOST || '127.0.0.1';
const ECHO_URL = `http://${ECHO_HOST}:6721/session`;
const PORT = Number(process.env.PORT) || 6730;
const PUBLIC = fileURLToPath(new URL('./public/', import.meta.url));
// Writable data dir: the Electron shell sets ECHO_SCOREBOARD_DATA; standalone keeps files next to the server.
const DATA_DIR = process.env.ECHO_SCOREBOARD_DATA || fileURLToPath(new URL('./', import.meta.url));
const CONFIG = path.join(DATA_DIR, 'autoclip.json');
const AWARDS = JSON.parse(readFileSync(new URL('./mvp-awards.json', import.meta.url), 'utf8'));

/* ---------------- Echo poller ---------------- */
// Offline states are served as 200 + _offline so the browser console stays clean.
let latestText = JSON.stringify({ _offline: 'echo_unreachable', host: ECHO_HOST });

async function pollEcho() {
  let session;
  try {
    const r = await fetch(ECHO_URL, { signal: AbortSignal.timeout(800) });
    if (r.ok) {
      const text = (await r.text()).replace(/\0+$/, '');
      session = JSON.parse(text);
      latestText = text;
    } else {
      // Echo answers 404 while you're in the lobby/menus rather than a match.
      session = { _offline: 'not_in_match', status: r.status };
      latestText = JSON.stringify(session);
    }
  } catch {
    session = { _offline: 'echo_unreachable', host: ECHO_HOST };
    latestText = JSON.stringify(session);
  }
  autoclip.observe(session);
  mvp.observe(session);
  setTimeout(pollEcho, session._offline ? 1000 : 66);
}

/* ---------------- Key presser ---------------- */
// One long-lived hidden PowerShell that sends keystrokes via user32 keybd_event
// with both the virtual key and hardware scan code (what global hotkey hooks like Medal read).
const SCAN = { F1: 0x3B, F2: 0x3C, F3: 0x3D, F4: 0x3E, F5: 0x3F, F6: 0x40, F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44, F11: 0x57, F12: 0x58 };
let keyProc = null;
function keySender() {
  if (keyProc && keyProc.exitCode === null) return keyProc;
  keyProc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], { stdio: ['pipe', 'ignore', 'inherit'], windowsHide: true });
  keyProc.stdin.write(`Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class K{[DllImport("user32.dll")]public static extern void keybd_event(byte v,byte s,uint f,UIntPtr e);}'\n`);
  keyProc.on('exit', () => { keyProc = null; });
  return keyProc;
}
function pressKey(key) {
  const n = Number(String(key).replace(/^F/i, ''));
  if (!(n >= 1 && n <= 12)) throw new Error(`Unsupported key ${key}`);
  const vk = 0x6F + n, scan = SCAN['F' + n];
  keySender().stdin.write(`[K]::keybd_event(${vk},${scan},0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 60; [K]::keybd_event(${vk},${scan},2,[UIntPtr]::Zero)\n`);
}

/* ---------------- Autoclip ---------------- */
const autoclip = (() => {
  const defaults = { enabled: true, player: '', delay: 5, key: 'F2', events: { goal: true, save: true, assist: true } };
  let cfg = defaults;
  try { const saved = JSON.parse(readFileSync(CONFIG, 'utf8')); cfg = { ...defaults, ...saved, events: { ...defaults.events, ...saved.events } }; } catch {}

  let baseline = null;          // { sid, name, stats }
  let pending = null;           // { reasons, player, fireAt, timer }
  let tracking = { name: '', found: false, team: null, stats: null };
  const log = [];               // newest first
  let nextId = 1;

  const save = () => { try { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(CONFIG, JSON.stringify(cfg, null, 2)); } catch (e) { console.error('autoclip: could not save config', e.message); } };

  function findPlayer(s, name) {
    for (const t of [0, 1]) for (const p of (s.teams?.[t]?.players || [])) if (p.name === name) return { p, team: t ? 'orange' : 'blue' };
    return null;
  }

  function fire() {
    const entry = { id: nextId++, at: Date.now(), reasons: pending.reasons, player: pending.player, key: cfg.key, ok: true };
    try { pressKey(cfg.key); } catch (e) { entry.ok = false; entry.error = e.message; }
    console.log(`autoclip: ${entry.ok ? 'pressed ' + cfg.key : 'FAILED'} for ${entry.reasons.join(' + ')} (${entry.player})`);
    log.unshift(entry); if (log.length > 30) log.pop();
    pending = null;
  }

  function queue(reasons, player) {
    if (pending) { for (const r of reasons) if (!pending.reasons.includes(r)) pending.reasons.push(r); return; }
    const ms = Math.max(0, Number(cfg.delay) || 0) * 1000;
    pending = { reasons: [...reasons], player, fireAt: Date.now() + ms, timer: setTimeout(fire, ms) };
    console.log(`autoclip: ${reasons.join(' + ')} by ${player}, clipping in ${cfg.delay}s`);
  }

  function observe(s) {
    if (s._offline) { baseline = null; tracking = { name: cfg.player, found: false, team: null, stats: null }; return; }
    const name = cfg.player || s.client_name || '';
    const hit = findPlayer(s, name);
    tracking = { name, found: !!hit, team: hit?.team ?? null, stats: hit?.p.stats ?? null, isClient: !cfg.player };
    if (!hit) { baseline = null; return; }
    const st = hit.p.stats || {};
    if (!baseline || baseline.sid !== s.sessionid || baseline.name !== name) { baseline = { sid: s.sessionid, name, stats: st }; return; }
    const was = baseline.stats, reasons = [];
    if (cfg.events.goal && (st.goals || 0) > (was.goals || 0)) reasons.push('goal');
    if (cfg.events.save && (st.saves || 0) > (was.saves || 0)) reasons.push('save');
    if (cfg.events.assist && (st.assists || 0) > (was.assists || 0)) reasons.push('assist');
    baseline.stats = st;   // always advance, so toggling on later never fires on stale stats
    if (reasons.length && cfg.enabled) queue(reasons, name);
  }

  return {
    observe,
    state: () => ({ config: cfg, tracking, log, pending: pending && { reasons: pending.reasons, player: pending.player, fireIn: Math.max(0, pending.fireAt - Date.now()) } }),
    update(patch) {
      cfg = { ...cfg, ...patch, events: { ...cfg.events, ...(patch.events || {}) } };
      if (!SCAN[String(cfg.key).toUpperCase()]) cfg.key = 'F2';
      cfg.key = String(cfg.key).toUpperCase();
      cfg.delay = Math.min(30, Math.max(0, Number(cfg.delay) || 0));
      save();
    },
    test() { queue(['test'], tracking.name || 'test'); },
  };
})();

/* ---------------- MVP predictor ---------------- */
// Scores each player with the game's own award multipliers (mvp-awards.json, from player_rewards.json).
// Some stats aren't in the API, so they're derived by watching the stream (marked derived/approx).
const mvp = (() => {
  const humanize = n => n.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const DERIVED = new Set(['threepointgoals', 'onepointgoals', 'bouncegoals', 'hattricks', 'joustswon', 'longestpossession', 'clears']);
  // hattricks is exact given goals; the API flags interceptions as unreported correctly.
  const APPROX = new Set([...DERIVED, 'interceptions']); APPROX.delete('hattricks');
  const awardsMeta = AWARDS.awards.map(a => ({ name: a.name, label: humanize(a.name), stat: a.stat, multiplier: a.multiplier, derived: DERIVED.has(a.stat), approx: APPROX.has(a.stat) }));
  const maxShown = AWARDS.maxawardsdisplayed || 3;
  const len = v => v ? Math.hypot(v[0] || 0, v[1] || 0, v[2] || 0) : 0;
  const r1 = n => Math.round(n * 10) / 10;

  let sid = null, rows = new Map(), prev = null, joustPending = false, poss = null;   // poss: { name, since }
  let cache = { sessionid: null, mvp: null, players: [], awardsMeta };

  const newRow = (name, team) => ({ name, team, number: null, api: {}, pos: null, d: { threepointgoals: 0, onepointgoals: 0, bouncegoals: 0, joustswon: 0, longestpossession: 0, clears: 0 } });
  const statsOf = (r, now) => {
    const a = r.api, g = a.goals || 0;
    const live = poss && poss.name === r.name ? (now - poss.since) / 1000 : 0;
    return { stuns: a.stuns || 0, steals: a.steals || 0, assists: a.assists || 0, saves: a.saves || 0, goals: g, passes: a.passes || 0, catches: a.catches || 0,
      interceptions: a.interceptions || 0, shotsongoal: a.shots_taken || 0, ...r.d, hattricks: Math.floor(g / 3), longestpossession: r1(Math.max(r.d.longestpossession, live)) };
  };
  const endPossession = now => {
    if (!poss) return;
    const r = rows.get(poss.name); if (r) r.d.longestpossession = Math.max(r.d.longestpossession, (now - poss.since) / 1000);
    poss = null;
  };

  // The exact in-game MVP rule is still being researched. Current guess: highest total on the
  // leading team (highest overall when tied). Change only this function.
  function pickMvp(list, s) {
    const b = s.blue_points || 0, o = s.orange_points || 0;
    const pool = b === o ? list : list.filter(p => p.team === (b > o ? 'blue' : 'orange'));
    return (pool.length ? pool : list)[0] || null;   // list is sorted by total desc
  }

  function observe(s) {
    if (s._offline || !s.teams) return;
    const now = Date.now();
    if (s.sessionid !== sid) { sid = s.sessionid; rows = new Map(); prev = null; joustPending = false; poss = null; }
    let cur = null, curPos = null;
    for (const t of [0, 1]) for (const p of (s.teams[t]?.players || [])) {
      let r = rows.get(p.name); if (!r) rows.set(p.name, r = newRow(p.name, 'blue'));
      r.team = t ? 'orange' : 'blue'; r.number = p.number ?? r.number; r.api = p.stats || r.api; r.pos = p.head?.position || r.pos;
      if (p.possession) { cur = p.name; curPos = r.pos; }
    }
    const status = s.game_status, pts = (s.blue_points || 0) + (s.orange_points || 0), discSpeed = len(s.disc?.velocity);

    if (prev) {
      if (pts > prev.pts) {   // goal: point value / bounce from last_score
        const ls = s.last_score || {}, r = rows.get(ls.person_scored);
        if (r) {
          if (ls.point_amount === 3) r.d.threepointgoals++; else if (ls.point_amount === 1) r.d.onepointgoals++;
          if (/BOUNCE/i.test(ls.goal_type || '')) r.d.bouncegoals++;
        }
      }
      if (prev.status === 'round_start' && status === 'playing') joustPending = true;
      else if (status !== 'playing') joustPending = false;
      if (joustPending && cur) { rows.get(cur).d.joustswon++; joustPending = false; }   // first possession after round start
      // clear: release from own half, disc moving fast toward the opponent end
      if (prev.holder && !cur && status === 'playing' && discSpeed > 4) {
        const r = rows.get(prev.holder), z = (prev.pos || [0, 0, 0])[2], vz = s.disc?.velocity?.[2] || 0;
        if (r && (r.team === 'blue' ? z < 0 && vz > 0 : z > 0 && vz < 0)) r.d.clears++;
      }
    }
    if (cur !== (poss && poss.name)) { endPossession(now); if (cur) poss = { name: cur, since: now }; }
    prev = { pts, status, holder: cur, pos: curPos };

    const list = [...rows.values()].map(r => {
      const st = statsOf(r, now);
      const all = awardsMeta.map(a => ({ name: a.name, label: a.label, stat: a.stat, value: st[a.stat] || 0, score: r1((st[a.stat] || 0) * a.multiplier), derived: a.derived, approx: a.approx }));
      return { name: r.name, team: r.team, number: r.number, total: r1(all.reduce((n, a) => n + a.score, 0)),
        awards: all.filter(a => a.score > 0).sort((x, y) => y.score - x.score).slice(0, maxShown) };
    }).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    cache = { sessionid: sid, mvp: pickMvp(list, s), players: list, awardsMeta };
  }

  return { observe, state: () => cache };
})();

/* ---------------- HTTP ---------------- */
const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
const readBody = req => new Promise(ok => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch { ok({}); } }); });

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2' };

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/api/session') return json(res, 200, latestText);
  if (url === '/api/autoclip' && req.method === 'GET') return json(res, 200, autoclip.state());
  if (url === '/api/autoclip' && req.method === 'POST') { autoclip.update(await readBody(req)); return json(res, 200, autoclip.state()); }
  if (url === '/api/autoclip/test' && req.method === 'POST') { autoclip.test(); return json(res, 200, autoclip.state()); }
  if (url === '/api/mvp') return json(res, 200, mvp.state());
  // Static files from public/ by name; the resolved path must stay inside it.
  let rel; try { rel = decodeURIComponent(url); } catch { return res.writeHead(400).end(); }
  if (rel === '/') rel = '/index.html';
  const file = path.resolve(PUBLIC, '.' + rel);
  if (rel.includes('\0') || !file.startsWith(PUBLIC)) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    return res.end(body);
  } catch {}
  res.writeHead(404).end();
});
server.on('error', e => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Close the other Echo Scoreboard or set PORT=<number>.` : `Server error: ${e.message}`);
  process.exitCode = 1;
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Echo Scoreboard  ->  http://localhost:${PORT}`);
  console.log(`Reading Echo API at ${ECHO_URL}`);
  keySender();
  pollEcho();
});
