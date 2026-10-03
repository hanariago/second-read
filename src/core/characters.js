// AI rivals. Personality (how they talk and how boldly they act) is kept
// separate from the kind of tell they notice (which recorded habits they track).

export const HUMAN_ID = 'you';

export const CHARACTERS = [
  {
    id: 'leon',
    name: '레온',
    title: '계산하는 회계사',
    personality: {
      summary: '침착하고 숫자로 말한다. 확신이 서야 움직인다.',
      voice: '존댓말, 짧고 건조함, 수치나 횟수를 즐겨 언급',
      aggression: 0.9, // suspicion needed before accusing out loud
      temperature: 0.45, // randomness of votes (lower = steadier)
      grudge: 0.2, // how much being accused by someone raises suspicion of them
      trustSeer: 0.9,
    },
    watches: ['vote_first', 'round_skip'],
    watchLabel: '타이밍과 침묵',
    color: '#5b8def',
  },
  {
    id: 'mio',
    name: '미오',
    title: '직감파 바리스타',
    personality: {
      summary: '말이 많고 감으로 찍는다. 자주 틀리지만 빨리 움직인다.',
      voice: '반말 섞인 친근한 말투, 감탄사, 짧은 문장',
      aggression: 0.45,
      temperature: 0.8,
      grudge: 0.5,
      trustSeer: 0.7,
    },
    watches: ['stance_accuse', 'stance_pass'],
    watchLabel: '첫 마디의 성향',
    color: '#e36fa4',
  },
  {
    id: 'bruno',
    name: '브루노',
    title: '은퇴한 형사',
    personality: {
      summary: '고집이 세고 대세를 의심한다. 한 번 찍으면 잘 안 바꾼다.',
      voice: '무뚝뚝한 반말, 형사 말투, "흠", "내 경험상"',
      aggression: 0.7,
      temperature: 0.35,
      grudge: 0.3,
      trustSeer: 0.6,
    },
    watches: ['vote_follow', 'vote_own_accused'],
    watchLabel: '대세 편승과 말·표 일치',
    color: '#c7903a',
  },
  {
    id: 'sera',
    name: '세라',
    title: '기억력 좋은 체스 기사',
    personality: {
      summary: '차분하지만 뒤끝이 있다. 누가 누구를 노렸는지 기억한다.',
      voice: '정중하지만 날이 선 존댓말, 체스 비유를 가끔 씀',
      aggression: 0.75,
      temperature: 0.5,
      grudge: 0.6,
      trustSeer: 0.8,
    },
    watches: ['vote_retaliate', 'victim_accuser', 'deny_when_accused'],
    watchLabel: '반격과 해명',
    color: '#4fb39a',
  },
];

export const charById = Object.fromEntries(CHARACTERS.map((c) => [c.id, c]));

export function displayName(id) {
  return id === HUMAN_ID ? '당신' : charById[id]?.name ?? id;
}
