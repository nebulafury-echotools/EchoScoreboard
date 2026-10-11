// Scores candidate MVP rules against verified entries in mvp-log.jsonl.
//   node tools/mvp-rules.mjs [path/to/mvp-log.jsonl]     (default: $ECHO_SCOREBOARD_DATA or the project dir)
// Only entries where the game's real MVP was read (actual.mvp set) count. Use the result to tune pickMvp() in server.mjs.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const file = process.argv[2] || path.join(process.env.ECHO_SCOREBOARD_DATA || root, 'mvp-log.jsonl');
const AWARDS = JSON.parse(readFileSync(path.join(root, 'mvp-awards.json'), 'utf8')).awards;
const APPROX = new Set(['threepointgoals', 'onepointgoals', 'bouncegoals', 'hattricks', 'joustswon', 'longestpossession', 'clears', 'interceptions']);

let entries = [];
try { entries = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (e) { console.error(`Cannot read ${file}: ${e.message}`); process.exit(1); }
const verified = entries.filter(e => e.actual && e.actual.mvp);
console.log(`${file}\n${entries.length} matches logged, ${verified.length} verified against the game.\n`);
if (!verified.length) { console.log('Nothing to score yet (entries get actual.mvp when the MVP card is read after a match, or add it by hand).'); process.exit(0); }

const stat = (p, k) => (p.derived && p.derived[k] != null ? p.derived[k] : p.api?.[k]) || 0;
const awardTotal = (p, skipApprox) => AWARDS.reduce((n, a) => n + (skipApprox && APPROX.has(a.stat) ? 0 : stat(p, a.stat) * a.multiplier), 0);
// Same total with some stats re-weighted, e.g. { interceptions: 1.5 } (the API under-reports interceptions).
const weighted = (p, mult) => AWARDS.reduce((n, a) => n + stat(p, a.stat) * (mult[a.stat] ?? 1) * a.multiplier, 0);
const points = p => p.api?.points || 0;
const winner = e => e.final.blue === e.final.orange ? null : e.final.blue > e.final.orange ? 'blue' : 'orange';
// presentOnly: skip players who left before post_match (so far the game never gave MVP to one).
// presentOnly may also be a number of seconds: players who left at most that long before the end still count
// (entries logged before seenAgo was recorded treat every leaver as gone).
const stillIn = (p, grace) => !p.left || (typeof grace === 'number' && p.seenAgo != null && p.seenAgo <= grace);
const pickBy = (e, score, onlyWinners, presentOnly = false) => {
  const w = winner(e);
  let pool = presentOnly ? e.stats.filter(p => stillIn(p, presentOnly)) : e.stats;
  if (onlyWinners && w) pool = pool.filter(p => p.team === w);
  return [...pool].sort((a, b) => score(b, e) - score(a, e) || a.name.localeCompare(b.name))[0]?.name;
};

const rules = {
  'award total, winning team (current pickMvp)': e => pickBy(e, p => awardTotal(p), true),
  'award total, overall': e => pickBy(e, p => awardTotal(p), false),
  'award total excl. approximate stats, winning team': e => pickBy(e, p => awardTotal(p, true), true),
  'award total excl. approximate stats, overall': e => pickBy(e, p => awardTotal(p, true), false),
  'most points, winning team': e => pickBy(e, points, true),
  'most points, overall': e => pickBy(e, points, false),
  'award total + 25 win bonus, overall': e => pickBy(e, (p, x) => awardTotal(p) + (p.team === winner(x) ? 25 : 0), false),
  'award total + 100 win bonus, overall': e => pickBy(e, (p, x) => awardTotal(p) + (p.team === winner(x) ? 100 : 0), false),
  'goals+assists+saves, winning team': e => pickBy(e, p => (p.api?.goals || 0) + (p.api?.assists || 0) + (p.api?.saves || 0), true),
  'award total, players still in the match': e => pickBy(e, p => awardTotal(p), false, true),
  'award total, still in match, interceptions x1.5': e => pickBy(e, p => weighted(p, { interceptions: 1.5 }), false, true),
  'award total, still in match, interceptions x2': e => pickBy(e, p => weighted(p, { interceptions: 2 }), false, true),
  'award total, still in match, + possession seconds': e => pickBy(e, p => awardTotal(p) + (p.api?.possession_time || 0), false, true),
  'award total, still in match, three-pointers x0.5': e => pickBy(e, p => weighted(p, { threepointgoals: 0.5 }), false, true),
  'award total, still in or left <=15 s before end': e => pickBy(e, p => awardTotal(p), false, 15),
  'award total, still in or left <=15 s before end, interceptions x1.5': e => pickBy(e, p => weighted(p, { interceptions: 1.5 }), false, 15),
  // Found by brute force over award subsets on the first 23 matches (23/23 there, 16/23 leave-one-out): track it on new matches.
  'SEARCH: incl. leavers, int x1.5, no bruiser/long shot/team player/jouster/greedy': e => pickBy(e, p => weighted(p, { interceptions: 1.5, stuns: 0, threepointgoals: 0, assists: 0, joustswon: 0, longestpossession: 0 }), false),
  'previous live rule: no greedy, int x2, still in or left <=10 s before end': e => pickBy(e, p => weighted(p, { interceptions: 2, longestpossession: 0 }), false, 10),
  // Live pickMvp: jousts don't count toward MVP (per the game's behaviour), interceptions doubled.
  'LIVE: no jouster, int x2, still in or left <=10 s before end': e => pickBy(e, p => weighted(p, { interceptions: 2, joustswon: 0 }), false, 10),
  'no jouster, int x1.5, still in or left <=10 s before end': e => pickBy(e, p => weighted(p, { interceptions: 1.5, joustswon: 0 }), false, 10),
  'no jouster, int x1, still in or left <=10 s before end': e => pickBy(e, p => weighted(p, { joustswon: 0 }), false, 10),
  'logged prediction (what the server picked live)': e => e.predicted?.mvp,
};

const rows = Object.entries(rules).map(([name, fn]) => {
  const hits = verified.filter(e => fn(e) === e.actual.mvp).length;
  return { rule: name, correct: `${hits}/${verified.length}`, accuracy: Math.round(1000 * hits / verified.length) / 10 + '%' };
}).sort((a, b) => parseFloat(b.accuracy) - parseFloat(a.accuracy));
console.table(rows);
