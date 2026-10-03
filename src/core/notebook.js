// The player's notebook on the rivals: rivals have habits too, mostly when
// they play mafia, and the player learns them across games. Habits are
// assigned per profile and can change after the player has caught one, so
// the notebook never turns into a fixed cheat sheet.

import { buildTellModel, describeModel } from './tells.js';
import { CHARACTERS } from './characters.js';

export const AI_FEATURES = {
  ai_pass_r1: { label: '첫 라운드에 관망' },
  ai_defend: { label: '누군가를 감쌈' },
  ai_accuse_you: { label: '나를 의심함' },
  ai_deny: { label: '의심받으면 부인' },
  ai_vote_you: { label: '나에게 투표' },
};
export const AI_FEATURE_IDS = Object.keys(AI_FEATURES);

// Each habit shows up as one notebook feature.
export const HABITS = {
  quiet_first: { feature: 'ai_pass_r1', p: 0.8 },
  defends_partner: { feature: 'ai_defend', p: 0.8 },
  accuses_you: { feature: 'ai_accuse_you', p: 0.8 },
  quick_deny: { feature: 'ai_deny', p: 0.85 },
  votes_you: { feature: 'ai_vote_you', p: 0.75 },
};
const HABIT_IDS = Object.keys(HABITS);

export function assignHabits(existing = {}, rand = Math.random) {
  const out = { ...existing };
  for (const c of CHARACTERS) if (!HABITS[out[c.id]]) out[c.id] = HABIT_IDS[Math.floor(rand() * HABIT_IDS.length)];
  return out;
}

// After a game where the player voted out a mafia rival whose habit showed,
// that rival may quietly switch habits. Returns { habits, changed: [ids] }.
export function maybeRerollHabits(habits, record, rand = Math.random) {
  const next = { ...habits };
  const changed = [];
  for (const id of record.habitsShown || []) {
    const caught = (record.myVotes || []).some((v) => v.target === id);
    if (!caught || rand() > 0.3) continue;
    const pool = HABIT_IDS.filter((h) => h !== next[id]);
    next[id] = pool[Math.floor(rand() * pool.length)];
    changed.push(id);
  }
  return { habits: next, changed };
}

// Literal per-role counts of what the player saw each rival do, from past games only.
export function notebookFor(games, aiId, currentN) {
  const asGames = games
    .filter((g) => g.aiObs?.[aiId])
    .map((g) => ({ n: g.n, role: g.aiObs[aiId].role, obs: g.aiObs[aiId].obs }));
  const model = buildTellModel(asGames, currentN, { features: AI_FEATURE_IDS, minGap: 0.25, decay: 0.95 });
  return describeModel(model, AI_FEATURE_IDS, AI_FEATURES);
}

// One line for a seat card: the clearest past difference, if any.
export function seatNote(games, aiId, currentN) {
  const rows = notebookFor(games, aiId, currentN).filter((r) => r.ready).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
  const r = rows[0];
  if (!r) return null;
  return `${r.label}: 마피아 ${r.mafia.k}/${r.mafia.n} · 시민 ${r.town.k}/${r.town.n}`;
}
