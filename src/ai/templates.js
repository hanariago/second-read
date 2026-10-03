// Deterministic lines. Used when no AI is available, when a response is late,
// or when an AI line fails validation. Memory is only ever quoted from evidence.

import { HUMAN_ID, displayName } from '../core/characters.js';
import { FEATURES } from '../core/tells.js';

const hasBatchim = (word) => {
  const c = word.charCodeAt(word.length - 1) - 0xac00;
  return c >= 0 && c <= 11171 && c % 28 !== 0;
};
const JOSA = { 는: ['은', '는'], 가: ['이', '가'], 를: ['을', '를'], 랑: ['이랑', '랑'], 와: ['과', '와'] };

// Fills {t} with a name and fixes the particle after it (레온은 / 미오는).
export function withName(str, id) {
  const human = id === HUMAN_ID;
  const nm = id ? displayName(id) : '';
  return str
    .replace(/\{t\}\s*(씨|님)(는|가|를|랑|와)?/g, (_, h, j) =>
      human ? '당신' + (j ? JOSA[j][0] : '') : `${nm} ${h}${j ?? ''}`,
    )
    .replace(/\{t\}(는|가|를|랑|와)/g, (_, j) => nm + JOSA[j][hasBatchim(nm) ? 0 : 1])
    .replaceAll('{t}', nm);
}

const pick = (arr, seed) => arr[Math.abs(seed) % arr.length];
const hash = (s) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 7);

const V = {
  leon: {
    accuse: ['{t} 씨에게 의심이 갑니다. 지금까지의 흐름이 맞지 않아요.', '{t} 씨. 계산이 안 맞는 쪽은 당신입니다.'],
    defend: ['{t} 씨는 일단 제외하겠습니다. 근거가 약해요.', '{t} 씨를 의심할 이유는 아직 없습니다.'],
    pass: ['아직 판단하기엔 정보가 부족합니다.', '표를 서두를 이유는 없습니다. 조금 더 보죠.'],
    claimMafia: ['제가 예언자입니다. {t} 씨, 마피아로 나왔습니다.'],
    claimTown: ['제가 예언자입니다. {t} 씨는 시민으로 확인했습니다.'],
    memory: ['{ev}. 우연이라기엔 숫자가 너무 맞습니다.', '{ev}. 같은 계산이 또 나오네요.'],
    clear: ['{ev}. 시민일 때의 당신과 같은 패턴이군요.'],
    asideSuspect: ['{ev}. ...메모해 두죠.'],
    asideClear: ['{ev}. 이번엔 시민 쪽 숫자네요.'],
  },
  mio: {
    accuse: ['솔직히 {t} 좀 수상해! 감이 그래.', '나 {t} 찍을래. 느낌이 쎄해!'],
    defend: ['{t}는 아닌 것 같아~ 표정이 너무 억울해 보여.', '{t} 말고 다른 사람 보자!'],
    pass: ['음~ 아직 잘 모르겠어. 다들 말 좀 더 해봐!', '난 일단 구경할래!'],
    claimMafia: ['나 예언자야! {t}, 마피아로 나왔어!'],
    claimTown: ['나 예언자야. {t}는 시민이었어!'],
    memory: ['잠깐, {ev}. 딱 그때랑 똑같잖아!', '{ev}. 이거 너 버릇이지?'],
    clear: ['{ev}. 시민일 때 너랑 똑같네~ 패스!'],
    asideSuspect: ['어?! {ev}. 나 봤다~'],
    asideClear: ['{ev}. 오늘은 순한 쪽이네?'],
  },
  bruno: {
    accuse: ['흠. {t}, 내 경험상 냄새가 나.', '{t}. 눈 피하지 마. 수상해.'],
    defend: ['{t}는 아냐. 내 감은 안 틀려.', '{t} 건드리지 마. 헛다리야.'],
    pass: ['다들 너무 빨리 몰려가. 좀 지켜보자고.', '흠. 아직 아무도 못 믿겠어.'],
    claimMafia: ['내가 예언자다. {t}, 마피아로 나왔어.'],
    claimTown: ['내가 예언자다. {t}는 시민이야.'],
    memory: ['{ev}. 버릇은 안 바뀌는 법이지.', '{ev}. 오래 형사 하면 이런 건 보여.'],
    clear: ['{ev}. 시민일 때 하던 대로군. 넘어가지.'],
    asideSuspect: ['{ev}. 흠, 또 그러는군.'],
    asideClear: ['{ev}. 오늘은 다르게 나오는군.'],
  },
  sera: {
    accuse: ['{t} 님, 그 수는 읽혔어요.', '{t} 님 쪽 진형이 어딘가 어색하네요.'],
    defend: ['{t} 님은 아니에요. 그 수는 시민의 수예요.', '{t} 님을 잡는 건 악수(惡手)예요.'],
    pass: ['아직 판이 덜 짜였어요. 지켜보죠.', '서두르면 지는 판이에요.'],
    claimMafia: ['예언자로서 말할게요. {t} 님, 마피아였어요.'],
    claimTown: ['예언자로서 말할게요. {t} 님은 시민이었어요.'],
    memory: ['{ev}. 같은 수를 또 두시네요.', '{ev}. 그 정석, 기억하고 있어요.'],
    clear: ['{ev}. 시민일 때의 수순 그대로네요.'],
    asideSuspect: ['{ev}. 체크.'],
    asideClear: ['{ev}. 흥미로운 수네요.'],
  },
};

const REMARK_EMPTY = {
  leon: '아직 표본이 부족합니다. 다음 판에 다시 계산하죠.',
  mio: '아직 너 잘 모르겠어! 다음 판에 또 보자~',
  bruno: '흠. 아직 꼬리를 못 잡았군. 다음엔 잡는다.',
  sera: '아직 당신의 정석을 다 못 읽었어요. 다음 대국에서 봬요.',
};

// Short spoken form of evidence, e.g. "'가장 먼저 투표' 마피아일 때 2/2, 시민일 때 0/2 — 오늘도 제일 먼저 투표했고".
// The full sentences stay visible as chips under the line.
function evidenceSentence(evidence) {
  const byF = new Map();
  for (const e of evidence) {
    if (!byF.has(e.f)) byF.set(e.f, []);
    byF.get(e.f).push(e);
  }
  const parts = [];
  for (const [f, items] of byF) {
    const hist = items.filter((e) => e.kind === 'mafia' || e.kind === 'town').map((e) => e.short ?? e.text);
    const now = items.find((e) => e.kind === 'now');
    const label = f && FEATURES[f] ? `'${FEATURES[f].label}' ` : '';
    const head = hist.length ? `${label}${hist.join(', ')}` : '';
    parts.push([head, now?.short ?? now?.text].filter(Boolean).join(' — '));
  }
  // Remark stats have no feature id; show at most two plainly.
  const plain = evidence.filter((e) => !e.f).slice(0, 2).map((e) => e.text);
  return [...parts, ...plain].join(' / ');
}

// spec: {speaker, intent, target, result?, evidence[], kind?}
export function templateLine(spec, seed = 0) {
  const v = V[spec.speaker];
  if (!v) return '';
  const s = seed + hash(spec.speaker + (spec.target || '') + spec.intent);
  const fill = (str) => withName(str, spec.target).replaceAll('{ev}', evidenceSentence(spec.evidence || []));
  if (spec.t === 'aside') return fill(pick(spec.kind === 'suspect' ? v.asideSuspect : v.asideClear, s));
  if (spec.intent === 'remark') {
    const ev = (spec.evidence || []).slice(0, 2);
    if (!ev.length) return REMARK_EMPTY[spec.speaker];
    return pick(v.memory, s).replaceAll('{ev}', evidenceSentence(ev));
  }
  if (spec.intent === 'claim') return fill(pick(spec.result === 'mafia' ? v.claimMafia : v.claimTown, s));
  const base = fill(pick(v[spec.intent] || v.pass, s));
  if (spec.evidence?.length && spec.target === HUMAN_ID) {
    const mem = fill(pick(spec.intent === 'defend' ? v.clear : v.memory, s));
    return `${base} ${mem}`;
  }
  return base;
}

export function humanLine(st) {
  if (st.intent === 'accuse') return withName('{t}, 수상해.', st.target);
  if (st.intent === 'defend') return withName('{t}는 믿어도 될 것 같아.', st.target);
  if (st.intent === 'claim') return withName(`내가 예언자야. {t}는 ${st.result === 'mafia' ? '마피아' : '시민'}로 나왔어.`, st.target);
  return '...일단 지켜볼게.';
}
