// Korean text for public facts (reasons), interrogation answers and rival
// predictions. Kept out of the engine so wording can change without touching
// game logic. `{t}` is the subject, `{x}` the other player; names are filled
// in by the caller (single-mode names or multiplayer nicknames).

export const REASON_TEXT = {
  gut: '딱히 근거는 없고 감',
  accused_me: '{t}가 나를 의심했음',
  defended_me: '{t}가 나를 감싸 줬음',
  deny_unprompted: '{t}는 아무도 안 물었는데 먼저 부인했음',
  deny_answered: '{t}는 의심받자 바로 해명했음',
  defended_mafia: '{t}는 마피아로 밝혀진 {x}를 감쌌음',
  accused_town_executed: '{t}는 시민으로 밝혀진 {x}를 몰아갔음',
  accused_mafia_executed: '{t}는 마피아였던 {x}를 먼저 의심했음',
  voted_town_executed: '{t}는 시민이었던 {x}의 처형에 표를 던졌음',
  voted_mafia_executed: '{t}는 마피아였던 {x}에게 표를 던졌음',
  victim_accused: '밤에 쓰러진 {x}가 {t}를 의심했었음',
  voted_with_mafia: '{t}는 마피아였던 {x}와 같은 사람에게 표를 던졌음',
  broke_promise: '{t}는 {x}를 찍겠다더니 다른 사람에게 투표했음',
  claim_mafia: '예언자를 자처한 {x}가 {t}를 마피아로 지목했음',
  claim_town: '예언자를 자처한 {x}가 {t}를 시민으로 확인했음',
  fake_claimer: '진짜 예언자 {x}가 따로 있었는데 {t}도 예언자라고 했음',
  claim_contradicted: '{t}가 마피아라던 {x}는 시민이었음',
  own_check_mafia: '내가 직접 확인했는데 {t}는 마피아',
  own_check_town: '내가 직접 확인했는데 {t}는 시민',
  i_am_seer: '진짜 예언자는 나라서, 예언자를 자처한 {t}는 거짓말',
};

export function reasonText(r, nameOf) {
  if (!r) return '';
  const tpl = REASON_TEXT[r.kind] || REASON_TEXT.gut;
  return tpl.replaceAll('{t}', r.subject ? nameOf(r.subject) : '').replaceAll('{x}', r.other ? nameOf(r.other) : '');
}

export const QUESTIONS = {
  vote: { label: '누구 찍을 거야?', short: '투표 계획' },
  role: { label: '역할이 뭐야?', short: '역할' },
  why: { label: '왜 그 사람을 의심해?', short: '의심 이유' },
};

// Answers are code-decided; these are the spoken templates (single mode voices).
export const ANSWER_TEXT = {
  vote: '{t}에게 투표할 생각이야.',
  vote_none: '아직 정하지 못했어.',
  role_villager: '나는 시민이야.',
  role_doctor: '사실 나 의사야.',
  role_hide: '시민이라고만 해 둘게.',
  role_seer: '말할게. 나 예언자야. {t}는 {r}로 나왔어.',
  role_seer_bare: '나 예언자야. 아직 결과는 없어.',
  why: '{reason}',
  why_none: '오늘은 아무도 의심 안 했는데?',
};

export const PREDICTION_TEXT = {
  intro: '{rival}의 예측',
  body: '마피아라면 {mafia}, 시민이라면 {town}.',
  hit: '{rival}의 예측이 맞았다. 이번 판 {rival}는 당신을 더 날카롭게 읽는다.',
  broken: '{rival}의 예측을 깼다. 이번 판 {rival}의 기억은 흐려졌다.',
};

// How each predictable habit is phrased as a prediction, by predicted value.
export const PREDICTABLE = {
  stance_accuse: { yes: '첫 마디부터 누군가를 의심할 거예요', no: '첫 마디에선 누구도 의심하지 않을 거예요' },
  stance_pass: { yes: '첫 마디는 관망할 거예요', no: '첫 마디부터 입장을 낼 거예요' },
  vote_first: { yes: '첫 투표를 가장 먼저 할 거예요', no: '다른 사람이 투표한 뒤에야 투표할 거예요' },
};
