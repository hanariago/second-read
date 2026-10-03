// Prompt construction. The model receives only: character voices, the intent
// code already decided, and pre-written evidence sentences with IDs.

import { charById, displayName } from '../core/characters.js';

export const LINES_SCHEMA = {
  type: 'json_schema',
  name: 'rival_lines',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['lines'],
    properties: {
      lines: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['speaker_id', 'text', 'evidence_ids'],
          properties: {
            speaker_id: { type: 'string' },
            text: { type: 'string' },
            evidence_ids: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
};

export const INSTRUCTIONS = `너는 한국어 마피아 게임의 AI 라이벌 캐릭터들의 대사를 쓴다.
각 화자의 행동(intent)과 대상은 이미 정해져 있다. 너는 그걸 캐릭터 말투로 한두 문장(80자 이내)으로 말하게만 한다.

규칙:
1. lines에는 요청된 화자마다 정확히 한 줄씩, 요청 순서대로 쓴다. speaker_id는 그대로 복사한다.
2. intent가 accuse면 대상을 의심, defend면 대상을 감싸기, pass면 관망, claim이면 예언자라고 밝히고 결과를 말한다. remark면 플레이어에게 한마디 한다. 대상이 있으면 대상 이름을 문장에 넣는다. 플레이어는 "당신"이라고 부른다.
3. evidence가 비어 있으면 과거 판, 습관, 버릇, 기억, 지난번, 매번 같은 말을 절대 하지 않는다. 숫자도 쓰지 않는다.
4. evidence가 있으면 그중 하나 이상을 근거로 말하고, 사용한 id를 evidence_ids에 넣는다. evidence에 없는 사실, 횟수, 판 번호는 지어내지 않는다. 숫자는 evidence에 적힌 그대로만 쓴다.
5. 톤은 "라이벌이 당신의 수를 연구했다"는 경쟁심과 장난기다. 기록, 데이터, 로그, 저장, 감시 같은 단어는 쓰지 않는다.
6. 숨겨진 역할을 암시하거나 밝히지 않는다(claim은 예외).
7. JSON만 출력한다.`;

export function sceneSummary(g) {
  const parts = [`${g.day}일차 낮`];
  for (const d of g.deaths) {
    const how = d.how === 'vote' ? '투표로 처형' : '밤에 살해';
    parts.push(`${displayName(d.id)} ${d.day}일차 ${how}`);
  }
  return parts.join(' / ');
}

export function buildLinesRequest(scene, specs) {
  const speakers = specs.map((s) => {
    const c = charById[s.speaker];
    return {
      speaker_id: s.speaker,
      name: c.name,
      voice: c.personality.voice,
      personality: c.personality.summary,
      intent: s.intent,
      target: s.target ? displayName(s.target) : null,
      claim_result: s.intent === 'claim' ? (s.result === 'mafia' ? '마피아' : '시민') : undefined,
      evidence: (s.evidence || []).map((e) => ({ id: e.id, text: e.text })),
    };
  });
  const payload = { scene, speakers };
  return {
    instructions: INSTRUCTIONS,
    input: [{ role: 'user', content: JSON.stringify(payload) }],
    schema: LINES_SCHEMA,
  };
}
