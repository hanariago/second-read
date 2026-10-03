// Rejects any AI line that could misstate memory. A rejected line is replaced
// with a template built from the same evidence, so the game never shows a
// fabricated recollection.

import { HUMAN_ID, displayName } from '../core/characters.js';

// Only references to *other games* need evidence; talk about this game is fine.
const MEMORY_TALK = /(\d+\s*판|(지난|저번|이전|예전)\s*(판|게임|겜)|매번|버릇|습관|(늘|항상)\s*그)/;
const BANNED = /(기록|데이터|로그|저장|감시|추적)/;
const HUMAN_NAMES = ['당신', '너', '그쪽', '네가', '니가'];

function numbersIn(s) {
  return (s.match(/\d+/g) || []).map(Number);
}

// ctx: { nameOf, allowNumbers } — nameOf maps seat ids to display names
// (multiplayer nicknames); allowNumbers come from this game's visible chat.
// Returns null if ok, otherwise a short reason string.
export function checkLine(spec, line, ctx = {}) {
  const nameOf = ctx.nameOf ?? displayName;
  if (!line || typeof line.text !== 'string') return 'missing';
  const text = line.text.trim();
  if (text.length < 1 || text.length > 160) return 'length';
  if (BANNED.test(text)) return 'banned-word';
  const allowed = new Set((spec.evidence || []).map((e) => e.id));
  const cited = Array.isArray(line.evidence_ids) ? line.evidence_ids : [];
  if (cited.some((id) => !allowed.has(id))) return 'unknown-evidence';
  const okNums = new Set([...(ctx.allowNumbers || []), ...(spec.day ? [spec.day] : [])]);
  if (!allowed.size) {
    if (MEMORY_TALK.test(text)) return 'memory-without-evidence';
  } else {
    if (!cited.length) return 'evidence-not-cited';
    for (const e of spec.evidence) for (const x of numbersIn(e.text)) okNums.add(x);
  }
  if (numbersIn(text).some((x) => !okNums.has(x))) return allowed.size ? 'invented-number' : 'number-without-evidence';
  if (spec.target && ['accuse', 'defend', 'claim'].includes(spec.intent)) {
    const names = spec.target === HUMAN_ID && nameOf === displayName ? HUMAN_NAMES : [nameOf(spec.target)];
    if (!names.some((nm) => text.includes(nm))) return 'target-missing';
  }
  return null;
}
