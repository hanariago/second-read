// The player's local profile: finished-game records only (role, click-derived
// observations, which AI decisions memory changed). No account data lives here.

import { CHARACTERS } from './characters.js';
import { buildTellModel, describeModel, FEATURES } from './tells.js';

export const PROFILE_VERSION = 1;
const MAX_GAMES = 40;

export function emptyProfile() {
  return { version: PROFILE_VERSION, games: [], settings: { memory: true } };
}

export function normalizeProfile(p) {
  if (!p || p.version !== PROFILE_VERSION || !Array.isArray(p.games)) return emptyProfile();
  return { ...emptyProfile(), ...p, settings: { ...emptyProfile().settings, ...(p.settings || {}) } };
}

export function nextGameNumber(profile) {
  return profile.games.length ? profile.games[profile.games.length - 1].n + 1 : 1;
}

export function addGame(profile, record) {
  const games = [...profile.games, record].slice(-MAX_GAMES);
  return { ...profile, games };
}

// Only games played with memory on feed future tells, so the off switch is a clean comparison.
export function memoryGames(profile) {
  return profile.games.filter((g) => g.memory !== false);
}

export function tallies(profile) {
  const t = { read: 0, misread: 0, deceived: 0, cleared: 0 };
  for (const g of profile.games) for (const f of g.flips || []) t[f.kind] = (t[f.kind] || 0) + 1;
  // Player wins: rivals misled by planted habits (either direction).
  return { ...t, bluffs: t.deceived + t.misread, caught: t.read };
}

// Data for the "AI가 본 당신" screen after a game.
export function rivalReport(profile, lastRecord) {
  const games = memoryGames(profile);
  const n = nextGameNumber(profile);
  const model = buildTellModel(games, n);
  const all = describeModel(model);
  const rivals = CHARACTERS.map((c) => {
    const tells = all.filter((x) => c.watches.includes(x.f));
    const flips = (lastRecord?.flips || []).filter((f) => f.voter === c.id);
    return { id: c.id, name: c.name, watchLabel: c.watchLabel, tells, flips };
  });
  return { gamesSeen: games.length, rivals, tells: all, tally: tallies(profile), featureLabels: FEATURES };
}

// Evidence for each rival's end-of-game remark: the same literal summaries the
// report screen shows, so the remark cannot claim anything the screen doesn't.
export function remarkSpecs(report) {
  return report.rivals.map((r) => {
    const evidence = [];
    r.tells.forEach((t, i) => {
      if (!t.mafia.n && !t.town.n) return;
      const sides = [];
      if (t.mafia.n) sides.push(`마피아일 때 ${t.mafia.k}/${t.mafia.n}회`);
      if (t.town.n) sides.push(`시민일 때 ${t.town.k}/${t.town.n}회`);
      evidence.push({ id: `${r.id}-r${i}`, kind: 'stat', text: `'${t.label}': ${sides.join(', ')}` });
    });
    r.flips.forEach((f, i) => {
      const nm = (id) => (id === 'you' ? '당신' : report.rivals.find((x) => x.id === id)?.name ?? id);
      evidence.push({
        id: `${r.id}-f${i}`,
        kind: 'flip',
        text: `이번 판 ${f.day}일차 투표: 기억이 없었다면 ${nm(f.withoutTell)}, 실제로는 ${nm(f.withTell)}에게 투표`,
      });
    });
    return { speaker: r.id, intent: 'remark', target: null, evidence };
  });
}
