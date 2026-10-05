// Turn-based game state machine. Pure logic: no DOM, no network, no storage.
// Decisions (statements, votes, kills) are made here in code; dialogue text is
// rendered later from the event specs this module emits.
//
// One engine serves both modes:
//   single: one human ('you'), rivals react right after the human speaks,
//           AI votes are revealed one by one (vote timing is a tell).
//   multi:  1-4 humans, each discussion round is collected and revealed at
//           once, votes are simultaneous.

import { createRng } from './rng.js';
import { CHARACTERS, HUMAN_ID, charById } from './characters.js';
import { buildTellModel, tellTerm, evidenceForTerm, roleSide } from './tells.js';
import { HABITS } from './notebook.js';

// Habits a rival can predict before a game: always observed on day 1.
export const PREDICTABLE_FEATURES = ['stance_accuse', 'stance_pass', 'vote_first'];

export const ROLE_KO = { mafia: '마피아', seer: '예언자', doctor: '의사', villager: '시민' };

const HERD = { leon: 0.2, mio: 0.4, bruno: -0.1, sera: 0.15, kai: 0.5, noa: 0.1 };
const EVIDENCE_THRESHOLD = 0.35; // |tell term| needed before a rival cites memory
export const AI_SKIP_RATE = 0.2;
export const MAX_DAYS = 4; // if the town hasn't caught everyone by then, the mafia wins // multi: humans skip rounds, so rivals sometimes do too

// First single-player games are scheduled so both roles get observed quickly:
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
  const r = rng.next();
  return r < 0.25 ? 'seer' : r < 0.45 ? 'doctor' : 'villager';
}

// 7+ seats: two mafia who know each other; 6+ seats add a doctor.
// Rooms fill to 7 seats (8 with four people); at least 4 rivals so people can hide among them.
export function aiCountFor(humans) {
  return Math.max(4, Math.min(CHARACTERS.length, 7 - humans));
}

export function roleDeck(seatCount) {
  const mafia = seatCount >= 7 ? 2 : 1;
  const doctor = seatCount >= 6 ? 1 : 0;
  return [...Array(mafia).fill('mafia'), 'seer', ...Array(doctor).fill('doctor'), ...Array(seatCount - mafia - 1 - doctor).fill('villager')];
}

// Single-player game (kept as the original entry point).
export function createGame({ n, pastGames = [], memory = true, seed = Date.now(), forceRole = null, rounds = 2, aiSkipRate = 0, aiIds = null, aiHabits = null }) {
  const rng = createRng(seed);
  const humanRole = forceRole ?? roleForGame(n, pastGames, rng);
  const g = createMatch({
    mode: 'single',
    humans: [{ id: HUMAN_ID, n, games: pastGames, role: humanRole }],
    memory,
    seed,
    rng,
    rounds,
    aiSkipRate,
    aiIds,
    aiHabits,
  });
  g.prediction = choosePrediction(g);
  if (g.prediction) emit(g, { t: 'predictionMade', ...g.prediction });
  return g;
}

// Before the game, the rival with the clearest role-dependent read on one of
// its watched day-1 habits states what you'll do, for either role. Breaking it
// blinds that rival's memory for the game; confirming it sharpens it.
function choosePrediction(g) {
  if (!g.memory) return null;
  const h = HUMAN_ID;
  const model = g.models[h];
  let best = null;
  for (const c of CHARACTERS) {
    for (const f of c.watches) {
      if (!PREDICTABLE_FEATURES.includes(f)) continue;
      const m = model[f];
      if (!m?.ready) continue;
      const gap = Math.abs(m.pM - m.pT);
      if (!best || gap > best.gap) best = { rival: c.id, f, gap, expect: { mafia: m.pM >= 0.5, town: m.pT >= 0.5 } };
    }
  }
  if (!best) return null;
  return { rival: best.rival, f: best.f, expect: best.expect, status: 'pending' };
}

function resolvePrediction(g, h, f, v, day) {
  const p = g.prediction;
  if (!p || p.status !== 'pending' || p.f !== f || day !== 1 || h !== HUMAN_ID) return;
  const expected = roleSide(player(g, h).role) === 'mafia' ? p.expect.mafia : p.expect.town;
  p.status = v === expected ? 'hit' : 'broken';
  g.predMult[p.rival] = p.status === 'hit' ? 1.3 : 0;
  emit(g, { t: 'prediction', ...p });
}

// General entry point. humans: [{ id, n, games, role? }] (games = that player's
// own past records, supplied by their device for this game only).
export function createMatch({ mode = 'multi', humans, memory = true, seed = Date.now(), rng = null, rounds = 2, aiSkipRate = AI_SKIP_RATE, aiIds = null, aiHabits = null }) {
  rng = rng ?? createRng(seed);
  const humanIds = humans.map((h) => h.id);
  aiIds = aiIds ?? CHARACTERS.map((c) => c.id);
  const ids = [...humanIds, ...aiIds];
  const deck = roleDeck(ids.length);
  const roles = {};
  for (const h of humans) {
    if (h.role) {
      roles[h.id] = h.role;
      deck.splice(deck.indexOf(h.role), 1);
    }
  }
  const rest = rng.shuffle(deck);
  for (const id of ids) if (!roles[id]) roles[id] = rest.pop();
  const players = ids.map((id) => ({ id, role: roles[id], alive: true, human: humanIds.includes(id) }));
  // A fixed per-game "gut feeling" each rival has about each player.
  const gut = {};
  for (const c of aiIds) {
    gut[c] = {};
    for (const t of ids) if (t !== c) gut[c][t] = rng.normal() * 0.25;
  }
  const models = {};
  const obs = {};
  const gameN = {};
  for (const h of humans) {
    // Games played with memory off never feed tells, keeping the off switch a clean comparison.
    models[h.id] = buildTellModel(memory ? (h.games || []).filter((x) => x.memory !== false) : [], h.n);
    obs[h.id] = [];
    gameN[h.id] = h.n;
  }
  const g = {
    mode,
    sequential: mode === 'single',
    n: humans[0].n,
    gameN,
    seed,
    rng,
    memory,
    rounds,
    aiSkipRate,
    models,
    model: models[humanIds[0]],
    gut,
    players,
    humanIds,
    humanRole: roles[humanIds[0]],
    day: 1,
    round: 1,
    phase: 'statement',
    obs,
    statements: { 1: [] },
    votes: {},
    voteOrder: {},
    seerChecks: [], // {seer, target, result, night}
    deaths: [],
    flips: [],
    asides: {},
    events: [],
    winner: null,
    pending: null,
    aiHabits: aiHabits || {},
    habitFired: new Set(),
    promises: {}, // day -> { rivalId: target } from "누구 찍을 거야?"
    brokenPromises: [], // public facts: { who, promised, voted, day }
    asked: {}, // day -> true once the player used their question
    mafiaPlan: {}, // day -> shared mafia vote target
    predMult: {}, // rivalId -> multiplier on their memory term this game
    prediction: null,
    // multi-mode collection buffers
    roundPlan: null,
    submitted: {},
    nightPicks: {},
  };
  emit(g, { t: 'start', n: g.n, roles: mode === 'single' ? { [HUMAN_ID]: g.humanRole } : null });
  emit(g, { t: 'phase', phase: 'statement', day: 1, round: 1 });
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
const isHuman = (g, id) => g.humanIds.includes(id);
const aliveHumans = (g) => g.humanIds.filter((id) => isAlive(g, id));
const mafiaIds = (g) => g.players.filter((p) => p.role === 'mafia').map((p) => p.id);
const seerId = (g) => g.players.find((p) => p.role === 'seer').id;
export const mafiaTeam = (g, h) => (player(g, h)?.role === 'mafia' ? mafiaIds(g).filter((id) => id !== h) : []);

function accusersOf(g, day, target) {
  return (g.statements[day] || []).filter((s) => s.intent === 'accuse' && s.target === target).map((s) => s.speaker);
}

// Who had accused `h` before a statement at (day, round): earlier rounds today or yesterday.
function accusersBefore(g, h, day, round) {
  const today = (g.statements[day] || []).filter((o) => o.round < round);
  const yesterday = g.statements[day - 1] || [];
  return [...new Set([...yesterday, ...today].filter((o) => o.intent === 'accuse' && o.target === h).map((o) => o.speaker))];
}

function claimsAbout(g, t) {
  const out = [];
  for (const d of Object.keys(g.statements)) for (const s of g.statements[d]) if (s.intent === 'claim' && s.target === t) out.push(s);
  return out;
}

function tellOf(g, cid, h) {
  if (!g.memory || !g.models[h]) return { total: 0, parts: [] };
  const term = tellTerm(g.models[h], charById[cid].watches, g.obs[h]);
  const m = g.predMult[cid] ?? 1;
  return m === 1 ? term : { total: term.total * m, parts: term.parts.map((p) => ({ ...p, llr: p.llr * m })) };
}

// Players who have claimed seer (bare or with a result) and haven't been exposed.
function claimers(g) {
  const out = new Set();
  for (const d of Object.keys(g.statements)) for (const s of g.statements[d]) if (s.intent === 'claim') out.add(s.speaker);
  return [...out];
}

// A claimer is exposed as a liar when the real seer is revealed, or when a
// player they called mafia turns out to be town.
function exposedClaimer(g, c) {
  const realSeerDead = g.deaths.find((x) => x.role === 'seer');
  if (realSeerDead && realSeerDead.id !== c && claimers(g).includes(realSeerDead.id)) return { kind: 'fake_claimer', other: realSeerDead.id };
  for (const cl of claimsBy(g, c)) {
    const dead = g.deaths.find((x) => x.id === cl.target);
    if (dead && cl.result === 'mafia' && dead.role !== 'mafia') return { kind: 'claim_contradicted', other: cl.target };
  }
  const meDead = g.deaths.find((x) => x.id === c);
  if (meDead && meDead.role !== 'seer') return { kind: 'fake_claimer', other: null };
  return null;
}

function claimsBy(g, c) {
  const out = [];
  for (const d of Object.keys(g.statements)) for (const s of g.statements[d]) if (s.intent === 'claim' && s.speaker === c && s.target) out.push(s);
  return out;
}

// Suspicion that rival `cid` holds toward `t`, built from labeled public facts
// (plus the rival's own seer checks) so every accusation can name its reason.
// Returns both components so decisions can be compared with memory removed.
function suspicion(g, cid, t) {
  const c = charById[cid];
  const P = c.personality;
  const reasons = [];
  const add = (kind, w, other = null) => reasons.push({ kind, w, subject: t, other });
  add('gut', g.gut[cid][t] ?? 0);
  for (const d of Object.keys(g.statements)) {
    for (const s of g.statements[d]) {
      if (s.speaker !== t) continue;
      if (s.intent === 'accuse' && s.target === cid) add('accused_me', P.grudge, cid);
      if (s.intent === 'defend' && s.target === cid) add('defended_me', -0.2, cid);
      if (s.intent === 'deny') {
        const answered = accusersBefore(g, t, +d, s.round).length > 0;
        // Answering an accusation calms the trusting rivals a little; denying unprompted looks odd.
        add(answered ? 'deny_answered' : 'deny_unprompted', answered ? -(0.05 + 0.5 * (1 - P.aggression)) : 0.2);
      }
      const dead = g.deaths.find((x) => x.id === s.target);
      if (dead) {
        const wasMafia = dead.role === 'mafia';
        if (s.intent === 'defend' && wasMafia) add('defended_mafia', 1.5, s.target);
        if (s.intent === 'accuse' && dead.how === 'vote') add(wasMafia ? 'accused_mafia_executed' : 'accused_town_executed', wasMafia ? -0.8 : 0.4, s.target);
      }
    }
  }
  for (const d of Object.keys(g.votes)) {
    const executed = g.deaths.find((x) => x.day === +d && x.how === 'vote');
    const mine = g.votes[d].find((v) => v.voter === t);
    if (!mine) continue;
    if (executed && mine.target === executed.id) add(executed.role === 'mafia' ? 'voted_mafia_executed' : 'voted_town_executed', executed.role === 'mafia' ? -0.6 : 0.5, executed.id);
    // Voting the same way as a revealed mafia member, on any day.
    for (const m of g.deaths.filter((x) => x.role === 'mafia' && x.id !== t)) {
      const mv = g.votes[d].find((v) => v.voter === m.id);
      if (mv && mv.target === mine.target && mine.target !== m.id) add('voted_with_mafia', 1.0, m.id);
    }
  }
  // Night victims point back at whoever they had accused.
  for (const v of g.deaths.filter((x) => x.how === 'night')) {
    if ((g.statements[v.day] || []).some((s) => s.speaker === v.id && s.intent === 'accuse' && s.target === t)) add('victim_accused', 1.2, v.id);
  }
  for (const bp of g.brokenPromises) if (bp.who === t) add('broke_promise', 2.5, bp.promised);
  // Seer information: own checks, then claims weighed by how many people claim seer.
  const own = g.seerChecks.find((x) => x.seer === cid && x.target === t);
  if (own) add(own.result === 'mafia' ? 'own_check_mafia' : 'own_check_town', own.result === 'mafia' ? 6 : -6);
  const live = claimers(g).filter((x) => !exposedClaimer(g, x));
  const split = Math.max(1, live.length);
  for (const cl of claimsAbout(g, t)) {
    if (cl.speaker === cid || exposedClaimer(g, cl.speaker)) continue;
    const realSeer = g.deaths.some((x) => x.id === cl.speaker && x.role === 'seer');
    const w = (realSeer ? 1 : P.trustSeer / split) * (cl.result === 'mafia' ? 2.4 : -1.4);
    add(cl.result === 'mafia' ? 'claim_mafia' : 'claim_town', w, cl.speaker);
  }
  const exposed = claimers(g).includes(t) ? exposedClaimer(g, t) : null;
  if (exposed) add(exposed.kind, 3, exposed.other);
  // I'm the real seer, so anyone else claiming is lying; contradicting my check is worse.
  if (player(g, cid).role === 'seer' && claimers(g).includes(t)) {
    let w = 2;
    for (const cl of claimsBy(g, t)) {
      const mine = g.seerChecks.find((x) => x.seer === cid && x.target === cl.target);
      if (mine && mine.result !== cl.result) w += 4;
    }
    add('i_am_seer', w);
  }
  const base = reasons.reduce((a, r) => a + r.w, 0);
  let tell = 0;
  let term = null;
  if (isHuman(g, t)) {
    term = tellOf(g, cid, t);
    tell = term.total;
  }
  return { base, tell, term, total: base + tell, reasons };
}

// The strongest reason behind an accusation (or defense), for the line's "근거".
function topReason(s, sign = 1) {
  const facts = s.reasons.filter((r) => r.kind !== 'gut' && Math.sign(r.w) === sign).sort((a, b) => sign * (b.w - a.w));
  return facts[0] && Math.abs(facts[0].w) >= 0.3 ? facts[0] : { kind: sign > 0 ? 'gut' : 'gut_trust', subject: s.reasons[0]?.subject ?? null };
}

// Hidden mafia rivals push whoever the town already distrusts most, never a teammate.
function frameScores(g, mid) {
  const scores = {};
  const mafia = mafiaIds(g);
  const townAIs = alive(g).filter((p) => !p.human && p.role !== 'mafia');
  for (const t of aliveIds(g)) {
    if (mafia.includes(t)) continue;
    let sum = 0;
    let k = 0;
    for (const a of townAIs) {
      if (a.id === t) continue;
      sum += suspicion(g, a.id, t).total;
      k++;
    }
    let s = k ? sum / k : 0;
    if (claimers(g).includes(t)) s += 1.5;
    scores[t] = s + (g.gut[mid][t] ?? 0);
  }
  return scores;
}

// ---------- pending (single mode) ----------

function setPending(g) {
  if (g.mode !== 'single') {
    g.pending = null;
    return;
  }
  if (g.phase === 'over') {
    g.pending = null;
    return;
  }
  const me = HUMAN_ID;
  if (!isAlive(g, me)) {
    g.pending = { type: 'spectate' };
    return;
  }
  const others = aliveIds(g).filter((id) => id !== me);
  if (g.phase === 'statement') {
    const checks = g.seerChecks.filter((x) => x.seer === me && isAlive(g, x.target));
    g.pending = {
      type: 'statement',
      round: g.round,
      rounds: g.rounds,
      targets: others,
      accusedBy: accusersBefore(g, me, g.day, g.round).filter((id) => isAlive(g, id)),
      claims: g.humanRole === 'seer' ? checks.map((x) => ({ target: x.target, result: x.result })) : [],
      canClaimBare: g.humanRole === 'seer' && !claimers(g).includes(me),
      canAsk: !g.asked[g.day],
      askable: others.filter((id) => !isHuman(g, id)),
    };
  } else if (g.phase === 'vote') {
    const remaining = g.voteOrder[g.day].filter((id) => !g.votes[g.day].some((v) => v.voter === id));
    g.pending = { type: 'vote', targets: others, canWait: remaining.length > 0, votes: g.votes[g.day].slice() };
  } else if (g.phase === 'defense') {
    const checks = g.seerChecks.filter((x) => x.seer === me && isAlive(g, x.target));
    g.pending = { type: 'defense', targets: others, counts: g.trial.counts, claims: g.humanRole === 'seer' ? checks.map((x) => ({ target: x.target, result: x.result })) : [] };
  } else if (g.phase === 'verdict') {
    g.pending = { type: 'verdict', target: g.trial.target, counts: g.trial.counts };
  } else if (g.phase === 'night') {
    g.pending = nightAction(g, me);
  }
}

function nightAction(g, id) {
  const role = player(g, id).role;
  const others = aliveIds(g).filter((x) => x !== id);
  if (role === 'mafia') return { type: 'night', action: 'kill', targets: others.filter((x) => !mafiaIds(g).includes(x)) };
  if (role === 'seer') {
    const unchecked = others.filter((t) => !g.seerChecks.some((x) => x.seer === id && x.target === t));
    return { type: 'night', action: 'check', targets: unchecked.length ? unchecked : others };
  }
  if (role === 'doctor') return { type: 'night', action: 'protect', targets: aliveIds(g) };
  return { type: 'night', action: 'sleep', targets: [] };
}

// ---------- statements ----------

function myStatementsToday(g, cid) {
  return (g.statements[g.day] || []).filter((s) => s.speaker === cid);
}

// Decides what each living rival says this round. Pure decision; recorded by caller.
// Every accusation or defense carries the fact behind it (or an honest "감").
// Day 1 hunches are equally likely from town and mafia, so who speaks first is
// not a giveaway; the deducible traces live in votes, nights and claims.
function decideAIStatements(g) {
  const d = g.day;
  const r = g.round;
  const out = [];
  const speakers = g.rng.shuffle(aliveIds(g).filter((id) => !isHuman(g, id)));
  const otherClaimers = (cid) => claimers(g).filter((x) => x !== cid && isAlive(g, x));
  for (const cid of speakers) {
    const c = charById[cid];
    const me = player(g, cid);
    let st = { speaker: cid, day: d, round: r, intent: 'pass', target: null, evidence: [], tellDriven: false, reason: null };
    const earlier = myStatementsToday(g, cid);
    const claimedBefore = claimers(g).includes(cid);
    const accusedMe = (g.statements[d] || []).filter((s) => s.intent === 'accuse' && s.target === cid && s.round === r - 1).map((s) => s.speaker);
    const myCheck = g.seerChecks.filter((x) => x.seer === cid && isAlive(g, x.target)).pop();
    const hunch = g.rng.next() < (d === 1 ? 0.3 : 0.2);
    if (me.role === 'seer' && !claimedBefore && (myCheck || otherClaimers(cid).length)) {
      // The real seer comes out with a result, or at least contests a rival claim.
      st = myCheck ? { ...st, intent: 'claim', target: myCheck.target, result: myCheck.result } : { ...st, intent: 'claim', target: null, result: null };
    } else if (me.role === 'mafia' && !claimedBefore && !otherClaimers(cid).some((x) => player(g, x).role === 'mafia') && accusedMe.length >= 2 && g.rng.next() < 0.4) {
      // Cornered mafia fakes a seer claim against the town's favorite target.
      const fs = frameScores(g, cid);
      const target = Object.entries(fs).sort((a, b) => b[1] - a[1])[0]?.[0];
      if (target) st = { ...st, intent: 'claim', target, result: 'mafia', fake: true };
    } else if (accusedMe.length && r > 1 && (me.role === 'mafia' || g.rng.next() < 0.5 + c.personality.grudge * 0.5)) {
      // Answer whoever came at me last round: deny, or turn it around.
      const back = accusedMe[0];
      if (isAlive(g, back) && g.rng.next() < 0.5) st = { ...st, intent: 'accuse', target: back, reason: { kind: 'accused_me', subject: back, other: cid } };
      else st = { ...st, intent: 'deny', target: null };
    } else if (r > 1) {
      // Later rounds are for answering; nobody repeats themselves for the sake of it.
      st = { ...st, intent: 'skip' };
    } else if (me.role === 'mafia') {
      const fs = frameScores(g, cid);
      const target = Object.entries(fs).sort((a, b) => b[1] - a[1])[0]?.[0];
      if (target && (fs[target] > c.personality.aggression - 0.25 * (d - 1) || hunch)) {
        st = { ...st, intent: 'accuse', target, reason: topReason(suspicion(g, cid, target)) };
        // The mafia rival uses a human's real record against them when it helps.
        if (isHuman(g, target)) {
          const term = tellOf(g, cid, target);
          if (term.total > EVIDENCE_THRESHOLD) {
            st.evidence = evidenceForTerm(g.models[target], term, `${cid}-d${d}r${r}-e`);
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
      if (top && (top.total > c.personality.aggression - 0.25 * (d - 1) || hunch)) {
        st = { ...st, intent: 'accuse', target: top.t, reason: topReason(top) };
        if (isHuman(g, top.t) && top.tell > EVIDENCE_THRESHOLD) {
          st.evidence = evidenceForTerm(g.models[top.t], top.term, `${cid}-d${d}r${r}-e`);
          st.tellDriven = true;
        }
      } else if (low && low.total < -0.6) {
        st = { ...st, intent: 'defend', target: low.t, reason: topReason(low, -1) };
        if (isHuman(g, low.t) && low.tell < -EVIDENCE_THRESHOLD) {
          st.evidence = evidenceForTerm(g.models[low.t], low.term, `${cid}-d${d}r${r}-e`);
          st.tellDriven = true;
        }
      } else {
        // Not confident: still voice a tell-based hunch about a human if there is one.
        const hs = scores.filter((x) => isHuman(g, x.t)).sort((a, b) => b.tell - a.tell)[0];
        if (hs && hs.tell > EVIDENCE_THRESHOLD + 0.2) {
          st = { ...st, intent: 'accuse', target: hs.t, reason: topReason(hs) };
          st.evidence = evidenceForTerm(g.models[hs.t], hs.term, `${cid}-d${d}r${r}-e`);
          st.tellDriven = true;
        }
      }
    }
    st = applyHabit(g, cid, st);
    if (g.aiSkipRate && st.intent !== 'claim' && !st.evidence.length && g.rng.next() < g.aiSkipRate) {
      st = { ...st, intent: 'skip', target: null };
    }
    out.push(st);
  }
  return out;
}

// A mafia rival's habit (single mode): what the player can learn to spot.
function applyHabit(g, cid, st) {
  const habit = g.aiHabits[cid];
  if (g.mode !== 'single' || !habit || player(g, cid).role !== 'mafia' || st.evidence.length || st.intent === 'claim') return st;
  const H = HABITS[habit];
  if (g.rng.next() >= H.p) return st;
  const r = st.round;
  const human = isAlive(g, HUMAN_ID) && player(g, HUMAN_ID).role !== 'mafia' ? HUMAN_ID : null;
  let next = null;
  if (habit === 'quiet_first' && r === 1) next = { ...st, intent: 'pass', target: null };
  else if (habit === 'defends_partner' && r === 1) {
    const partner = mafiaIds(g).find((id) => id !== cid && isAlive(g, id));
    if (partner) next = { ...st, intent: 'defend', target: partner, reason: topReason(suspicion(g, cid, partner), -1) };
  } else if (habit === 'accuses_you' && r === 1 && human) next = { ...st, intent: 'accuse', target: human, reason: topReason(suspicion(g, cid, human)) };
  else if (habit === 'quick_deny' && accusersBefore(g, cid, st.day, r).length) next = { ...st, intent: 'deny', target: null };
  if (!next) return st;
  g.habitFired.add(cid);
  return next;
}

function recordStatement(g, st) {
  g.statements[st.day].push(st);
  emit(g, { t: 'statement', ...st });
}

function recordHumanStatementObs(g, h, st) {
  if (accusersBefore(g, h, st.day, st.round).length) g.obs[h].push({ f: 'deny_when_accused', v: st.intent === 'deny', day: st.day });
  if (st.round === 1) {
    g.obs[h].push({ f: 'stance_accuse', v: st.intent === 'accuse', day: st.day });
    g.obs[h].push({ f: 'stance_pass', v: st.intent === 'pass' || st.intent === 'skip', day: st.day });
    resolvePrediction(g, h, 'stance_accuse', st.intent === 'accuse', st.day);
    resolvePrediction(g, h, 'stance_pass', st.intent === 'pass' || st.intent === 'skip', st.day);
  }
  if (g.mode !== 'single') g.obs[h].push({ f: 'round_skip', v: st.intent === 'skip', day: st.day });
}

function validateHumanStatement(g, h, action, round = g.round) {
  const intent = action.intent;
  const others = aliveIds(g).filter((id) => id !== h);
  if (!['accuse', 'defend', 'pass', 'claim', 'deny', 'skip'].includes(intent)) throw new Error('invalid intent');
  const st = { speaker: h, day: g.day, round, intent, target: null, evidence: [] };
  if (action.text) st.text = String(action.text).slice(0, 120);
  if (intent === 'accuse' || intent === 'defend' || (intent === 'claim' && action.target)) {
    if (!others.includes(action.target)) throw new Error('invalid target');
    st.target = action.target;
  }
  // A claim may be bare ("I'm the real seer") with no result yet.
  if (intent === 'claim') st.result = st.target ? (action.result === 'mafia' ? 'mafia' : 'town') : null;
  return st;
}

function advanceRound(g) {
  if (g.round < g.rounds) {
    g.round += 1;
    emit(g, { t: 'phase', phase: 'statement', day: g.day, round: g.round });
  } else startVote(g);
}

// ---------- votes ----------

function startVote(g) {
  g.phase = 'vote';
  g.votes[g.day] = [];
  g.voteOrder[g.day] = g.rng.shuffle(aliveIds(g).filter((id) => !isHuman(g, id)));
  g.asides[g.day] = new Set();
  g.submitted = {};
  emit(g, { t: 'phase', phase: 'vote', day: g.day });
}

function tally(votes) {
  const t = {};
  for (const v of votes) t[v.target] = (t[v.target] || 0) + 1;
  return t;
}

function aiVote(g, cid, { herd = true } = {}) {
  const d = g.day;
  const c = charById[cid];
  const me = player(g, cid);
  const counts = herd ? tally(g.votes[d]) : {};
  const cands = aliveIds(g).filter((t) => t !== cid);
  let choice;
  let choiceNoTell;
  const promised = g.promises[d]?.[cid];
  if (me.role === 'mafia') {
    // Mafia votes together on a shared target most of the time, and never on a teammate.
    const fs = frameScores(g, cid);
    const pick = (t) => (fs[t] ?? -99) + 0.4 * (counts[t] || 0);
    const own = cands.slice().sort((a, b) => pick(b) - pick(a))[0];
    if (!g.mafiaPlan[d] || !isAlive(g, g.mafiaPlan[d])) g.mafiaPlan[d] = own;
    choice = g.rng.next() < 0.8 ? g.mafiaPlan[d] : own;
    // Mafia sticks to the team plan even after promising otherwise.
    if (promised && promised === g.mafiaPlan[d]) choice = promised;
    if (g.mode === 'single' && g.aiHabits[cid] === 'votes_you' && isAlive(g, HUMAN_ID) && player(g, HUMAN_ID).role !== 'mafia' && g.rng.next() < HABITS.votes_you.p) {
      choice = HUMAN_ID;
      g.habitFired.add(cid);
    }
    choiceNoTell = choice;
  } else {
    const T = c.personality.temperature * 0.7;
    const noise = Object.fromEntries(cands.map((t) => [t, g.rng.gumbel() * T]));
    const hw = HERD[cid] ?? 0;
    let best = null;
    let bestNo = null;
    for (const t of cands) {
      const s = suspicion(g, cid, t);
      const extra = hw * (counts[t] || 0) + noise[t];
      const w = s.total + extra;
      const wo = s.base + extra;
      if (!best || w > best.w) best = { t, w };
      if (!bestNo || wo > bestNo.w) bestNo = { t, w: wo };
    }
    choice = best.t;
    choiceNoTell = bestNo.t;
    // Town keeps its word: a promised vote stands unless that target is gone.
    if (promised && isAlive(g, promised) && promised !== cid) {
      choice = promised;
      choiceNoTell = promised;
    }
  }
  if (promised && choice !== promised && isAlive(g, promised)) {
    g.brokenPromises.push({ who: cid, promised, voted: choice, day: d });
    emit(g, { t: 'promiseBroken', who: cid, promised, voted: choice, day: d });
  }
  g.votes[d].push({ voter: cid, target: choice });
  emit(g, { t: 'vote', voter: cid, target: choice, day: d });
  if (choice !== choiceNoTell) {
    for (const h of [choice, choiceNoTell].filter((x) => isHuman(g, x))) {
      const humanMafia = player(g, h).role === 'mafia';
      let kind;
      if (choice === h) kind = humanMafia ? 'read' : 'misread';
      else kind = humanMafia ? 'deceived' : 'cleared';
      g.flips.push({ voter: cid, day: d, human: h, withTell: choice, withoutTell: choiceNoTell, kind });
    }
  }
}

function recordHumanVoteObs(g, h, target, prior) {
  const d = g.day;
  if (g.sequential) {
    g.obs[h].push({ f: 'vote_first', v: prior.length === 0, day: d });
    resolvePrediction(g, h, 'vote_first', prior.length === 0, d);
    if (prior.length > 0) {
      const counts = tally(prior);
      const max = Math.max(...Object.values(counts));
      const leaders = Object.keys(counts).filter((k) => counts[k] === max && k !== h);
      if (leaders.length) g.obs[h].push({ f: 'vote_follow', v: leaders.includes(target), day: d });
    }
  }
  const accusers = accusersOf(g, d, h).filter((id) => isAlive(g, id));
  if (accusers.length) g.obs[h].push({ f: 'vote_retaliate', v: accusers.includes(target), day: d });
  const mine = (g.statements[d] || []).filter((s) => s.speaker === h && s.intent === 'accuse' && isAlive(g, s.target)).map((s) => s.target);
  if (mine.length) g.obs[h].push({ f: 'vote_own_accused', v: mine.includes(target), day: d });
}

// After the human acts, rivals who watch that habit may react out loud (single mode).
function maybeAsides(g, h) {
  const d = g.day;
  const voted = new Set(g.votes[d].map((v) => v.voter));
  for (const cid of aliveIds(g)) {
    if (isHuman(g, cid) || voted.has(cid) || g.asides[d].has(cid)) continue;
    if (player(g, cid).role === 'mafia') continue;
    const term = tellOf(g, cid, h);
    const fresh = term.parts.filter((p) => p.day === d && p.f.startsWith('vote_'));
    if (!fresh.length) continue;
    if (Math.abs(term.total) < EVIDENCE_THRESHOLD + 0.15) continue;
    g.asides[d].add(cid);
    emit(g, {
      t: 'aside',
      speaker: cid,
      day: d,
      kind: term.total > 0 ? 'suspect' : 'clear',
      target: h,
      evidence: evidenceForTerm(g.models[h], { ...term, parts: fresh }, `${cid}-d${d}-a`, 1),
    });
  }
}

// The most-voted player doesn't die yet: they get final words, then everyone
// else votes to execute or spare (a strict majority of "yes" executes).
function enterTrial(g) {
  const d = g.day;
  const counts = tally(g.votes[d]);
  const max = Math.max(...Object.values(counts));
  const top = Object.keys(counts).filter((k) => counts[k] === max);
  const target = top.length > 1 ? g.rng.pick(top) : top[0];
  g.trial = { day: d, target, counts, tie: top.length > 1, verdicts: [] };
  g.phase = 'defense';
  g.submitted = {};
  emit(g, { t: 'trial', target, counts, tie: top.length > 1, day: d });
  g.defensePlan = isHuman(g, target) ? null : decideDefense(g, target);
}

function decideDefense(g, cid) {
  const me = player(g, cid);
  let st = { speaker: cid, day: g.day, round: g.rounds + 1, final: true, intent: 'deny', target: null, evidence: [] };
  const myCheck = g.seerChecks.filter((x) => x.seer === cid && isAlive(g, x.target)).pop();
  if (me.role === 'seer' && myCheck) return { ...st, intent: 'claim', target: myCheck.target, result: myCheck.result };
  if (g.rng.next() < 0.5) {
    // Point at someone else on the way out.
    let target;
    if (me.role === 'mafia') target = Object.entries(frameScores(g, cid)).sort((a, b) => b[1] - a[1])[0]?.[0];
    else target = aliveIds(g).filter((t) => t !== cid).map((t) => ({ t, s: suspicion(g, cid, t).total })).sort((a, b) => b.s - a.s)[0]?.t;
    if (target) st = { ...st, intent: 'accuse', target };
  }
  return st;
}

function recordDefense(g, st) {
  recordStatement(g, st);
  const h = st.speaker;
  if (isHuman(g, h) && accusersBefore(g, h, st.day, st.round).length) g.obs[h].push({ f: 'deny_when_accused', v: st.intent === 'deny', day: st.day });
  g.defensePlan = null;
  g.phase = 'verdict';
  g.submitted = {};
  emit(g, { t: 'phase', phase: 'verdict', day: g.day });
}

function aiVerdict(g, cid) {
  const { target, day } = g.trial;
  const me = player(g, cid);
  let yes;
  let yesNoTell;
  if (me.role === 'mafia') {
    yes = player(g, target).role === 'mafia' ? g.rng.next() < 0.25 : true;
    yesNoTell = yes;
  } else {
    const noise = g.rng.gumbel() * charById[cid].personality.temperature * 0.5;
    const scores = aliveIds(g)
      .filter((t) => t !== cid)
      .map((t) => ({ t, ...suspicion(g, cid, t) }));
    const accused = scores.find((x) => x.t === target);
    const others = scores.filter((x) => x.t !== target);
    const bestOther = Math.max(-9, ...others.map((x) => x.total));
    const bestOtherNo = Math.max(-9, ...others.map((x) => x.base));
    yes = accused.total + noise > bestOther - 0.5;
    yesNoTell = accused.base + noise > bestOtherNo - 0.5;
  }
  g.trial.verdicts.push({ voter: cid, yes });
  emit(g, { t: 'verdict', voter: cid, yes, day });
  if (yes !== yesNoTell && isHuman(g, target)) {
    const humanMafia = player(g, target).role === 'mafia';
    const kind = yes ? (humanMafia ? 'read' : 'misread') : humanMafia ? 'deceived' : 'cleared';
    g.flips.push({ voter: cid, day, human: target, verdict: true, withTell: yes, withoutTell: yesNoTell, kind });
  }
}

function resolveVerdict(g) {
  const { target, day, verdicts, counts, tie } = g.trial;
  const yes = verdicts.filter((v) => v.yes).length;
  const no = verdicts.length - yes;
  if (yes > no) {
    const p = player(g, target);
    p.alive = false;
    g.deaths.push({ id: target, day, how: 'vote', role: p.role });
    emit(g, { t: 'execute', target, role: p.role, tie, counts, yes, no, day });
    if (checkWin(g)) return;
  } else {
    emit(g, { t: 'spared', target, yes, no, day });
  }
  g.phase = 'night';
  g.nightPicks = {};
  emit(g, { t: 'phase', phase: 'night', day });
}

// Rivals (and, in single mode, nobody else) deliver verdicts, then resolve.
function finishVerdictsWithAI(g) {
  for (const id of aliveIds(g)) if (!isHuman(g, id) && id !== g.trial.target) aiVerdict(g, id);
  resolveVerdict(g);
}

function endByTime(g) {
  g.winner = 'mafia';
  g.phase = 'over';
  emit(g, { t: 'over', winner: 'mafia', timeout: true, humanWon: roleSide(g.humanRole) === 'mafia', roles: Object.fromEntries(g.players.map((p) => [p.id, p.role])) });
}

function checkWin(g) {
  const living = alive(g);
  const m = living.filter((p) => p.role === 'mafia').length;
  let winner = null;
  if (m === 0) winner = 'town';
  else if (m > living.length - m || (m === living.length - m && living.length <= 2)) winner = 'mafia';
  if (!winner) return false;
  g.winner = winner;
  g.phase = 'over';
  emit(g, {
    t: 'over',
    winner,
    humanWon: roleSide(g.humanRole) === winner,
    roles: Object.fromEntries(g.players.map((p) => [p.id, p.role])),
  });
  return true;
}

// ---------- night ----------

// picks: { [humanId]: target } from humans who act at night.
function resolveNight(g, picks) {
  const d = g.day;
  const mafia = mafiaIds(g).filter((id) => isAlive(g, id));
  let victim = null;
  const humanKills = mafia.filter((id) => isHuman(g, id) && picks[id] && isAlive(g, picks[id])).map((id) => picks[id]);
  if (humanKills.length) victim = g.rng.pick(humanKills);
  else {
    const aiMafia = mafia.find((id) => !isHuman(g, id));
    if (aiMafia) {
      const fs = frameScores(g, aiMafia);
      const cands = aliveIds(g).filter((t) => !mafia.includes(t));
      // Killing whoever looks most trustworthy (or a seer claimer) hides the mafia best.
      // Mafia hits back at whoever accused them today (a trace the town can read),
      // and goes after a seer claimer who isn't one of their own.
      const accusedMafia = (t) => (g.statements[d] || []).filter((st) => st.speaker === t && st.intent === 'accuse' && mafia.includes(st.target)).length;
      const retaliate = g.rng.next() < 0.6;
      const score = (t) => {
        let s = -0.4 * (fs[t] ?? 0) + g.rng.gumbel() * 0.6;
        if (claimers(g).includes(t)) s += 2;
        if (retaliate) s += 1.5 * accusedMafia(t);
        if (isHuman(g, t) && g.mode === 'single') s -= 0.6; // keep the solo player in the game more often
        return s;
      };
      victim = cands.map((t) => ({ t, s: score(t) })).sort((a, b) => b.s - a.s)[0]?.t ?? null;
    }
  }
  // The doctor's patient survives the night.
  const doc = g.players.find((p) => p.role === 'doctor' && p.alive);
  let protectedId = null;
  if (doc) {
    if (isHuman(g, doc.id)) protectedId = picks[doc.id] ?? null;
    else {
      const claimer = (g.statements[d] || []).find((st) => st.intent === 'claim' && isAlive(g, st.speaker) && st.speaker !== doc.id)?.speaker;
      if (claimer && g.rng.next() < 0.7) protectedId = claimer;
      else if (g.rng.next() < 0.3) protectedId = doc.id;
      else {
        const trust = aliveIds(g).filter((t) => t !== doc.id).map((t) => ({ t, s: suspicion(g, doc.id, t).total + g.rng.gumbel() * 0.4 })).sort((a, b) => a.s - b.s)[0];
        protectedId = trust?.t ?? doc.id;
      }
    }
  }
  const saved = victim && victim === protectedId;
  if (saved) victim = null;
  const sid = seerId(g);
  if (isAlive(g, sid)) {
    if (!isHuman(g, sid)) {
      const unchecked = aliveIds(g).filter((t) => t !== sid && !g.seerChecks.some((x) => x.seer === sid && x.target === t));
      const pool = unchecked.length ? unchecked : aliveIds(g).filter((t) => t !== sid);
      const target = pool.map((t) => ({ t, s: suspicion(g, sid, t).total + g.rng.gumbel() * 0.5 })).sort((a, b) => b.s - a.s)[0].t;
      g.seerChecks.push({ seer: sid, target, result: player(g, target).role === 'mafia' ? 'mafia' : 'town', night: d });
    } else if (picks[sid] && isAlive(g, picks[sid])) {
      const target = picks[sid];
      const result = player(g, target).role === 'mafia' ? 'mafia' : 'town';
      g.seerChecks.push({ seer: sid, target, result, night: d });
      emit(g, { t: 'seerResult', seer: sid, target, result, day: d, private: sid });
    }
  }
  if (victim) {
    const p = player(g, victim);
    p.alive = false;
    g.deaths.push({ id: victim, day: d, how: 'night', role: p.role });
    for (const h of aliveHumans(g)) {
      const accusers = accusersOf(g, d, h);
      if (accusers.length) g.obs[h].push({ f: 'victim_accuser', v: accusers.includes(victim), day: d });
    }
    emit(g, { t: 'night', victim, role: p.role, day: d });
  } else emit(g, { t: 'night', victim: null, saved, day: d });
  if (checkWin(g)) return;
  if (d >= MAX_DAYS) return endByTime(g);
  g.day += 1;
  g.round = 1;
  g.phase = 'statement';
  g.statements[g.day] = [];
  g.submitted = {};
  emit(g, { t: 'phase', phase: 'statement', day: g.day, round: 1 });
}

// ---------- single-mode API ----------

// Applies one human action and returns the new events it produced.
export function act(g, action) {
  const start = g.events.length;
  const p = g.pending;
  if (!p) return [];
  const me = HUMAN_ID;

  if (p.type === 'statement' && action.type === 'ask') {
    if (!p.canAsk || !p.askable.includes(action.target)) throw new Error('cannot ask');
    g.asked[g.day] = true;
    answerQuestion(g, action.target, action.q);
    setPending(g);
    return g.events.slice(start);
  }
  if (p.type === 'spectate') {
    autoAdvance(g);
  } else if (p.type === 'statement') {
    if (action.intent === 'claim' && action.result === undefined) {
      const c = p.claims.find((x) => x.target === action.target);
      if (c) action = { ...action, result: c.result };
    }
    const st = validateHumanStatement(g, me, action);
    recordStatement(g, st);
    recordHumanStatementObs(g, me, st);
    for (const ai of decideAIStatements(g)) recordStatement(g, ai);
    advanceRound(g);
  } else if (p.type === 'vote') {
    const d = g.day;
    if (action.type === 'wait') {
      const next = g.voteOrder[d].find((id) => !g.votes[d].some((v) => v.voter === id));
      if (next) aiVote(g, next);
    } else {
      if (!p.targets.includes(action.target)) throw new Error('invalid target');
      recordHumanVoteObs(g, me, action.target, g.votes[d].slice());
      g.votes[d].push({ voter: me, target: action.target });
      emit(g, { t: 'vote', voter: me, target: action.target, day: d });
      maybeAsides(g, me);
      for (const id of g.voteOrder[d]) if (!g.votes[d].some((v) => v.voter === id)) aiVote(g, id);
      enterTrial(g);
      singleTrialStep(g);
    }
  } else if (p.type === 'defense') {
    const intent = action.intent === 'skip' ? 'pass' : action.intent;
    if (!['deny', 'accuse', 'claim', 'pass'].includes(intent)) throw new Error('invalid intent');
    if (intent === 'claim' && action.result === undefined) {
      const c = p.claims.find((x) => x.target === action.target);
      if (c) action = { ...action, result: c.result };
    }
    const st = { ...validateHumanStatement(g, me, { ...action, intent }, g.rounds + 1), final: true };
    recordDefense(g, st);
    finishVerdictsWithAI(g);
  } else if (p.type === 'verdict') {
    g.trial.verdicts.push({ voter: me, yes: !!action.yes });
    emit(g, { t: 'verdict', voter: me, yes: !!action.yes, day: g.day });
    finishVerdictsWithAI(g);
  } else if (p.type === 'night') {
    if (p.action !== 'sleep' && !p.targets.includes(action.target)) throw new Error('invalid target');
    resolveNight(g, action.target ? { [me]: action.target } : {});
  }
  setPending(g);
  return g.events.slice(start);
}

// Single mode: a rival on trial speaks right away; then the player judges
// (or, if the player is dead, rivals judge alone).
function singleTrialStep(g) {
  if (g.phase !== 'defense' || g.trial.target === HUMAN_ID) return;
  recordDefense(g, g.defensePlan);
  if (!isAlive(g, HUMAN_ID)) finishVerdictsWithAI(g);
}

// "추궁하기": the rival answers by its role. Town answers honestly and keeps its
// vote promise; mafia lies within rules (breaks promises, may fake a seer claim).
function answerQuestion(g, cid, q) {
  const d = g.day;
  const me = player(g, cid);
  const ans = { t: 'answer', speaker: cid, q, day: d, asker: HUMAN_ID };
  if (q === 'vote') {
    let target;
    if (me.role === 'mafia') {
      const fs = frameScores(g, cid);
      const ranked = Object.entries(fs).sort((a, b) => b[1] - a[1]).map(([t]) => t);
      g.mafiaPlan[d] = g.mafiaPlan[d] && isAlive(g, g.mafiaPlan[d]) ? g.mafiaPlan[d] : ranked[0];
      // Half the time the mafia names someone else and still votes the plan: a lie the town can catch.
      const decoy = ranked.find((t) => t !== g.mafiaPlan[d] && t !== HUMAN_ID) ?? ranked.find((t) => t !== g.mafiaPlan[d]);
      target = decoy && g.rng.next() < 0.5 ? decoy : g.mafiaPlan[d];
    } else {
      target = aliveIds(g)
        .filter((t) => t !== cid)
        .map((t) => ({ t, s: suspicion(g, cid, t).total }))
        .sort((a, b) => b.s - a.s)[0]?.t;
    }
    if (target) (g.promises[d] ||= {})[cid] = target;
    emit(g, { ...ans, kind: target ? 'vote' : 'vote_none', target });
  } else if (q === 'role') {
    const myCheck = g.seerChecks.filter((x) => x.seer === cid).pop();
    const claim = (target, result, fake = false) => {
      const st = { speaker: cid, day: d, round: g.round, intent: 'claim', target, result, evidence: [], asked: true, fake };
      g.statements[d].push(st);
      emit(g, { ...ans, kind: target ? 'role_seer' : 'role_seer_bare', target, result });
    };
    if (me.role === 'seer') {
      if (myCheck) claim(myCheck.target, myCheck.result);
      else if (claimers(g).length) claim(null, null);
      else emit(g, { ...ans, kind: 'role_hide' });
    } else if (me.role === 'mafia') {
      const pressured = accusersBefore(g, cid, d, g.round + 1).length > 0;
      const teammateClaimed = claimers(g).some((x) => player(g, x).role === 'mafia');
      if (!teammateClaimed && (pressured || g.rng.next() < 0.2) && g.rng.next() < 0.6) {
        const fs = frameScores(g, cid);
        claim(Object.entries(fs).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null, 'mafia', true);
      } else emit(g, { ...ans, kind: 'role_villager' });
    } else if (me.role === 'doctor') emit(g, { ...ans, kind: g.rng.next() < 0.5 ? 'role_doctor' : 'role_hide' });
    else emit(g, { ...ans, kind: 'role_villager' });
  } else if (q === 'why') {
    const last = (g.statements[d] || []).filter((s) => s.speaker === cid && s.intent === 'accuse').pop();
    emit(g, { ...ans, kind: last ? 'why' : 'why_none', target: last?.target ?? null, reason: last?.reason ?? null });
  }
}

// When every human is dead, the rest of the game runs without input.
function autoAdvance(g) {
  let guard = 0;
  while (g.phase !== 'over' && guard++ < 40) {
    if (g.phase === 'statement') {
      for (const ai of decideAIStatements(g)) recordStatement(g, ai);
      advanceRound(g);
    } else if (g.phase === 'vote') {
      for (const id of g.voteOrder[g.day]) if (!g.votes[g.day].some((v) => v.voter === id)) aiVote(g, id);
      enterTrial(g);
    } else if (g.phase === 'defense') recordDefense(g, g.defensePlan);
    else if (g.phase === 'verdict') finishVerdictsWithAI(g);
    else if (g.phase === 'night') resolveNight(g, {});
  }
}

// ---------- multi-mode API (collect, then reveal at once) ----------

// Who must still act in the current phase.
export function waitingOn(g) {
  if (g.phase === 'over') return [];
  const hs = aliveHumans(g);
  if (g.phase === 'night') return hs.filter((h) => nightAction(g, h).action !== 'sleep' && !(h in g.nightPicks));
  if (g.phase === 'defense') return hs.filter((h) => h === g.trial.target && !(h in g.submitted));
  if (g.phase === 'verdict') return hs.filter((h) => h !== g.trial.target && !(h in g.submitted));
  return hs.filter((h) => !(h in g.submitted));
}

export function humanOptions(g, h) {
  if (!isAlive(g, h) || g.phase === 'over') return { type: 'spectate' };
  const others = aliveIds(g).filter((x) => x !== h);
  if (g.phase === 'statement') return { type: 'statement', day: g.day, round: g.round, rounds: g.rounds, targets: others };
  if (g.phase === 'vote') return { type: 'vote', targets: others };
  if (g.phase === 'defense') return h === g.trial.target ? { type: 'defense', targets: others } : { type: 'wait', target: g.trial.target };
  if (g.phase === 'verdict') return h === g.trial.target ? { type: 'wait', target: h } : { type: 'verdict', target: g.trial.target };
  return nightAction(g, h);
}

// Opens a discussion round: rivals decide now, before seeing this round's human messages.
export function openRound(g) {
  if (g.phase !== 'statement') throw new Error('not in statement phase');
  g.submitted = {};
  g.roundPlan = decideAIStatements(g);
  return g.roundPlan;
}

export function submit(g, h, action) {
  if (!isHuman(g, h) || !isAlive(g, h)) throw new Error('not an active player');
  if (g.phase === 'statement') g.submitted[h] = validateHumanStatement(g, h, action);
  else if (g.phase === 'defense') {
    if (h !== g.trial.target) throw new Error('not on trial');
    const intent = !action.intent || action.intent === 'skip' ? 'pass' : action.intent;
    if (!['deny', 'accuse', 'claim', 'pass'].includes(intent)) throw new Error('invalid intent');
    g.submitted[h] = { ...validateHumanStatement(g, h, { ...action, intent }, g.rounds + 1), final: true };
  } else if (g.phase === 'verdict') {
    if (h === g.trial.target) throw new Error('on trial');
    g.submitted[h] = !!action.yes;
  } else if (g.phase === 'vote') {
    if (!aliveIds(g).includes(action.target) || action.target === h) throw new Error('invalid target');
    g.submitted[h] = action.target;
  } else if (g.phase === 'night') {
    const na = nightAction(g, h);
    if (na.action === 'sleep') return;
    if (!na.targets.includes(action.target)) throw new Error('invalid target');
    g.nightPicks[h] = action.target;
  }
}

// Closes whatever phase is collecting; missing humans skip (or are skipped).
export function close(g) {
  const start = g.events.length;
  if (g.phase === 'statement') {
    const plan = g.roundPlan ?? decideAIStatements(g);
    const human = aliveHumans(g).map((h) => g.submitted[h] ?? { speaker: h, day: g.day, round: g.round, intent: 'skip', target: null, evidence: [] });
    // Reveal order is shuffled so position doesn't separate humans from rivals.
    for (const st of g.rng.shuffle([...human, ...plan])) recordStatement(g, st);
    for (const st of human) recordHumanStatementObs(g, st.speaker, st);
    g.roundPlan = null;
    g.submitted = {};
    advanceRound(g);
  } else if (g.phase === 'vote') {
    const d = g.day;
    // Rivals vote without seeing this round's human votes.
    for (const id of g.voteOrder[d]) if (isAlive(g, id)) aiVote(g, id, { herd: false });
    for (const h of aliveHumans(g)) {
      const others = aliveIds(g).filter((x) => x !== h);
      const target = g.submitted[h] ?? g.rng.pick(others);
      recordHumanVoteObs(g, h, target, []);
      g.votes[d].push({ voter: h, target, auto: !(h in g.submitted) });
      emit(g, { t: 'vote', voter: h, target, day: d });
    }
    enterTrial(g);
  } else if (g.phase === 'defense') {
    const t = g.trial.target;
    const st = isHuman(g, t) ? g.submitted[t] ?? { speaker: t, day: g.day, round: g.rounds + 1, final: true, intent: 'pass', target: null, evidence: [] } : g.defensePlan;
    recordDefense(g, st);
  } else if (g.phase === 'verdict') {
    // Humans who didn't answer abstain.
    for (const h of aliveHumans(g)) {
      if (h === g.trial.target || !(h in g.submitted)) continue;
      g.trial.verdicts.push({ voter: h, yes: g.submitted[h] });
      emit(g, { t: 'verdict', voter: h, yes: g.submitted[h], day: g.day });
    }
    finishVerdictsWithAI(g);
  } else if (g.phase === 'night') {
    resolveNight(g, g.nightPicks);
  }
  return g.events.slice(start);
}

// Stores the rendered text on the statement so later prompts can see today's chat.
export function setLineText(g, st, text) {
  const rec = (g.statements[st.day] || []).find((s) => s.speaker === st.speaker && s.round === st.round);
  if (rec) rec.text = String(text).slice(0, 120);
}

// ---------- records & views ----------

// What the player saw each rival do, per day (only literal engine decisions).
function aiObservations(g, h) {
  const out = {};
  for (const p of g.players) {
    if (p.human) continue;
    const obs = [];
    for (const d of Object.keys(g.statements).map(Number)) {
      const mine = g.statements[d].filter((s) => s.speaker === p.id && !s.final);
      if (!mine.length) continue;
      const r1 = mine.find((s) => s.round === 1);
      if (r1) obs.push({ f: 'ai_pass_r1', v: r1.intent === 'pass' || r1.intent === 'skip', day: d });
      obs.push({ f: 'ai_defend', v: mine.some((s) => s.intent === 'defend'), day: d });
      obs.push({ f: 'ai_accuse_you', v: mine.some((s) => s.intent === 'accuse' && s.target === h), day: d });
      const later = mine.find((s) => s.round > 1);
      if (later && accusersBefore(g, p.id, d, later.round).length) obs.push({ f: 'ai_deny', v: later.intent === 'deny', day: d });
    }
    for (const [d, vs] of Object.entries(g.votes)) {
      const v = vs.find((x) => x.voter === p.id);
      if (v) obs.push({ f: 'ai_vote_you', v: v.target === h, day: +d });
    }
    out[p.id] = { role: p.role, obs };
  }
  return out;
}

// What one human's device stores after the game.
export function gameRecord(g, h = g.humanIds[0]) {
  const role = player(g, h).role;
  return {
    n: g.gameN[h],
    mode: g.mode,
    role,
    side: roleSide(role),
    winner: g.winner,
    humanWon: g.winner ? roleSide(role) === g.winner : null,
    memory: g.memory,
    obs: g.obs[h].slice(),
    flips: g.flips.filter((f) => f.human === h),
    tellCitations: g.events.filter((e) => (e.t === 'statement' || e.t === 'aside') && e.evidence?.length && e.target === h).length,
    prediction: h === HUMAN_ID && g.prediction ? { ...g.prediction } : null,
    myVotes: [
      ...Object.entries(g.votes).flatMap(([d, vs]) => vs.filter((v) => v.voter === h).map((v) => ({ day: +d, target: v.target }))),
      ...g.events.filter((e) => e.t === 'verdict' && e.voter === h && e.yes).map((e) => ({ day: e.day, target: g.events.find((x) => x.t === 'trial' && x.day === e.day)?.target, verdict: true })),
    ],
    ...(g.mode === 'single' ? { aiObs: aiObservations(g, h), habitsShown: [...g.habitFired].filter((id) => player(g, id).role === 'mafia') } : {}),
    days: g.day,
    ts: new Date().toISOString(),
  };
}

export function publicView(g, h = HUMAN_ID) {
  return {
    n: g.n,
    day: g.day,
    round: g.round,
    rounds: g.rounds,
    phase: g.phase,
    humanRole: player(g, h)?.role,
    players: g.players.map((p) => ({
      id: p.id,
      alive: p.alive,
      role: p.id === h || !p.alive || g.phase === 'over' || (p.role === 'mafia' && player(g, h)?.role === 'mafia') ? p.role : null,
    })),
    votes: g.votes[g.day] ? g.votes[g.day].slice() : [],
    pending: g.pending,
    winner: g.winner,
    seerChecks: g.seerChecks.filter((x) => x.seer === h),
    trial: g.trial && (g.phase === 'defense' || g.phase === 'verdict') ? { target: g.trial.target, counts: g.trial.counts } : null,
  };
}
