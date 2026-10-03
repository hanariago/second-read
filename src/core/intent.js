// Free text -> structured intent, in code (no model). The author sees the
// result as a chip before sending and can override it with a click, so tells
// are always computed from a choice the player confirmed.

const ACCUSE = ['수상', '의심', '마피아', '범인', '찍', '투표하자', '거짓말', '이상해', '이상한', '냄새', '구라', '뻥', '아웃', '처형', '죽이자', '보내자', '같은데', '맞지', '맞네', '맞음'];
const DEFEND = ['믿', '시민', '결백', '아닌', '아니야', '아니야', '아님', '아니라', '아닐', '착해', '편', '살리', '살려', '괜찮', '무고', '감싸'];
const DENY = ['나 아니', '난 아니', '나는 아니', '내가 왜', '나 시민', '난 시민', '나는 시민', '억울', '아니라고', '진짜 아님', '나 아님', '난 아님'];
const CLAIM = ['예언', '조사', '확인했', '검사'];
const NEGATION = ['아닌', '아니', '아님', '안 ', '않'];

const has = (text, words) => words.some((w) => text.includes(w));

// names: { id: displayName } for seats other than the author.
export function parseIntent(text, names) {
  const t = String(text || '').trim();
  if (!t) return { intent: 'skip', target: null, confidence: 1 };
  const mentioned = Object.entries(names)
    .map(([id, nm]) => ({ id, at: t.indexOf(nm), nm }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at);
  const target = mentioned[0]?.id ?? null;

  if (has(t, CLAIM) && target) {
    const after = t.slice(mentioned[0].at);
    const saysMafia = after.includes('마피아') && !has(after, ['아니', '아님', '아닌']);
    const result = saysMafia ? 'mafia' : after.includes('시민') || has(after, ['아니', '아님']) ? 'town' : null;
    if (result) return { intent: 'claim', target, result, confidence: 0.8 };
  }
  if (!target) {
    if (has(t, DENY)) return { intent: 'deny', target: null, confidence: 0.7 };
    return { intent: 'pass', target: null, confidence: 0.6 };
  }
  // Look at the words around the first name mentioned.
  const around = t.slice(Math.max(0, mentioned[0].at - 8), mentioned[0].at + mentioned[0].nm.length + 16);
  const negMafia = around.includes('마피아') && has(around, NEGATION);
  if (negMafia || (has(around, DEFEND) && !has(around, ['수상', '의심', '거짓말']))) return { intent: 'defend', target, confidence: 0.7 };
  if (has(around, ACCUSE) || has(t, ACCUSE)) return { intent: 'accuse', target, confidence: 0.75 };
  if (t.endsWith('?')) return { intent: 'accuse', target, confidence: 0.4 }; // a pointed question
  return { intent: 'pass', target: null, confidence: 0.4 };
}
