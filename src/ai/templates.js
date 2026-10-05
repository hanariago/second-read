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
export function withName(str, id, nameOf = displayName) {
  const human = id === HUMAN_ID && nameOf === displayName;
  const nm = id ? nameOf(id) : '';
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
    deny: ['저는 아닙니다. 계산해 보시면 압니다.'],
    claimBare: ['예언자는 접니다. 다른 주장은 믿지 마세요.'],
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
    deny: ['나 아니거든! 억울해!'],
    claimBare: ['잠깐! 진짜 예언자는 나야!'],
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
    deny: ['헛다리 짚지 마. 난 아냐.'],
    claimBare: ['예언자는 나다. 저건 가짜야.'],
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
    deny: ['저를 잡는 건 악수예요. 저는 아니에요.'],
    claimBare: ['예언자는 저예요. 그 주장은 악수(惡手)예요.'],
  },
};

V.kai = {
  accuse: ['와 {t} 진짜 수상하다 레전드네', '{t} 이거 각 나왔다!'],
  defend: ['{t}는 찐 시민 바이브임', '{t} 건드리면 안 돼~'],
  pass: ['아 노잼, 아직 감이 안 와', '다들 텐션 왜 이래 일단 보자'],
  claimMafia: ['나 예언자다! {t} 마피아 떴어!'],
  claimTown: ['나 예언자임, {t}는 시민 확정!'],
  memory: ['{ev}. 이거 완전 패턴이잖아!', '{ev}. 소름 돋았다 진짜'],
  clear: ['{ev}. 시민 때랑 똑같네 패스!'],
  asideSuspect: ['{ev}. 와 이거 각인데?'],
  asideClear: ['{ev}. 오 이번엔 다르네?'],
  deny: ['나? 에이 말도 안 돼!'],
  claimBare: ['아니 진짜 예언자는 나라고!'],
};
V.noa = {
  accuse: ['{t} 님, 조금 걱정되는 부분이 있어요.', '{t} 님 말씀이 계속 마음에 걸려요.'],
  defend: ['{t} 님을 너무 몰아붙이는 것 같아요.', '{t} 님은 아닐 거예요, 제 느낌엔.'],
  pass: ['다들 조금만 천천히 얘기해 봐요.', '아직은 누구도 확신이 안 서요.'],
  claimMafia: ['제가 예언자예요. {t} 님, 마피아로 나왔어요.'],
  claimTown: ['제가 예언자예요. {t} 님은 시민이었어요.'],
  memory: ['{ev}. 그때도 그러셨던 거 기억나요.', '{ev}. 조심스럽지만 같은 모습이에요.'],
  clear: ['{ev}. 시민일 때 모습 그대로예요.'],
  asideSuspect: ['{ev}... 마음에 걸리네요.'],
  asideClear: ['{ev}. 다행이에요.'],
  deny: ['저는 정말 아니에요. 믿어 주세요.'],
  claimBare: ['제가 진짜 예언자예요. 믿어 주세요.'],
};

V.doyun = {
  accuse: ['{t} 씨, 이의 있습니다. 앞뒤가 안 맞아요.', '{t} 씨 진술은 신빙성이 떨어집니다.'],
  defend: ['{t} 씨를 의심할 근거는 부족합니다.', '{t} 씨는 일관됐어요. 넘어가죠.'],
  pass: ['증거가 더 필요합니다.', '아직 판단을 보류하겠습니다.'],
  claimMafia: ['예언자로서 진술합니다. {t} 씨, 마피아입니다.'],
  claimTown: ['예언자로서 진술합니다. {t} 씨는 시민입니다.'],
  claimBare: ['정정합니다. 진짜 예언자는 저입니다.'],
  memory: ['{ev}. 진술이 매번 같은 방향이네요.', '{ev}. 기록이 말해 줍니다.'],
  clear: ['{ev}. 시민일 때의 진술과 일치합니다.'],
  asideSuspect: ['{ev}. 기록해 두죠.'],
  asideClear: ['{ev}. 이번엔 다르군요.'],
  deny: ['저는 아닙니다. 근거를 대 보세요.'],
};
V.hajun = {
  accuse: ['{t}, 수상해. 내 눈엔 그래.', '{t} 쪽이 영 찜찜하네.'],
  defend: ['{t}는 아냐. 그냥 알아.', '{t} 그만 몰아.'],
  pass: ['좀 더 보자고.', '...지켜보는 중이야.'],
  claimMafia: ['나 예언자야. {t}, 마피아로 나왔어.'],
  claimTown: ['나 예언자야. {t}는 시민이었고.'],
  claimBare: ['예언자는 나야. 저건 가짜고.'],
  memory: ['{ev}. 손님들 버릇은 안 변하더라.', '{ev}. 또 그러네.'],
  clear: ['{ev}. 시민 때 그대로야.'],
  asideSuspect: ['{ev}. 흠.'],
  asideClear: ['{ev}. 웬일이래.'],
  deny: ['나 아냐. 괜히 헛심 쓰지 마.'],
};

V.yuri = {
  accuse: ['{t} 씨, 말과 태도가 조금 어긋나요.', '{t} 씨 반응이 흥미롭네요. 의심스러워요.'],
  defend: ['{t} 씨는 일관돼 보여요.', '{t} 씨를 몰아가는 건 성급해요.'],
  pass: ['조금 더 관찰할게요.', '아직은 판단하기 이르네요.'],
  claimMafia: ['제가 예언자예요. {t} 씨, 마피아로 나왔어요.'],
  claimTown: ['제가 예언자예요. {t} 씨는 시민이었어요.'],
  claimBare: ['예언자는 저예요. 그 주장은 믿기 어렵네요.'],
  memory: ['{ev}. 패턴이 꽤 분명해요.', '{ev}. 흥미로운 일관성이네요.'],
  clear: ['{ev}. 시민일 때와 같은 반응이에요.'],
  asideSuspect: ['{ev}. 메모해 둘게요.'],
  asideClear: ['{ev}. 이번엔 다르네요.'],
  deny: ['저는 아니에요. 제 반응을 다시 보세요.'],
};
V.taeo = {
  accuse: ['{t}, 냄새가 나. 탄내야.', '{t} 너 수상해. 불 맞을 준비 해.'],
  defend: ['{t}는 놔둬. 아직 덜 익었어.', '{t} 말고 다른 놈 보자.'],
  pass: ['아직 간 보는 중이야.', '불 조절 좀 하자고.'],
  claimMafia: ['나 예언자다. {t}, 마피아야.'],
  claimTown: ['나 예언자다. {t}는 시민이고.'],
  claimBare: ['예언자는 나야. 저건 가짜 재료고.'],
  memory: ['{ev}. 매번 같은 레시피네.', '{ev}. 손맛은 안 변하지.'],
  clear: ['{ev}. 시민 때 그 맛이네.'],
  asideSuspect: ['{ev}. 어디서 탄내가 나는데?'],
  asideClear: ['{ev}. 이번엔 간이 다르네.'],
  deny: ['나? 웃기지 마. 난 아냐.'],
};
V.gaeun = {
  accuse: ['{t}, 이거 반전 각인데? 수상해!', '{t} 캐릭터 설정이 좀 이상해.'],
  defend: ['{t}는 그냥 조연 같아~', '{t}는 아냐, 너무 뻔하잖아.'],
  pass: ['음~ 아직 떡밥이 부족해.', '다음 화까지 지켜볼래.'],
  claimMafia: ['나 예언자야! {t}, 마피아로 나왔어!'],
  claimTown: ['나 예언자야. {t}는 시민이었어.'],
  claimBare: ['잠깐, 진짜 예언자는 나야!'],
  memory: ['{ev}. 이 떡밥 전에도 봤어!', '{ev}. 복선 회수 완료~'],
  clear: ['{ev}. 시민일 때 전개랑 똑같네.'],
  asideSuspect: ['{ev}. 오, 복선이다.'],
  asideClear: ['{ev}. 전개가 바뀌었네?'],
  deny: ['나 아냐! 그건 너무 뻔한 전개야!'],
};

// Multiplayer: rivals must read like people in a group chat, so the fallback
// lines are short, casual and identical in tone for every seat.
const CASUAL = {
  accuse: ['{t} 좀 수상함', '난 {t} 의심됨', '{t} 아까부터 이상한데', '솔직히 {t} 같음', '{t} 쪽 냄새남'],
  defend: ['{t}는 아닌듯', '{t}는 믿어봄', '{t} 말고 딴사람 같은데', '{t}는 시민 같음'],
  pass: ['음 아직 모르겠음', '좀 더 보자', '다들 말 좀 해봐', '흠..', '일단 패스'],
  deny: ['나 아님 ㄹㅇ', '왜 나야 ㅋㅋ', '나 시민임', '억울하네'],
  claimMafia: ['나 예언자임 {t} 마피아 나옴', '조사했는데 {t} 마피아임'],
  claimTown: ['나 예언자임 {t} 시민 나옴', '조사했는데 {t}는 시민'],
  claimBare: ['진짜 예언자 나임', '나 예언자인데? 저거 가짜'],
  memory: ['{ev}', '{ev} ㅋㅋ'],
  clear: ['{ev}'],
  remarkEmpty: ['ㄱㄱ 한판 더', '다음 판에 봄', '재밌었음'],
};

function casualLine(spec, s, nameOf) {
  const fill = (str) => withName(str, spec.target, nameOf).replaceAll('{ev}', evidenceSentence(spec.evidence || []));
  if (spec.intent === 'remark') return spec.evidence?.length ? fill(pick(CASUAL.memory, s)) : pick(CASUAL.remarkEmpty, s);
  if (spec.intent === 'claim') return fill(pick(!spec.target ? CASUAL.claimBare : spec.result === 'mafia' ? CASUAL.claimMafia : CASUAL.claimTown, s));
  const base = fill(pick(CASUAL[spec.intent] || CASUAL.pass, s));
  if (spec.evidence?.length) return `${base} ${fill(pick(spec.intent === 'defend' ? CASUAL.clear : CASUAL.memory, s))}`;
  return base;
}

const REMARK_EMPTY = {
  yuri: '아직 관찰이 더 필요해요. 다음 판에 봬요.',
  taeo: '아직 간을 다 못 봤어. 다음 판에 보자.',
  gaeun: '다음 화에서 반전 기대할게~',
  doyun: '아직 판단할 근거가 부족합니다. 다음 판에 보죠.',
  hajun: '아직 잘 모르겠네. 다음에 또 보자고.',
  kai: '아직 너 분석 덜 됐다~ 다음 판 기대해!',
  noa: '아직 잘 모르겠어요. 다음 판에 또 봬요.',
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
    if (!e.f) continue;
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
// opts.nameOf maps seat ids to display names; opts.casual selects group-chat tone.
export function templateLine(spec, seed = 0, opts = {}) {
  const nameOf = opts.nameOf ?? displayName;
  const s = seed + hash(spec.speaker + (spec.target || '') + spec.intent);
  if (opts.casual) return casualLine(spec, s, nameOf);
  const v = V[spec.speaker];
  if (!v) return '';
  const fill = (str) => withName(str, spec.target, nameOf).replaceAll('{ev}', evidenceSentence(spec.evidence || []));
  if (spec.t === 'aside') return fill(pick(spec.kind === 'suspect' ? v.asideSuspect : v.asideClear, s));
  if (spec.intent === 'remark') {
    const ev = (spec.evidence || []).slice(0, 2);
    if (!ev.length) return REMARK_EMPTY[spec.speaker];
    return pick(v.memory, s).replaceAll('{ev}', evidenceSentence(ev));
  }
  if (spec.intent === 'claim') return fill(pick(!spec.target ? v.claimBare : spec.result === 'mafia' ? v.claimMafia : v.claimTown, s));
  const base = fill(pick(v[spec.intent] || v.pass, s));
  if (spec.evidence?.length && spec.target === HUMAN_ID) {
    const mem = fill(pick(spec.intent === 'defend' ? v.clear : v.memory, s));
    return `${base} ${mem}`;
  }
  return base;
}

export function humanLine(st) {
  if (st.text) return st.text;
  if (st.intent === 'deny') return '난 아니야.';
  if (st.intent === 'accuse') return withName('{t}, 수상해.', st.target);
  if (st.intent === 'defend') return withName('{t}는 믿어도 될 것 같아.', st.target);
  if (st.intent === 'claim' && !st.target) return '진짜 예언자는 나야.';
  if (st.intent === 'claim') return withName(`내가 예언자야. {t}는 ${st.result === 'mafia' ? '마피아' : '시민'}로 나왔어.`, st.target);
  return '...일단 지켜볼게.';
}
