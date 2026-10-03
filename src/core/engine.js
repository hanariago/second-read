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

export const ROLE_KO = { mafia: '마피아', seer: '예언자', villager: '시민' };

const HERD = { leon: 0.2, mio: 0.4, bruno: -0.1, sera: 0.15 };
const EVIDENCE_THRESHOLD = 0.35; // |tell term| needed before a rival cites memory
export const AI_SKIP_RATE = 0.2; // multi: humans skip rounds, so rivals sometimes do too

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
  return rng.next() < 0.3 ? 'seer' : 'villager';
}

export function roleDeck(seatCount) {
  const mafia = seatCount >= 8 ? 2 : 1;
  return [...Array(mafia).fill('mafia'), 'seer', ...Array(seatCount - mafia - 1).fill('villager')];
}

// Single-player game (kept as the original entry point).
export function createGame({ n, pastGames = [], memory = true, seed = Date.now(), forceRole = null, rounds = 2, aiSkipRate = 0 }) {
  const rng = createRng(seed);
  const humanRole = forceRole ?? roleForGame(n, pastGames, rng);
  return createMatch({
    mode: 'single',
    humans: [{ id: HUMAN_ID, n, games: pastGames, role: humanRole }],
    memory,
    seed,
    rng,
    rounds,
    aiSkipRate,
  });
}

// General entry point. humans: [{ id, n, games, role? }] (games = that player's
// own past records, supplied by their device for this game only).
export function createMatch({ mode = 'multi', humans, memory = true, seed = Date.now(), rng = null, rounds = 2, aiSkipRate = AI_SKIP_RATE }) {
  rng = rng ?? createRng(seed);
  const humanIds = humans.map((h) => h.id);
  const aiIds = CHARACTERS.map((c) => c.id);
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
    for (const t of ids) if (t !== c) gut[c][t] = rng.normal() * 0.35;
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
  return tellTerm(g.models[h], charById[cid].watches, g.obs[h]);
}

// Suspicion that rival `cid` (playing town) holds toward `t`.
// Returns both components so decisions can be compared with memory removed.
function suspicion(g, cid, t) {
  const c = charById[cid];
  const P = c.personality;
  let base = g.gut[cid][t] ?? 0;
  for (const d of Object.keys(g.statements)) {
    for (const s of g.statements[d]) {
      if (s.speaker !== t) continue;
      if (s.intent === 'accuse' && s.target === cid) base += P.grudge;
      if (s.intent === 'defend' && s.target === cid) base -= 0.2;
      if (s.intent === 'deny') {
        const accusedBefore = accusersBefore(g, t, +d, s.round).length > 0;
        // Answering an accusation calms the trusting rivals a little; denying unprompted looks odd.
        base += accusedBefore ? -(0.05 + 0.5 * (1 - P.aggression)) : 0.2;
      }
      // Defending someone later revealed as mafia is damning; accusing a revealed townie is suspicious.
      const dead = g.deaths.find((x) => x.id === s.target);
      if (dead) {
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
    for (const v of g.votes[d]) if (v.voter === t && v.target === executed.id) base += executed.role === 'mafia' ? -0.6 : 0.5;
  }
  // Seer information, own and claimed.
  const own = g.seerChecks.find((x) => x.seer === cid && x.target === t);
  if (own) base += own.result === 'mafia' ? 6 : -6;
  for (const cl of claimsAbout(g, t)) {
    if (cl.speaker === cid) continue;
    base += P.trustSeer * (cl.result === 'mafia' ? 2.4 : -1.4);
  }
  // I'm the real seer, so anyone else claiming is lying; contradicting my check is worse.
  if (player(g, cid).role === 'seer') {
    for (const d of Object.keys(g.statements)) {
      for (const s of g.statements[d]) {
        if (s.intent !== 'claim' || s.speaker !== t) continue;
        const mine = g.seerChecks.find((x) => x.seer === cid && x.target === s.target);
        if (mine && mine.result !== s.result) base += 4;
        base += 2;
      }
    }
  }
  let tell = 0;
  let term = null;
  if (isHuman(g, t)) {
    term = tellOf(g, cid, t);
    tell = term.total;
  }
  return { base, tell, term, total: base + tell };
}

// A hidden mafia rival pushes whoever the town already distrusts most.
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
    if ((g.statements[g.day] || []).concat(g.statements[g.day - 1] || []).some((st) => st.speaker === t && st.intent === 'claim')) s += 1.5;
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
    };
  } else if (g.phase === 'vote') {
    const remaining = g.voteOrder[g.day].filter((id) => !g.votes[g.day].some((v) => v.voter === id));
    g.pending = { type: 'vote', targets: others, canWait: remaining.length > 0, votes: g.votes[g.day].slice() };
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
  return { type: 'night', action: 'sleep', targets: [] };
}

// ---------- statements ----------

function myStatementsToday(g, cid) {
  return (g.statements[g.day] || []).filter((s) => s.speaker === cid);
}

// Decides what each living rival says this round. Pure decision; recorded by caller.
function decideAIStatements(g) {
  const d = g.day;
  const r = g.round;
  const out = [];
  const speakers = g.rng.shuffle(aliveIds(g).filter((id) => !isHuman(g, id)));
  for (const cid of speakers) {
    const c = charById[cid];
    const me = player(g, cid);
    let st = { speaker: cid, day: d, round: r, intent: 'pass', target: null, evidence: [], tellDriven: false };
    const earlier = myStatementsToday(g, cid);
    const accusedMe = (g.statements[d] || []).filter((s) => s.intent === 'accuse' && s.target === cid && s.round === r - 1).map((s) => s.speaker);
    const myCheck = g.seerChecks.filter((x) => x.seer === cid && isAlive(g, x.target)).pop();
    if (me.role === 'seer' && myCheck && !earlier.some((s) => s.intent === 'claim')) {
      st = { ...st, intent: 'claim', target: myCheck.target, result: myCheck.result };
    } else if (accusedMe.length && r > 1 && (me.role === 'mafia' || g.rng.next() < 0.5 + c.personality.grudge * 0.5)) {
      // Answer whoever came at me last round: deny, or turn it around.
      const back = accusedMe[0];
      if (isAlive(g, back) && g.rng.next() < 0.5) st = { ...st, intent: 'accuse', target: back };
      else st = { ...st, intent: 'deny', target: null };
    } else if (me.role === 'mafia') {
      const fs = frameScores(g, cid);
      const target = Object.entries(fs).sort((a, b) => b[1] - a[1])[0]?.[0];
      if (target && (fs[target] > 0.2 || g.rng.next() < 0.55)) {
        st = { ...st, intent: 'accuse', target };
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
      if (top && top.total > c.personality.aggression - 0.25 * (d - 1)) {
        st = { ...st, intent: 'accuse', target: top.t };
        if (isHuman(g, top.t) && top.tell > EVIDENCE_THRESHOLD) {
          st.evidence = evidenceForTerm(g.models[top.t], top.term, `${cid}-d${d}r${r}-e`);
          st.tellDriven = true;
        }
      } else if (low && low.total < -0.6) {
        st = { ...st, intent: 'defend', target: low.t };
        if (isHuman(g, low.t) && low.tell < -EVIDENCE_THRESHOLD) {
          st.evidence = evidenceForTerm(g.models[low.t], low.term, `${cid}-d${d}r${r}-e`);
          st.tellDriven = true;
        }
      } else {
        // Not confident: still voice a tell-based hunch about a human if there is one.
        const hs = scores.filter((x) => isHuman(g, x.t)).sort((a, b) => b.tell - a.tell)[0];
        if (hs && hs.tell > EVIDENCE_THRESHOLD + 0.2) {
          st = { ...st, intent: 'accuse', target: hs.t };
          st.evidence = evidenceForTerm(g.models[hs.t], hs.term, `${cid}-d${d}r${r}-e`);
          st.tellDriven = true;
        }
      }
    }
    // Don't repeat yourself in a later round.
    if (r > 1 && !st.evidence.length && earlier.some((s) => s.intent === st.intent && s.target === st.target) && g.rng.next() < 0.6) {
      st = { ...st, intent: 'pass', target: null };
    }
    if (g.aiSkipRate && st.intent !== 'claim' && !st.evidence.length && g.rng.next() < g.aiSkipRate) {
      st = { ...st, intent: 'skip', target: null };
    }
    out.push(st);
  }
  return out;
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
  }
  if (g.mode !== 'single') g.obs[h].push({ f: 'round_skip', v: st.intent === 'skip', day: st.day });
}

function validateHumanStatement(g, h, action) {
  const intent = action.intent;
  const others = aliveIds(g).filter((id) => id !== h);
  if (!['accuse', 'defend', 'pass', 'claim', 'deny', 'skip'].includes(intent)) throw new Error('invalid intent');
  const st = { speaker: h, day: g.day, round: g.round, intent, target: null, evidence: [] };
  if (action.text) st.text = String(action.text).slice(0, 120);
  if (intent === 'accuse' || intent === 'defend' || intent === 'claim') {
    if (!others.includes(action.target)) throw new Error('invalid target');
    st.target = action.target;
  }
  if (intent === 'claim') st.result = action.result === 'mafia' ? 'mafia' : 'town';
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
  if (me.role === 'mafia') {
    const fs = frameScores(g, cid);
    const pick = (t) => (fs[t] ?? -99) + 0.4 * (counts[t] || 0);
    choice = cands.slice().sort((a, b) => pick(b) - pick(a))[0];
    choiceNoTell = choice;
  } else {
    const T = c.personality.temperature;
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
  g.nightPicks = {};
  emit(g, { t: 'phase', phase: 'night', day: d });
}

function checkWin(g) {
  const living = alive(g);
  const m = living.filter((p) => p.role === 'mafia').length;
  let winner = null;
  if (m === 0) winner = 'town';
  else if (m >= living.length - m) winner = 'mafia';
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
      const score = (t) => {
        let s = -0.4 * (fs[t] ?? 0) + g.rng.gumbel() * 0.6;
        if ((g.statements[d] || []).some((st) => st.speaker === t && st.intent === 'claim')) s += 2;
        if (isHuman(g, t) && g.mode === 'single') s -= 0.6; // keep the solo player in the game more often
        return s;
      };
      victim = cands.map((t) => ({ t, s: score(t) })).sort((a, b) => b.s - a.s)[0]?.t ?? null;
    }
  }
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
  }
  if (checkWin(g)) return;
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
      finishVote(g);
    }
  } else if (p.type === 'night') {
    if (p.action !== 'sleep' && !p.targets.includes(action.target)) throw new Error('invalid target');
    resolveNight(g, action.target ? { [me]: action.target } : {});
  }
  setPending(g);
  return g.events.slice(start);
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
      finishVote(g);
    } else if (g.phase === 'night') resolveNight(g, {});
  }
}

// ---------- multi-mode API (collect, then reveal at once) ----------

// Who must still act in the current phase.
export function waitingOn(g) {
  if (g.phase === 'over') return [];
  const hs = aliveHumans(g);
  if (g.phase === 'night') return hs.filter((h) => nightAction(g, h).action !== 'sleep' && !(h in g.nightPicks));
  return hs.filter((h) => !(h in g.submitted));
}

export function humanOptions(g, h) {
  if (!isAlive(g, h) || g.phase === 'over') return { type: 'spectate' };
  const others = aliveIds(g).filter((x) => x !== h);
  if (g.phase === 'statement') return { type: 'statement', day: g.day, round: g.round, rounds: g.rounds, targets: others };
  if (g.phase === 'vote') return { type: 'vote', targets: others };
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
  else if (g.phase === 'vote') {
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
    finishVote(g);
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
      role: p.id === h || !p.alive || g.phase === 'over' ? p.role : null,
    })),
    votes: g.votes[g.day] ? g.votes[g.day].slice() : [],
    pending: g.pending,
    winner: g.winner,
    seerChecks: g.seerChecks.filter((x) => x.seer === h),
  };
}
