// Rejects any AI line that could misstate memory. A rejected line is replaced
// with a template built from the same evidence, so the game never shows a
// fabricated recollection.

import { HUMAN_ID, displayName } from '../core/characters.js';

const MEMORY_TALK = /(\d+\s*판|지난\s*(판|게임|번|라운드)|저번|예전|전에도|매번|항상|버릇|습관|기억)/;
const BANNED = /(기록|데이터|로그|저장|감시|추적)/;
const HUMAN_NAMES = ['당신', '너', '그쪽', '네가', '니가'];

function numbersIn(s) {
  return (s.match(/\d+/g) || []).map(Number);
}

// Returns null if ok, otherwise a short reason string.
export function checkLine(spec, line) {
  if (!line || typeof line.text !== 'string') return 'missing';
  const text = line.text.trim();
  if (text.length < 2 || text.length > 160) return 'length';
  if (BANNED.test(text)) return 'banned-word';
  const allowed = new Set((spec.evidence || []).map((e) => e.id));
  const cited = Array.isArray(line.evidence_ids) ? line.evidence_ids : [];
  if (cited.some((id) => !allowed.has(id))) return 'unknown-evidence';
  if (!allowed.size) {
    if (MEMORY_TALK.test(text)) return 'memory-without-evidence';
    if (/\d/.test(text)) return 'number-without-evidence';
  } else {
    if (!cited.length) return 'evidence-not-cited';
    const okNums = new Set(spec.evidence.flatMap((e) => numbersIn(e.text)));
    if (spec.day) okNums.add(spec.day);
    if (numbersIn(text).some((x) => !okNums.has(x))) return 'invented-number';
  }
  if (spec.target && ['accuse', 'defend', 'claim'].includes(spec.intent)) {
    const names = spec.target === HUMAN_ID ? HUMAN_NAMES : [displayName(spec.target)];
    if (!names.some((nm) => text.includes(nm))) return 'target-missing';
  }
  return null;
}
