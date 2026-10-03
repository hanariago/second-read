// Tells = differences in the player's structured choices between roles.
// Everything here is computed from click data; no dialogue text is involved.
// The LLM never sees these numbers, only the evidence sentences built below.

export const FEATURES = {
  vote_first: {
    label: '가장 먼저 투표',
    yes: '가장 먼저 투표했다',
    no: '다른 사람이 투표한 뒤에 투표했다',
    nowYes: '오늘도 제일 먼저',
    nowNo: '오늘은 기다렸다가',
  },
  vote_follow: {
    label: '표가 몰린 쪽에 편승',
    yes: '이미 표가 가장 많이 몰린 사람에게 투표했다',
    no: '표가 몰린 쪽과 다른 사람에게 투표했다',
    nowYes: '오늘도 표 몰린 쪽',
    nowNo: '오늘은 대세 반대쪽',
  },
  stance_accuse: {
    label: '첫 마디부터 의심',
    yes: '첫 발언에서 누군가를 의심했다',
    no: '첫 발언에서 누구도 의심하지 않았다',
    nowYes: '오늘도 첫 마디부터 의심',
    nowNo: '오늘은 의심 없이 시작',
  },
  stance_pass: {
    label: '첫 마디는 관망',
    yes: '첫 발언에서 관망했다',
    no: '첫 발언에서 입장을 냈다',
    nowYes: '오늘도 관망',
    nowNo: '오늘은 입장부터',
  },
  vote_retaliate: {
    label: '나를 의심한 사람에게 보복 투표',
    yes: '자신을 의심한 사람에게 투표했다',
    no: '자신을 의심한 사람이 아닌 쪽에 투표했다',
    nowYes: '오늘도 보복 투표',
    nowNo: '오늘은 보복 없이',
  },
  vote_own_accused: {
    label: '내가 의심한 사람에게 투표',
    yes: '그날 자신이 의심한 사람에게 투표했다',
    no: '그날 자신이 의심한 사람이 아닌 쪽에 투표했다',
    nowYes: '오늘도 말한 대로 투표',
    nowNo: '오늘은 말과 다르게 투표',
  },
  round_skip: {
    label: '토론 라운드 건너뛰기',
    yes: '토론 라운드에서 말없이 넘어갔다',
    no: '토론 라운드에서 말을 했다',
    nowYes: '오늘도 말없이 넘김',
    nowNo: '오늘은 입을 열었고',
  },
  victim_accuser: {
    label: '나를 의심한 사람이 밤에 제거됨',
    yes: '밤 희생자가 낮에 당신을 의심했던 사람이었다',
    no: '밤 희생자가 낮에 당신을 의심했던 사람이 아니었다',
    nowYes: '어젯밤에도 당신을 의심한 사람이 쓰러짐',
    nowNo: '어젯밤엔 다른 사람이 쓰러짐',
  },
};

export const FEATURE_IDS = Object.keys(FEATURES);

const ROLE_KO = { mafia: '마피아', town: '시민' };
export const roleSide = (role) => (role === 'mafia' ? 'mafia' : 'town');

export const TELL_DEFAULTS = {
  decay: 0.8, // weight multiplier per game of age; recent games matter more
  minGap: 0.25, // smoothed rate gap needed before an AI treats it as a tell
  clip: 2.5, // cap on total log-likelihood ratio from tells
  weight: 1.5, // rivals over-trust their own specialty; makes memory matter, and makes them fallible
};

// games: past finished game records [{n, role, obs:[{f, v, day}]}]
export function buildTellModel(games, currentN, opts = {}) {
  const { decay, minGap } = { ...TELL_DEFAULTS, ...opts };
  const model = {};
  for (const f of FEATURE_IDS) {
    const side = {
      mafia: { k: 0, n: 0, rawK: 0, rawN: 0, games: [] },
      town: { k: 0, n: 0, rawK: 0, rawN: 0, games: [] },
    };
    for (const g of games) {
      if (g.n >= currentN) continue;
      const obs = (g.obs || []).filter((o) => o.f === f);
      if (!obs.length) continue;
      const w = Math.pow(decay, Math.max(0, currentN - g.n - 1));
      const s = side[roleSide(g.role)];
      let gk = 0;
      for (const o of obs) {
        s.n += w;
        s.rawN += 1;
        if (o.v) {
          s.k += w;
          s.rawK += 1;
          gk += 1;
        }
      }
      s.games.push({ n: g.n, k: gk, total: obs.length });
    }
    const pM = (side.mafia.k + 1) / (side.mafia.n + 2);
    const pT = (side.town.k + 1) / (side.town.n + 2);
    const ready = side.mafia.rawN >= 1 && side.town.rawN >= 1 && Math.abs(pM - pT) >= minGap;
    model[f] = {
      f,
      mafia: side.mafia,
      town: side.town,
      pM,
      pT,
      ready,
      // Which value of the feature points at mafia.
      mafiaValue: pM >= pT,
    };
  }
  return model;
}

export function logLR(model, f, v) {
  const m = model[f];
  if (!m || !m.ready) return 0;
  return v ? Math.log(m.pM / m.pT) : Math.log((1 - m.pM) / (1 - m.pT));
}

// Sum of tell evidence from the features one character watches,
// using observations made so far in the current game.
export function tellTerm(model, watches, currentObs, opts = {}) {
  const { clip, weight } = { ...TELL_DEFAULTS, ...opts };
  const parts = [];
  let total = 0;
  for (const o of currentObs) {
    if (!watches.includes(o.f)) continue;
    const llr = weight * logLR(model, o.f, o.v);
    if (llr === 0) continue;
    parts.push({ ...o, llr });
    total += llr;
  }
  total = Math.max(-clip, Math.min(clip, total));
  return { total, parts };
}

function gameList(gs) {
  return gs.map((g) => `${g.n}판`).join('·');
}

// Evidence sentences are the only memory the LLM may mention.
// Each is a literal summary of stored click data.
export function evidenceForPart(model, part, idPrefix) {
  const m = model[part.f];
  const F = FEATURES[part.f];
  const ev = [];
  const now = `이번 판 ${part.day}일차엔 ${part.v ? F.yes : F.no}`;
  ev.push({ id: `${idPrefix}-now`, f: part.f, kind: 'now', text: now, short: part.v ? F.nowYes : F.nowNo });
  for (const side of ['mafia', 'town']) {
    const s = m[side];
    if (!s.games.length) continue;
    const text = `${ROLE_KO[side]}였던 ${gameList(s.games)}에서 '${F.label}' ${s.rawK}/${s.rawN}회`;
    ev.push({ id: `${idPrefix}-${side}`, f: part.f, kind: side, text, short: `${ROLE_KO[side]}일 때 ${s.rawK}/${s.rawN}` });
  }
  return ev;
}

// Strongest-first evidence for one speaker about the human.
export function evidenceForTerm(model, term, idPrefix, max = 1) {
  const parts = term.parts
    .slice()
    .sort((a, b) => Math.abs(b.llr) - Math.abs(a.llr))
    .filter((p) => Math.sign(p.llr) === Math.sign(term.total))
    .slice(0, max);
  return parts.flatMap((p, i) => evidenceForPart(model, p, `${idPrefix}${i + 1}`));
}

// Human-readable summary of every tell for the "AI가 본 당신" screen.
export function describeModel(model) {
  return FEATURE_IDS.map((f) => {
    const m = model[f];
    return {
      f,
      label: FEATURES[f].label,
      mafia: { k: m.mafia.rawK, n: m.mafia.rawN, rate: m.pM },
      town: { k: m.town.rawK, n: m.town.rawN, rate: m.pT },
      ready: m.ready,
      gap: m.pM - m.pT,
    };
  });
}
