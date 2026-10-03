// Headless simulation: scripted players x many runs, memory on vs off.
// Measures whether tells change AI decisions, and how soon they surface.
// Usage: node sim/simulate.mjs [runs=300] [games=8]

import { createGame, act, gameRecord } from '../src/core/engine.js';
import { createRng } from '../src/core/rng.js';
import { HUMAN_ID } from '../src/core/characters.js';

const RUNS = +process.argv[2] || 300;
const GAMES = +process.argv[3] || 8;

// p = probabilities of each habit for (mafia, town)
const POLICIES = {
  consistent: { first: [0.9, 0.1], accuse: [0.9, 0.15], pass: [0.05, 0.7], killAccuser: 0.9 },
  natural: { first: [0.65, 0.3], accuse: [0.6, 0.35], pass: [0.2, 0.45], killAccuser: 0.6 },
  noisy: { first: [0.5, 0.5], accuse: [0.45, 0.45], pass: [0.3, 0.3], killAccuser: 0.4 },
  // Consistent for 4 games, then plays mafia like its own town self (planting fakes).
  switcher: { first: [0.9, 0.1], accuse: [0.9, 0.15], pass: [0.05, 0.7], killAccuser: 0.9, switchAt: 5 },
};

function playGame(policy, n, past, memory, seed) {
  const rng = createRng(seed ^ 0x9e3779b9);
  const g = createGame({ n, pastGames: past, memory, seed });
  const mafia = g.humanRole === 'mafia';
  let pol = policy;
  if (policy.switchAt && n >= policy.switchAt && mafia) {
    pol = { ...policy, first: [policy.first[1], policy.first[1]], accuse: [policy.accuse[1], 0], pass: [policy.pass[1], 0], killAccuser: 0.1 };
  }
  const i = mafia ? 0 : 1;
  let wantFirst = null;
  let guard = 0;
  while (g.pending && guard++ < 100) {
    const p = g.pending;
    if (p.type === 'spectate') act(g, { type: 'continue' });
    else if (p.type === 'statement') {
      const r = rng.next();
      const nonHuman = p.targets;
      if (p.claims.length) act(g, { intent: 'claim', target: p.claims[0].target });
      else if (r < pol.accuse[i]) act(g, { intent: 'accuse', target: rng.pick(nonHuman) });
      else if (r < pol.accuse[i] + pol.pass[i]) act(g, { intent: 'pass' });
      else act(g, { intent: 'defend', target: rng.pick(nonHuman) });
      wantFirst = rng.next() < pol.first[i];
    } else if (p.type === 'vote') {
      if (p.canWait && (!wantFirst && p.votes.length < 2)) {
        act(g, { type: 'wait' });
        continue;
      }
      // Seer votes their known mafia; others vote someone who accused them or random.
      const known = g.seerChecks.find((x) => x.seer === HUMAN_ID && x.result === 'mafia' && p.targets.includes(x.target));
      const accusers = (g.statements[g.day] || []).filter((s) => s.intent === 'accuse' && s.target === HUMAN_ID).map((s) => s.speaker).filter((s) => p.targets.includes(s));
      const target = known?.target ?? (accusers.length && rng.next() < 0.5 ? rng.pick(accusers) : rng.pick(p.targets));
      act(g, { type: 'vote', target });
    } else if (p.type === 'night') {
      if (p.action === 'sleep') act(g, {});
      else if (p.action === 'kill') {
        const acc = (g.statements[g.day] || []).filter((s) => s.intent === 'accuse' && s.target === HUMAN_ID).map((s) => s.speaker).filter((s) => p.targets.includes(s));
        const t = acc.length && rng.next() < pol.killAccuser ? rng.pick(acc) : rng.pick(p.targets);
        act(g, { target: t });
      } else act(g, { target: rng.pick(p.targets) });
    }
  }
  return g;
}

function runPolicy(name, memory) {
  const policy = POLICIES[name];
  const firstCite = [];
  const firstFlip = [];
  const byGame = Array.from({ length: GAMES }, () => ({ mafiaGames: 0, mafiaCaught: 0, townGames: 0, townLynched: 0, flips: 0, reads: 0, deceived: 0, misread: 0, cites: 0 }));
  for (let r = 0; r < RUNS; r++) {
    const past = [];
    let fc = null;
    let ff = null;
    for (let n = 1; n <= GAMES; n++) {
      const g = playGame(policy, n, past, memory, r * 1000 + n);
      const rec = gameRecord(g);
      past.push(rec);
      const b = byGame[n - 1];
      const humanDeath = g.deaths.find((x) => x.id === HUMAN_ID);
      if (rec.side === 'mafia') {
        b.mafiaGames++;
        if (humanDeath?.how === 'vote') b.mafiaCaught++;
      } else {
        b.townGames++;
        if (humanDeath?.how === 'vote') b.townLynched++;
      }
      b.flips += rec.flips.length;
      b.reads += rec.flips.filter((f) => f.kind === 'read').length;
      b.deceived += rec.flips.filter((f) => f.kind === 'deceived').length;
      b.misread += rec.flips.filter((f) => f.kind === 'misread').length;
      const cites = g.events.filter((e) => (e.t === 'statement' || e.t === 'aside') && e.evidence?.length && e.speaker !== HUMAN_ID);
      b.cites += cites.length;
      if (fc === null && cites.some((e) => e.target === HUMAN_ID && (e.intent === 'accuse' || e.kind === 'suspect'))) fc = n;
      if (ff === null && rec.flips.length) ff = n;
    }
    firstCite.push(fc);
    firstFlip.push(ff);
  }
  return { firstCite, firstFlip, byGame };
}

function dist(arr) {
  const c = {};
  for (const x of arr) c[x ?? 'never'] = (c[x ?? 'never'] || 0) + 1;
  return Object.entries(c)
    .map(([k, v]) => `${k}:${((100 * v) / arr.length).toFixed(0)}%`)
    .join(' ');
}
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(0) + '%' : '-');

const t0 = Date.now();
const summary = {};
for (const name of Object.keys(POLICIES)) {
  const on = runPolicy(name, true);
  const off = runPolicy(name, false);
  console.log(`\n=== policy: ${name} (${RUNS} runs x ${GAMES} games) ===`);
  console.log('first game with tell-based accusation of you:', dist(on.firstCite));
  console.log('first game where memory flipped an AI vote: ', dist(on.firstFlip));
  console.log('game | mafia caught on/off | town lynched on/off | flips/game (read, deceived, misread) | cites/game');
  for (let n = 0; n < GAMES; n++) {
    const a = on.byGame[n];
    const b = off.byGame[n];
    console.log(
      `${String(n + 1).padStart(4)} | ${pct(a.mafiaCaught, a.mafiaGames).padStart(5)} / ${pct(b.mafiaCaught, b.mafiaGames).padEnd(5)} | ${pct(a.townLynched, a.townGames).padStart(5)} / ${pct(b.townLynched, b.townGames).padEnd(5)} | ${(a.flips / RUNS).toFixed(2)} (${(a.reads / RUNS).toFixed(2)}, ${(a.deceived / RUNS).toFixed(2)}, ${(a.misread / RUNS).toFixed(2)}) | ${(a.cites / RUNS).toFixed(2)}`,
    );
  }
  const agg = (bg, k1, k2) => bg.slice(2).reduce((s, x) => s + x[k1], 0) / Math.max(1, bg.slice(2).reduce((s, x) => s + x[k2], 0));
  summary[name] = {
    firstCite: dist(on.firstCite),
    mafiaCaughtFromGame3: { memoryOn: agg(on.byGame, 'mafiaCaught', 'mafiaGames'), memoryOff: agg(off.byGame, 'mafiaCaught', 'mafiaGames') },
    townLynchedFromGame3: { memoryOn: agg(on.byGame, 'townLynched', 'townGames'), memoryOff: agg(off.byGame, 'townLynched', 'townGames') },
  };
}
console.log('\nsummary', JSON.stringify(summary, null, 1));
console.log(`elapsed ${Date.now() - t0}ms`);
