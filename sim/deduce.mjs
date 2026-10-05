// Gate check: are games solvable from public clues alone?
// Compares a "deducer" town player (uses only what the screen shows) with a
// random one, and reports balance and how much the rivals actually say.
// Usage: node sim/deduce.mjs [runs=600]

import { createGame, act } from '../src/core/engine.js';
import { createRng } from '../src/core/rng.js';
import { HUMAN_ID } from '../src/core/characters.js';

const RUNS = +process.argv[2] || 600;

// Public-clue suspicion of t, as a careful player would tally it.
function clueScore(g, t) {
  let s = 0;
  const deaths = g.deaths;
  for (const v of deaths.filter((x) => x.how === 'night')) {
    if ((g.statements[v.day] || []).some((st) => st.speaker === v.id && st.intent === 'accuse' && st.target === t)) s += 1;
  }
  for (const d of Object.keys(g.votes)) {
    const mine = g.votes[d].find((v) => v.voter === t);
    if (!mine) continue;
    for (const m of deaths.filter((x) => x.role === 'mafia')) {
      const mv = g.votes[d].find((v) => v.voter === m.id);
      if (mv && mv.target === mine.target && m.id !== t) s += 1;
    }
    const ex = deaths.find((x) => x.day === +d && x.how === 'vote');
    if (ex && mine.target === ex.id && ex.role !== 'mafia') s += 0.4;
  }
  for (const bp of g.brokenPromises) if (bp.who === t) s += 2;
  for (const d of Object.keys(g.statements)) {
    for (const st of g.statements[d]) {
      if (st.speaker === t && st.intent === 'defend' && deaths.some((x) => x.id === st.target && x.role === 'mafia')) s += 1.5;
      if (st.intent === 'claim' && st.target === t && st.speaker !== t) {
        const claimerDead = deaths.find((x) => x.id === st.speaker);
        const liar = (claimerDead && claimerDead.role !== 'seer') || deaths.some((x) => x.role === 'seer' && x.id !== st.speaker);
        if (!liar) s += st.result === 'mafia' ? 2 : -1.5;
      }
    }
  }
  // A seer claimer while the revealed real seer is someone else is lying.
  const realSeer = deaths.find((x) => x.role === 'seer');
  const claimed = Object.values(g.statements).flat().some((st) => st.speaker === t && st.intent === 'claim');
  if (claimed && realSeer && realSeer.id !== t) s += 4;
  return s;
}

function play(policy, seed, forceRole) {
  const rng = createRng(seed ^ 0x51ed);
  const g = createGame({ n: 1, seed, forceRole });
  let guard = 0;
  while (g.pending && guard++ < 300) {
    const p = g.pending;
    if (p.type === 'spectate') act(g, { type: 'continue' });
    else if (p.type === 'statement') {
      if (policy === 'deducer' && p.canAsk && p.askable.length) {
        // Ask someone for their vote plan to create a promise that can be checked.
        act(g, { type: 'ask', target: rng.pick(p.askable), q: g.day === 1 ? 'vote' : 'role' });
        continue;
      }
      act(g, { intent: 'pass' });
    } else if (p.type === 'vote') {
      if (policy === 'deducer') {
        const best = p.targets.map((t) => ({ t, s: clueScore(g, t) + rng.next() * 0.01 })).sort((a, b) => b.s - a.s)[0].t;
        act(g, { type: 'vote', target: best });
      } else act(g, { type: 'vote', target: rng.pick(p.targets) });
    } else if (p.type === 'defense') act(g, { intent: 'deny' });
    else if (p.type === 'verdict') {
      if (policy === 'deducer') {
        const ranked = g.players.filter((x) => x.alive && x.id !== HUMAN_ID).map((x) => ({ t: x.id, s: clueScore(g, x.id) })).sort((a, b) => b.s - a.s);
        act(g, { yes: ranked[0]?.t === p.target || clueScore(g, p.target) > 0.5 });
      } else act(g, { yes: rng.next() < 0.5 });
    } else act(g, p.action === 'sleep' ? {} : { target: rng.pick(p.targets) });
  }
  return g;
}

function run(policy, role) {
  let townWins = 0;
  let days = 0;
  for (let s = 1; s <= RUNS; s++) {
    const g = play(policy, s * 7919, role);
    if (g.winner === 'town') townWins++;
    days += g.day;
  }
  return { town: townWins / RUNS, days: days / RUNS };
}

const pct = (x) => `${(100 * x).toFixed(1)}%`;
const r = run('random', 'villager');
const d = run('deducer', 'villager');
console.log(`town win (you villager): random ${pct(r.town)} | deducer ${pct(d.town)} | gap ${((d.town - r.town) * 100).toFixed(1)} pts`);
const m = run('random', 'mafia');
console.log(`mafia win (you mafia, random play): ${pct(1 - m.town)} | avg days ${m.days.toFixed(2)}`);

// Speech stats: are day-1 hunches equally likely from both sides, and how much is said?
let mafAcc = 0, mafN = 0, townAcc = 0, townN = 0, lines = 0, gamesN = 0, fake = 0, broken = 0;
for (let s = 1; s <= RUNS; s++) {
  const g = play('deducer', s * 104729, 'villager');
  gamesN++;
  for (const st of g.statements[1] || []) {
    if (st.speaker === HUMAN_ID || st.round !== 1) continue;
    const mafia = g.players.find((x) => x.id === st.speaker).role === 'mafia';
    if (mafia) (mafN++, (mafAcc += st.intent === 'accuse' ? 1 : 0));
    else (townN++, (townAcc += st.intent === 'accuse' ? 1 : 0));
  }
  lines += (g.statements[1] || []).filter((st) => st.speaker !== HUMAN_ID && !['pass', 'skip'].includes(st.intent)).length;
  fake += Object.values(g.statements).flat().some((st) => st.fake) ? 1 : 0;
  broken += g.brokenPromises.length ? 1 : 0;
}
console.log(`day-1 round-1 accusation rate: mafia rivals ${pct(mafAcc / mafN)} | town rivals ${pct(townAcc / townN)}`);
console.log(`substantive rival lines on day 1: ${(lines / gamesN).toFixed(1)} | games with a fake seer: ${pct(fake / gamesN)} | games with a broken promise: ${pct(broken / gamesN)}`);
