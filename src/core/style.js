// How people in your multiplayer rooms talk, learned after each game so the
// rivals can blend in. Stored only on this device. Lines that could carry
// real-world details (numbers, links, handles) are never kept as examples.

const BLOCK = /(\d|https?:|www\.|@|\.com|\.kr|\.net)/i;
const MAX_EXAMPLES = 30;

export function emptyStyle() {
  return { version: 1, count: 0, skipRate: 0, rounds: 0, avg: { len: 0, laugh: 0, ellipsis: 0, question: 0, polite: 0, period: 0, emoji: 0 }, examples: [] };
}

function traits(t) {
  return {
    len: t.length,
    laugh: /[ㅋㅎ]{2,}/.test(t) ? 1 : 0,
    ellipsis: /\.\.|…/.test(t) ? 1 : 0,
    question: /\?/.test(t) ? 1 : 0,
    polite: /(요|니다|세요|죠)[.!?~\s]*$/.test(t) ? 1 : 0,
    period: /[^.]\.$/.test(t) ? 1 : 0,
    emoji: /\p{Extended_Pictographic}/u.test(t) ? 1 : 0,
  };
}

// texts: human lines from one finished game; skipped: how many rounds humans skipped.
export function learnStyle(style, texts, { skipped = 0, rounds = 0 } = {}) {
  const s = structuredClone(style?.version === 1 ? style : emptyStyle());
  for (const raw of texts) {
    const t = String(raw).trim();
    if (!t || t.length > 80) continue;
    const tr = traits(t);
    s.count += 1;
    for (const k of Object.keys(s.avg)) s.avg[k] += (tr[k] - s.avg[k]) / s.count;
    if (t.length <= 40 && !BLOCK.test(t) && !s.examples.includes(t)) s.examples.push(t);
  }
  s.examples = s.examples.slice(-MAX_EXAMPLES);
  if (rounds) {
    s.rounds += rounds;
    s.skipRate += (skipped - s.skipRate * rounds) / Math.max(1, s.rounds);
    s.skipRate = Math.min(0.6, Math.max(0, s.skipRate));
  }
  return s;
}

const pct = (x) => `${Math.round(x * 100)}%`;

// Compact description for the model; null until there is something to learn from.
export function styleForPrompt(style, pick = Math.random) {
  if (!style || style.count < 3) return null;
  const a = style.avg;
  const traitsText = [
    `평균 길이 ${Math.round(a.len)}자`,
    `ㅋㅋ/ㅎㅎ ${pct(a.laugh)}`,
    `말줄임 ${pct(a.ellipsis)}`,
    `물음표 ${pct(a.question)}`,
    `존댓말 끝맺음 ${pct(a.polite)}`,
    `마침표 ${pct(a.period)}`,
  ].join(', ');
  const ex = style.examples.slice();
  const examples = [];
  while (ex.length && examples.length < 8) examples.push(ex.splice(Math.floor(pick() * ex.length), 1)[0]);
  return { traits: traitsText, examples };
}
