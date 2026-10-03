// Turn-based game state machine. Pure logic: no DOM, no network, no storage.
// Decisions (statements, votes, kills) are made here in code; dialogue text is
// rendered later from the event specs this module emits.

import { createRng } from './rng.js';
import { CHARACTERS, HUMAN_ID, charById } from './characters.js';
import { buildTellModel, tellTerm, evidenceForTerm, roleSide } from './tells.js';

export const ROLE_KO = { mafia: '마피아', seer: '예언자', villager: '시민' };

const HERD = { leon: 0.2, mio: 0.4, bruno: -0.1, sera: 0.15 };
const EVIDENCE_THRESHOLD = 0.35; // |tell term| needed before a rival cites memory

// First games are scheduled so both roles get observed quickly:
// tells are role differences, so the AI needs at least one game of each.
export function roleForGame(n, pastGames, rng) {
  const sides = pastGames.map((g) => roleSide(g.role));
  let side;
  if (n === 1) side = 'town';
  else if (n === 2) side = 'mafia';
  else if (n === 3) side = 'town';
  else if (n === 4) side = 'mafia';
  else {
    const last2 = sides.slice(-2);
    if (last2.length === 2 && last2[0] === last2[1]) side = last2[0] === 'mafia' ? 'town' : 'mafia';
    else side = rng.next() < 0.45 ? 'mafia' : 'town';
  }
  if (side === 'mafia') return 'mafia';
  return rng.next() < 0.3 ? 'seer' : 'villager';
}

export function createGame({ n, pastGames = [], memory = true, seed = Date.now(), forceRole = null }) {
  const rng = createRng(seed);
  const humanRole = forceRole ?? roleForGame(n, pastGames, rng);
  const others = ['mafia', 'seer', 'villager', 'villager', 'villager'];
  others.splice(others.indexOf(humanRole), 1);
  const aiRoles = rng.shuffle(others);
  const players = [
    { id: HUMAN_ID, role: humanRole, alive: true },
    ...CHARACTERS.map((c, i) => ({ id: c.id, role: aiRoles[i], alive: true })),
  ];
  const ids = players.map((p) => p.id);
  // A fixed per-game "gut feeling" each rival has about each player.
  const gut = {};
  for (const c of CHARACTERS) {
    gut[c.id] = {};
    for (const t of ids) if (t !== c.id) gut[c.id][t] = rng.normal() * 0.35;
  }
  // Games played with memory off never feed tells, keeping the off switch a clean comparison.
  const model = buildTellModel(memory ? pastGames.filter((x) => x.memory !== false) : [], n);
  const g = {
    n,
    seed,
    rng,
    memory,
    model,
    gut,
    players,
    humanRole,
    day: 1,
    phase: 'statement',
    obs: [],
    statements: {},
    votes: {},
    voteOrder: {},
    seerChecks: [], // {seer, target, result, night}
    deaths: [],
    flips: [],
    asides: {},
    events: [],
    winner: null,
    pending: null,
  };
  emit(g, { t: 'start', n, role: humanRole });
  emit(g, { t: 'phase', phase: 'statement', day: 1 });
  setPending(g);
  return g;
}

// ---------- helpers ----------

function emit(g, ev) {
  g.events.push(ev);
  return ev;
}
const player = (g, id) => g.players.find((p) => p.id === id);
const alive = (g) => g.players.filter((p) => p.alive);
const aliveIds = (g) => alive(g).map((p) => p.id);
const isAlive = (g, id) => player(g, id)?.alive;
const humanAlive = (g) => isAlive(g, HUMAN_ID);
const mafiaId = (g) => g.players.find((p) => p.role === 'mafia').id;
const seerId = (g) => g.players.find((p) => p.role === 'seer').id;

function accusersOf(g, day, target) {
  return (g.statements[day] || [])
    .filter((s) => s.intent === 'accuse' && s.target === target)
    .map((s) => s.speaker);
}

function claimsAbout(g, t) {
  const out = [];
  for (const d of Object.keys(g.statements)) {
    for (const s of g.statements[d]) if (s.intent === 'claim' && s.target === t) out.push(s);
  }
  return out;
}

function humanTell(g, cid) {
  if (!g.memory) return { total: 0, parts: [] };
  return tellTerm(g.model, charById[cid].watches, g.obs);
}

// Suspicion that rival `cid` (playing town) holds toward `t`.
// Returns both components so decisions can be compared with memory removed.
function suspicion(g, cid, t) {
  const c = charById[cid];
  const P = c.personality;
  let base = g.gut[cid][t] ?? 0;
  for (const d of Object.keys(g.statements)) {
    for (const s of g.statements[d]) {
      if (s.speaker === t && s.intent === 'accuse' && s.target === cid) base += P.grudge;
      if (s.speaker === t && s.intent === 'defend' && s.target === cid) base -= 0.2;
      // Defending someone later revealed as mafia is damning; accusing a revealed townie is suspicious.
      const dead = g.deaths.find((x) => x.id === s.target);
      if (s.speaker === t && dead) {
        const wasMafia = dead.role === 'mafia';
        if (s.intent === 'defend') base += wasMafia ? 1.5 : -0.2;
        if (s.intent === 'accuse' && dead.how === 'vote') base += wasMafia ? -0.8 : 0.4;
      }
    }
  }
  // Votes for an executed townie look bad the next day.
  for (const d of Object.keys(g.votes)) {
    const executed = g.deaths.find((x) => x.day === +d && x.how === 'vote');
    if (!executed) continue;
    for (const v of g.votes[d]) {
      if (v.voter === t && v.target === executed.id) base += executed.role === 'mafia' ? -0.6 : 0.5;
    }
  }
  // Seer information, own and claimed.
  const own = g.seerChecks.find((x) => x.seer === cid && x.target === t);
  if (own) base += own.result === 'mafia' ? 6 : -6;
  for (const cl of claimsAbout(g, t)) {
    if (cl.speaker === cid) continue;
    base += P.trustSeer * (cl.result === 'mafia' ? 2.4 : -1.4);
  }
  // A claim that contradicts my own seer check exposes the claimer.
  if (player(g, cid).role === 'seer') {
    for (const d of Object.keys(g.statements)) {
      for (const s of g.statements[d]) {
        if (s.intent !== 'claim' || s.speaker !== t) continue;
        const mine = g.seerChecks.find((x) => x.seer === cid && x.target === s.target);
        if (mine && mine.result !== s.result) base += 4;
        if (s.speaker === t) base += 2; // I'm the real seer, so any claimer is lying
      }
    }
  }
  let tell = 0;
  let term = null;
  if (t === HUMAN_ID) {
    term = humanTell(g, cid);
    tell = term.total;
  }
  return { base, tell, term, total: base + tell };
}

// The hidden mafia rival picks whoever the town already distrusts most.
function frameScores(g, mid) {
  const scores = {};
  const townAIs = alive(g).filter((p) => p.id !== mid && p.id !== HUMAN_ID);
  for (const t of aliveIds(g)) {
    if (t === mid) continue;
    let sum = 0;
    let k = 0;
    for (const a of townAIs) {
      if (a.id === t) continue;
      sum += suspicion(g, a.id, t).total;
      k++;
    }
    let s = k ? sum / k : 0;
    // Remove the seer, real or claimed.
    if ((g.statements[g.day - 1] || []).some((st) => st.speaker === t && st.intent === 'claim')) s += 1.5;
    scores[t] = s + (g.gut[mid][t] ?? 0);
  }
  return scores;
}

// ---------- pending human action ----------

function setPending(g) {
  if (g.phase === 'over') {
    g.pending = null;
    return;
  }
  if (!humanAlive(g)) {
    g.pending = { type: 'spectate' };
    return;
  }
  const others = aliveIds(g).filter((id) => id !== HUMAN_ID);
  if (g.phase === 'statement') {
    const checks = g.seerChecks.filter((x) => x.seer === HUMAN_ID && isAlive(g, x.target));
    g.pending = {
      type: 'statement',
      targets: others,
      claims: g.humanRole === 'seer' ? checks.map((x) => ({ target: x.target, result: x.result })) : [],
    };
  } else if (g.phase === 'vote') {
    const remaining = g.voteOrder[g.day].filter((id) => !g.votes[g.day].some((v) => v.voter === id));
    g.pending = { type: 'vote', targets: others, canWait: remaining.length > 0, votes: g.votes[g.day].slice() };
  } else if (g.phase === 'night') {
    if (g.humanRole === 'mafia') g.pending = { type: 'night', action: 'kill', targets: others };
    else if (g.humanRole === 'seer') {
      const unchecked = others.filter((id) => !g.seerChecks.some((x) => x.seer === HUMAN_ID && x.target === id));
      g.pending = { type: 'night', action: 'check', targets: unchecked.length ? unchecked : others };
    } else g.pending = { type: 'night', action: 'sleep', targets: [] };
  }
}

// ---------- phases ----------

function aiStatements(g) {
  const d = g.day;
  const speakers = g.rng.shuffle(aliveIds(g).filter((id) => id !== HUMAN_ID));
  for (const cid of speakers) {
    const c = charById[cid];
    const me = player(g, cid);
    let st = { speaker: cid, day: d, intent: 'pass', target: null, evidence: [], tellDriven: false };
    const myCheck = g.seerChecks.filter((x) => x.seer === cid && isAlive(g, x.target)).pop();
    if (me.role === 'seer' && myCheck) {
      st = { ...st, intent: 'claim', target: myCheck.target, result: myCheck.result };
    } else if (me.role === 'mafia') {
      const fs = frameScores(g, cid);
      const target = Object.entries(fs).sort((a, b) => b[1] - a[1])[0]?.[0];
      if (target && (fs[target] > 0.2 || g.rng.next() < 0.55)) {
        st = { ...st, intent: 'accuse', target };
        // The mafia rival uses your real record against you when it helps.
        if (target === HUMAN_ID) {
          const term = humanTell(g, cid);
          if (term.total > EVIDENCE_THRESHOLD) {
            st.evidence = evidenceForTerm(g.model, term, `${cid}-d${d}-e`);
            st.tellDriven = true;
          }
        }
      }
    } else {
      const scores = aliveIds(g)
        .filter((t) => t !== cid)
        .map((t) => ({ t, ...suspicion(g, cid, t) }))
        .sort((a, b) => b.total - a.total);
      const top = scores[0];
      const low = scores[scores.length - 1];
      if (top && top.total > c.personality.aggression - 0.25 * (d - 1)) {
        st = { ...st, intent: 'accuse', target: top.t };
        if (top.t === HUMAN_ID && top.tell > EVIDENCE_THRESHOLD) {
          st.evidence = evidenceForTerm(g.model, top.term, `${cid}-d${d}-e`);
          st.tellDriven = true;
        }
      } else if (low && low.total < -0.6) {
        st = { ...st, intent: 'defend', target: low.t };
        if (low.t === HUMAN_ID && low.tell < -EVIDENCE_THRESHOLD) {
          st.evidence = evidenceForTerm(g.model, low.term, `${cid}-d${d}-e`);
          st.tellDriven = true;
        }
      } else {
        // Not confident: still voice a tell-based hunch about the human if there is one.
        const hs = scores.find((x) => x.t === HUMAN_ID);
        if (hs && hs.tell > EVIDENCE_THRESHOLD + 0.2) {
          st = { ...st, intent: 'accuse', target: HUMAN_ID };
          st.evidence = evidenceForTerm(g.model, hs.term, `${cid}-d${d}-e`);
          st.tellDriven = true;
        }
      }
    }
    g.statements[d].push(st);
    emit(g, { t: 'statement', ...st });
  }
}

function startVote(g) {
  g.phase = 'vote';
  g.votes[g.day] = [];
  g.voteOrder[g.day] = g.rng.shuffle(aliveIds(g).filter((id) => id !== HUMAN_ID));
  g.asides[g.day] = new Set();
  emit(g, { t: 'phase', phase: 'vote', day: g.day });
}

function tally(votes) {
  const t = {};
  for (const v of votes) t[v.target] = (t[v.target] || 0) + 1;
  return t;
}

function aiVote(g, cid) {
  const d = g.day;
  const c = charById[cid];
  const me = player(g, cid);
  const counts = tally(g.votes[d]);
  const cands = aliveIds(g).filter((t) => t !== cid);
  let choice;
  let choiceNoTell;
  if (me.role === 'mafia') {
    const fs = frameScores(g, cid);
    const pick = (t) => fs[t] + 0.4 * (counts[t] || 0);
    choice = cands.sort((a, b) => pick(b) - pick(a))[0];
    choiceNoTell = choice;
  } else {
    const T = c.personality.temperature;
    const noise = Object.fromEntries(cands.map((t) => [t, g.rng.gumbel() * T]));
    const herd = HERD[cid] ?? 0;
    let best = null;
    let bestNo = null;
    for (const t of cands) {
      const s = suspicion(g, cid, t);
      const extra = herd * (counts[t] || 0) + noise[t];
      const w = s.total + extra;
      const wo = s.base + extra;
      if (!best || w > best.w) best = { t, w };
      if (!bestNo || wo > bestNo.w) bestNo = { t, w: wo };
    }
    choice = best.t;
    choiceNoTell = bestNo.t;
  }
  g.votes[d].push({ voter: cid, target: choice });
  emit(g, { t: 'vote', voter: cid, target: choice, day: d });
  if (choice !== choiceNoTell && (choice === HUMAN_ID || choiceNoTell === HUMAN_ID)) {
    const humanMafia = g.humanRole === 'mafia';
    let kind;
    if (choice === HUMAN_ID) kind = humanMafia ? 'read' : 'misread';
    else kind = humanMafia ? 'deceived' : 'cleared';
    g.flips.push({ voter: cid, day: d, withTell: choice, withoutTell: choiceNoTell, kind });
  }
}

function recordHumanVoteObs(g, target) {
  const d = g.day;
  const prior = g.votes[d];
  g.obs.push({ f: 'vote_first', v: prior.length === 0, day: d });
  if (prior.length > 0) {
    const counts = tally(prior);
    const max = Math.max(...Object.values(counts));
    const leaders = Object.keys(counts).filter((k) => counts[k] === max && k !== HUMAN_ID);
    if (leaders.length) g.obs.push({ f: 'vote_follow', v: leaders.includes(target), day: d });
  }
  const accusers = accusersOf(g, d, HUMAN_ID).filter((id) => isAlive(g, id));
  if (accusers.length) g.obs.push({ f: 'vote_retaliate', v: accusers.includes(target), day: d });
}

// After the human acts, rivals who watch that habit may react out loud.
function maybeAsides(g) {
  const d = g.day;
  const voted = new Set(g.votes[d].map((v) => v.voter));
  for (const cid of aliveIds(g)) {
    if (cid === HUMAN_ID || voted.has(cid) || g.asides[d].has(cid)) continue;
    if (player(g, cid).role === 'mafia') continue;
    const term = humanTell(g, cid);
    const fresh = term.parts.filter((p) => p.day === d && p.f.startsWith('vote_'));
    if (!fresh.length) continue;
    if (Math.abs(term.total) < EVIDENCE_THRESHOLD + 0.15) continue;
    g.asides[d].add(cid);
    emit(g, {
      t: 'aside',
      speaker: cid,
      day: d,
      kind: term.total > 0 ? 'suspect' : 'clear',
      target: HUMAN_ID,
      evidence: evidenceForTerm(g.model, { ...term, parts: fresh }, `${cid}-d${d}-a`, 1),
    });
  }
}

function finishVote(g) {
  const d = g.day;
  const counts = tally(g.votes[d]);
  const max = Math.max(...Object.values(counts));
  const top = Object.keys(counts).filter((k) => counts[k] === max);
  const target = top.length > 1 ? g.rng.pick(top) : top[0];
  const p = player(g, target);
  p.alive = false;
  g.deaths.push({ id: target, day: d, how: 'vote', role: p.role });
  emit(g, { t: 'execute', target, role: p.role, tie: top.length > 1, counts, day: d });
  if (checkWin(g)) return;
  g.phase = 'night';
  emit(g, { t: 'phase', phase: 'night', day: d });
}

function checkWin(g) {
  const m = player(g, mafiaId(g));
  let winner = null;
  if (!m.alive) winner = 'town';
  else if (alive(g).length <= 2) winner = 'mafia';
  if (!winner) return false;
  g.winner = winner;
  g.phase = 'over';
  const humanWon = roleSide(g.humanRole) === winner;
  emit(g, {
    t: 'over',
    winner,
    humanWon,
    roles: Object.fromEntries(g.players.map((p) => [p.id, p.role])),
  });
  return true;
}

function resolveNight(g, humanTarget) {
  const d = g.day;
  const mid = mafiaId(g);
  let victim = null;
  if (mid === HUMAN_ID) victim = humanTarget;
  else if (isAlive(g, mid)) {
    const fs = frameScores(g, mid);
    // Killing whoever looks most trustworthy (or a seer claimer) hides the mafia best.
    const cands = aliveIds(g).filter((t) => t !== mid);
    const score = (t) => {
      let s = -0.4 * fs[t] + g.rng.gumbel() * 0.6;
      if ((g.statements[d] || []).some((st) => st.speaker === t && st.intent === 'claim')) s += 2;
      if (t === HUMAN_ID) s -= 0.6; // keep the human in the game more often
      return s;
    };
    victim = cands.map((t) => ({ t, s: score(t) })).sort((a, b) => b.s - a.s)[0].t;
  }
  const sid = seerId(g);
  if (sid !== HUMAN_ID && isAlive(g, sid)) {
    const unchecked = aliveIds(g).filter((t) => t !== sid && !g.seerChecks.some((x) => x.seer === sid && x.target === t));
    const pool = unchecked.length ? unchecked : aliveIds(g).filter((t) => t !== sid);
    const target = pool
      .map((t) => ({ t, s: suspicion(g, sid, t).total + g.rng.gumbel() * 0.5 }))
      .sort((a, b) => b.s - a.s)[0].t;
    g.seerChecks.push({ seer: sid, target, result: player(g, target).role === 'mafia' ? 'mafia' : 'town', night: d });
  } else if (sid === HUMAN_ID && humanTarget && g.humanRole === 'seer') {
    const result = player(g, humanTarget).role === 'mafia' ? 'mafia' : 'town';
    g.seerChecks.push({ seer: HUMAN_ID, target: humanTarget, result, night: d });
    emit(g, { t: 'seerResult', target: humanTarget, result, day: d });
  }
  if (victim) {
    const p = player(g, victim);
    p.alive = false;
    g.deaths.push({ id: victim, day: d, how: 'night', role: p.role });
    if (humanAlive(g) && victim !== HUMAN_ID) {
      const accusers = accusersOf(g, d, HUMAN_ID);
      if (accusers.length) g.obs.push({ f: 'victim_accuser', v: accusers.includes(victim), day: d });
    }
    emit(g, { t: 'night', victim, role: p.role, day: d });
  }
  if (checkWin(g)) return;
  g.day += 1;
  g.phase = 'statement';
  g.statements[g.day] = [];
  emit(g, { t: 'phase', phase: 'statement', day: g.day });
}

// ---------- public API ----------

// Applies one human action and returns the new events it produced.
export function act(g, action) {
  const start = g.events.length;
  const d = g.day;
  if (!g.statements[d]) g.statements[d] = [];
  const p = g.pending;
  if (!p) return [];

  if (p.type === 'spectate') {
    autoAdvance(g);
  } else if (p.type === 'statement') {
    const st = { speaker: HUMAN_ID, day: d, intent: action.intent, target: action.target ?? null, evidence: [] };
    if (action.intent === 'claim') {
      const c = p.claims.find((x) => x.target === action.target);
      if (!c) throw new Error('invalid claim');
      st.result = c.result;
    } else if (action.intent !== 'pass' && !p.targets.includes(action.target)) throw new Error('invalid target');
    g.statements[d].push(st);
    emit(g, { t: 'statement', ...st });
    g.obs.push({ f: 'stance_accuse', v: action.intent === 'accuse', day: d });
    g.obs.push({ f: 'stance_pass', v: action.intent === 'pass', day: d });
    aiStatements(g);
    startVote(g);
  } else if (p.type === 'vote') {
    if (action.type === 'wait') {
      const next = g.voteOrder[d].find((id) => !g.votes[d].some((v) => v.voter === id));
      if (next) aiVote(g, next);
    } else {
      if (!p.targets.includes(action.target)) throw new Error('invalid target');
      recordHumanVoteObs(g, action.target);
      g.votes[d].push({ voter: HUMAN_ID, target: action.target });
      emit(g, { t: 'vote', voter: HUMAN_ID, target: action.target, day: d });
      maybeAsides(g);
      for (const id of g.voteOrder[d]) if (!g.votes[d].some((v) => v.voter === id)) aiVote(g, id);
      finishVote(g);
    }
  } else if (p.type === 'night') {
    if (p.action !== 'sleep' && !p.targets.includes(action.target)) throw new Error('invalid target');
    resolveNight(g, action.target ?? null);
  }
  setPending(g);
  return g.events.slice(start);
}

// When the human is dead, the rest of the game runs without input.
function autoAdvance(g) {
  let guard = 0;
  while (g.phase !== 'over' && guard++ < 20) {
    const d = g.day;
    if (!g.statements[d]) g.statements[d] = [];
    if (g.phase === 'statement') {
      aiStatements(g);
      startVote(g);
    } else if (g.phase === 'vote') {
      for (const id of g.voteOrder[d]) if (!g.votes[d].some((v) => v.voter === id)) aiVote(g, id);
      finishVote(g);
    } else if (g.phase === 'night') resolveNight(g, null);
  }
}

// Snapshot used to persist the game in the player's local profile.
export function gameRecord(g) {
  return {
    n: g.n,
    role: g.humanRole,
    side: roleSide(g.humanRole),
    winner: g.winner,
    humanWon: g.winner ? roleSide(g.humanRole) === g.winner : null,
    memory: g.memory,
    obs: g.obs.slice(),
    flips: g.flips.slice(),
    tellCitations: g.events.filter((e) => (e.t === 'statement' || e.t === 'aside') && e.evidence?.length).length,
    days: g.day,
    ts: new Date().toISOString(),
  };
}

export function publicView(g) {
  return {
    n: g.n,
    day: g.day,
    phase: g.phase,
    humanRole: g.humanRole,
    players: g.players.map((p) => ({
      id: p.id,
      alive: p.alive,
      role: p.id === HUMAN_ID || !p.alive || g.phase === 'over' ? p.role : null,
    })),
    votes: g.votes[g.day] ? g.votes[g.day].slice() : [],
    pending: g.pending,
    winner: g.winner,
    seerChecks: g.seerChecks.filter((x) => x.seer === HUMAN_ID),
  };
}
