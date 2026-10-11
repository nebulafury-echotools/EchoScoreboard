// MVP verification: at the end of each match, snapshot the predictor's pick and try to read the game's real MVP,
// then append one line per match to <dataDir>/mvp-log.jsonl (tune pickMvp() from it with tools/mvp-rules.mjs).
//
// Echo's API has no MVP/award fields at post_match, so the real result comes from OCR of the game window
// (tools/capture-ocr.ps1, background capture, no focus needed). The MVP and award cards stand in the middle of the
// arena after the match; a spectator's camera is moved there with Echo's camera API (as Spark's camera write does),
// then put back in sideline mode.
import { spawn } from 'node:child_process';
import { readFileSync, appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SCRIPT = fileURLToPath(new URL('./tools/capture-ocr.ps1', import.meta.url));
const END_STATES = new Set(['post_match', 'post_sudden_death']);
const MAX_CAPTURES = 60;

/* ---------------- OCR parsing (pure, testable) ---------------- */
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
// Does a normalised line contain a normalised label? Allows ~1 edit per 5 chars (OCR slips), none for very short labels.
function fuzzyContains(line, label) {
  if (!label) return false;
  if (line.includes(label)) return true;
  if (line.length >= 8 && label.startsWith(line)) return true;   // the card truncates long names
  const tol = label.length >= 10 ? 2 : label.length >= 5 ? 1 : 0;
  if (!tol) return false;
  for (let w = label.length - tol; w <= label.length + tol; w++)
    for (let i = 0; i + w <= line.length; i++) if (editDistance(line.slice(i, i + w), label) <= tol) return true;
  return false;
}
const center = l => [l.x + l.w / 2, l.y + l.h / 2];
const dist = (a, b) => { const [ax, ay] = center(a), [bx, by] = center(b); return Math.hypot(ax - bx, ay - by); };

// shots: [{ lines: [{ text, x, y, w, h }] }]; roster: names; awardLabels: ['Bruiser', 'Long Shot', ...]
// Each card shows a player name with its title just below ("Arima" / "MVP", "COGNITO" / "BRUISER" / "17 STUNS"),
// so this is proximity based: the roster name closest to an "MVP" label is the MVP, and each award label belongs to the closest name.
export function parseOcr(shots, roster, awardLabels) {
  const names = roster.map(n => ({ name: n, n: norm(n) })).filter(r => r.n.length >= 2);
  const labels = awardLabels.map(l => ({ label: l, n: norm(l) }));
  const best = { mvp: null, awards: {}, score: -1 };
  for (const shot of shots) {
    const lines = (shot.lines || []).map(l => ({ ...l, n: norm(l.text) })).filter(l => l.n);
    const nameLines = [], mvpLines = [], awardLines = [];
    for (const l of lines) {
      for (const r of names) {
        const hit = r.n.length >= 4 ? fuzzyContains(l.n, r.n) : (l.n === r.n || l.text.toLowerCase().split(/\s+/).map(norm).includes(r.n));
        if (hit) nameLines.push({ ...l, name: r.name });
      }
      if (/^[mnu][vy]p$/.test(l.n) || l.n.includes('mvp')) mvpLines.push(l);   // OCR reads the stylised MVP as UVP/NVP at times
      for (const a of labels) if (fuzzyContains(l.n, a.n)) awardLines.push({ ...l, label: a.label });
    }
    let mvpName = null;
    for (const m of mvpLines) {
      const near = nameLines.filter(n => dist(n, m) < Math.max(150, 8 * m.h)).sort((a, b) => dist(a, m) - dist(b, m))[0];   // the card puts the name just above its label
      if (near) { mvpName = near.name; break; }
    }
    const awards = {};
    for (const a of awardLines) {
      const near = nameLines.filter(n => dist(n, a) < Math.max(120, 5 * a.h)).sort((x, y) => dist(x, a) - dist(y, a))[0];
      if (!near) continue;
      const list = awards[near.name] ||= [];
      if (!list.includes(a.label)) list.push(a.label);
    }
    const score = (mvpName ? 10 : 0) + Object.values(awards).reduce((n, v) => n + v.length, 0);
    if (score > best.score) Object.assign(best, { mvp: mvpName, awards, score });
  }
  return { mvp: best.mvp, awards: best.awards, found: best.score > 0 };
}

/* ---------------- spectator camera ---------------- */
// 4 m out from the centre on the long axis, at head height, looking at the centre: the MVP card and the award cards
// fill the frame with nothing in front of them. Echo only honours Spark's flat field names (px..qw);
// {position, rotation} bodies are accepted but ignored. Much further out (16 m) the camera leaves the arena.
const PODIUM_CAM = (() => {
  const pos = [0, 1.5, 4], d = pos.map(v => -v);
  const yaw = Math.atan2(d[0], d[2]), pitch = Math.atan2(-d[1], Math.hypot(d[0], d[2]));   // Unity: yaw about +Y, then pitch (down is +)
  const a = Math.sin(yaw / 2), w1 = Math.cos(yaw / 2), b = Math.sin(pitch / 2), w2 = Math.cos(pitch / 2);
  return { px: pos[0], py: pos[1], pz: pos[2], qx: w1 * b, qy: w2 * a, qz: -a * b, qw: w1 * w2, fovy: 1.3 };
})();
async function echoPost(base, p, body) {
  try { const r = await fetch(`${base}/${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(2000) }); return r.ok; }
  catch { return false; }
}

/* ---------------- capture ---------------- */
function runCapture(outDir, args = []) {
  return new Promise(resolve => {
    if (!existsSync(SCRIPT)) return resolve({ ok: false, error: 'capture_script_missing', shots: [] });
    let out = '', done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-OutDir', outDir, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    p.stdout.setEncoding('utf8'); p.stdout.on('data', d => out += d);
    const timer = setTimeout(() => { p.kill(); finish({ ok: false, error: 'capture_timeout', shots: [] }); }, 240000);
    p.on('error', e => finish({ ok: false, error: e.message, shots: [] }));
    p.on('close', () => { clearTimeout(timer); try { finish(JSON.parse(out)); } catch { finish({ ok: false, error: 'capture_bad_output', shots: [] }); } });
  });
}
function trimCaptures(dir) {
  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.png')).map(f => ({ f, t: statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const x of files.slice(MAX_CAPTURES)) unlinkSync(path.join(dir, x.f));
  } catch {}
}

/* ---------------- verifier ---------------- */
// getPrediction() returns the mvp tracker state: { mvp, players: [{ name, team, total, awards, stats }] }.
// echoBase: Echo's API root (http://host:6721), used to aim a spectator's camera at the MVP cards.
export function createVerifier({ dataDir, awardsMeta, getPrediction, echoBase }) {
  const logFile = path.join(dataDir, 'mvp-log.jsonl');
  const capDir = path.join(dataDir, 'captures');
  let lastStatus = null, busy = null;
  const done = new Set();

  const isSpectating = s => {
    const me = s.client_name;
    return !!me && ![0, 1].some(t => (s.teams?.[t]?.players || []).some(p => p.name === me));
  };

  async function verify(s) {
    const pred = getPrediction();
    const snap = {
      at: Date.now(), sessionid: s.sessionid, final: { blue: s.blue_points ?? null, orange: s.orange_points ?? null }, endClock: s.game_clock ?? null,
      client_name: s.client_name ?? null, spectating: isSpectating(s), match_type: s.match_type ?? null, private_match: !!s.private_match,
      predicted: { mvp: pred.mvp ? pred.mvp.name : null, players: pred.players.map(p => ({ name: p.name, team: p.team, total: p.total, awards: p.awards.map(a => ({ name: a.name, score: a.score, value: a.value })) })) },
      stats: [0, 1].flatMap(t => (s.teams?.[t]?.players || []).map(p => {
        const row = pred.players.find(x => x.name === p.name);
        return { name: p.name, team: t ? 'orange' : 'blue', api: p.stats || {}, derived: row?.stats || null, total: row?.total ?? null };
      })),
    };
    // players who left before post_match are gone from the API roster but still tracked by the predictor (and may be the MVP)
    for (const row of pred.players) if (!snap.stats.some(p => p.name === row.name)) snap.stats.push({ name: row.name, team: row.team, api: {}, derived: row.stats || null, total: row.total, left: true, seenAgo: row.seenAgo ?? null, seenClock: row.seenClock ?? null });
    const roster = snap.stats.map(p => p.name);
    const actual = { source: 'ocr', mvp: null, awards: {}, reason: null, ocrText: '', captures: [] };
    const aimed = snap.spectating && echoBase && await echoPost(echoBase, 'camera_mode', { mode: 'api' }) && await echoPost(echoBase, 'camera_transform', PODIUM_CAM);
    actual.camera = aimed ? 'podium' : snap.spectating ? 'unchanged' : 'player';
    // The cards don't always appear right away (seen after a match where a team left), so keep looking for up to
    // ~50 s: a first burst, then slower ones, stopping as soon as the MVP card is read.
    const bursts = [['-Shots', '10', '-IntervalMs', '1000', '-DelayMs', aimed ? '900' : '500'], ['-Shots', '10', '-IntervalMs', '2000'], ['-Shots', '10', '-IntervalMs', '2000']];
    const shots = [];
    let cap = { ok: true }, parsed = null;
    try {
      for (const args of bursts) {
        cap = await runCapture(capDir, args);
        shots.push(...(cap.shots || []));
        if (!cap.ok || (shots.length && shots.every(x => x.error))) break;
        parsed = parseOcr(shots, roster, awardsMeta.map(a => a.label));
        if (parsed.mvp) break;
      }
    } finally { if (aimed) await echoPost(echoBase, 'camera_mode', { mode: 'sideline' }); }
    actual.captures = shots.map(x => x.file && path.basename(x.file)).filter(Boolean);
    actual.ocrText = shots.map(x => x.text || '').filter(Boolean).join(' | ').slice(0, 1500);
    if (!cap.ok) actual.reason = cap.error === 'echo_window_not_found' ? 'echo_not_visible' : `capture_failed: ${cap.error}`;
    else if (shots.length && shots.every(x => x.error)) actual.reason = 'echo_not_visible';
    else if (parsed?.mvp) { actual.mvp = parsed.mvp; actual.awards = parsed.awards; }
    else actual.reason = snap.spectating && !aimed ? 'camera_not_aimed' : 'mvp_not_found_in_ocr';
    const entry = { ...snap, actual, correct: actual.mvp ? actual.mvp === snap.predicted.mvp : null };
    try { mkdirSync(dataDir, { recursive: true }); appendFileSync(logFile, JSON.stringify(entry) + '\n'); } catch (e) { console.error('mvp-verify: could not write log', e.message); }
    trimCaptures(capDir);
    console.log(`mvp-verify: ${snap.sessionid} predicted ${snap.predicted.mvp} actual ${actual.mvp ?? '-'} (${actual.reason || 'ocr'})`);
  }

  function observe(s) {
    const status = s._offline ? null : s.game_status;
    if (END_STATES.has(status) && !END_STATES.has(lastStatus) && s.sessionid && !done.has(s.sessionid) && !busy) {
      done.add(s.sessionid);
      busy = verify(JSON.parse(JSON.stringify(s))).catch(e => console.error('mvp-verify:', e.message)).finally(() => { busy = null; });
    }
    if (status !== null) lastStatus = status;   // an API gap (404 between matches) doesn't re-arm the trigger
  }

  function entries(limit = 200) {
    let lines = [];
    try { lines = readFileSync(logFile, 'utf8').split('\n').filter(Boolean); } catch {}
    return lines.slice(-limit).reverse().map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
  function state() {
    const all = entries();
    const verified = all.filter(e => typeof e.correct === 'boolean'), correct = verified.filter(e => e.correct).length;
    const slim = all.slice(0, 30).map(e => { const a = { ...e.actual }; delete a.ocrText; return { ...e, actual: a, stats: undefined }; });
    return { entries: slim, pending: !!busy, summary: { matches: all.length, verified: verified.length, correct, accuracy: verified.length ? Math.round(1000 * correct / verified.length) / 10 : null } };
  }
  return { observe, state };
}
