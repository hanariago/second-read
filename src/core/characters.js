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
    watches: ['vote_follow', 'vote_own_accused', 'stance_accuse'],
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
  {
    id: 'kai',
    name: '카이',
    title: '수다쟁이 팟캐스터',
    personality: {
      summary: '말이 많고 과장한다. 분위기에 잘 올라탄다.',
      voice: '반말, 과장된 리액션, 유행어 섞음',
      aggression: 0.55,
      temperature: 0.7,
      grudge: 0.35,
      trustSeer: 0.85,
    },
    watches: ['vote_follow', 'round_skip', 'vote_first'],
    watchLabel: '눈치와 침묵',
    color: '#d96b2b',
  },
  {
    id: 'noa',
    name: '노아',
    title: '야간 응급실 간호사',
    personality: {
      summary: '차분하고 공감형. 몰리는 사람 편을 들어준다.',
      voice: '부드러운 존댓말, 걱정하는 말투',
      aggression: 0.85,
      temperature: 0.5,
      grudge: 0.15,
      trustSeer: 0.9,
    },
    watches: ['deny_when_accused', 'victim_accuser', 'stance_pass'],
    watchLabel: '해명과 밤의 흔적',
    color: '#7a6bd1',
  },
  {
    id: 'doyun',
    name: '도윤',
    title: '신입 변호사',
    personality: {
      summary: '논리로 따진다. 말과 행동이 어긋나는 걸 못 참는다.',
      voice: '또박또박한 존댓말, 따지는 말투, "이의 있습니다"',
      aggression: 0.8,
      temperature: 0.4,
      grudge: 0.25,
      trustSeer: 0.75,
    },
    watches: ['vote_own_accused', 'deny_when_accused', 'stance_accuse'],
    watchLabel: '말과 표의 앞뒤',
    color: '#8c2f3a',
  },
  {
    id: 'hajun',
    name: '하준',
    title: '심야 택시 기사',
    personality: {
      summary: '말수가 적고 오래 지켜본다. 밤에 무슨 일이 있었는지 곱씹는다.',
      voice: '툭툭 던지는 반말, 짧은 문장, 사투리 살짝',
      aggression: 0.65,
      temperature: 0.5,
      grudge: 0.4,
      trustSeer: 0.7,
    },
    watches: ['victim_accuser', 'vote_first'],
    watchLabel: '밤의 흔적과 타이밍',
    color: '#5f6b3a',
  },
  {
    id: 'yuri',
    name: '유리',
    title: '심리학 대학원생',
    personality: {
      summary: '조용히 관찰하고 분석한다. 사람들이 왜 그렇게 말하는지에 관심이 많다.',
      voice: '차분한 존댓말, 분석적, "흥미롭네요"',
      aggression: 0.85,
      temperature: 0.45,
      grudge: 0.2,
      trustSeer: 0.8,
    },
    watches: ['stance_pass', 'vote_follow'],
    watchLabel: '관망과 쏠림',
    color: '#3f8a8a',
  },
  {
    id: 'taeo',
    name: '태오',
    title: '중식당 헤드 셰프',
    personality: {
      summary: '화끈하고 직설적이다. 한 번 찍으면 밀어붙이고, 건드리면 받아친다.',
      voice: '거친 반말, 직설적, 요리 비유',
      aggression: 0.5,
      temperature: 0.6,
      grudge: 0.7,
      trustSeer: 0.6,
    },
    watches: ['vote_retaliate', 'stance_accuse'],
    watchLabel: '맞불과 첫 공격',
    color: '#b23a2e',
  },
  {
    id: 'gaeun',
    name: '가은',
    title: '웹툰 작가',
    personality: {
      summary: '엉뚱하고 상상력이 넘친다. 남들이 놓친 이야기의 빈틈을 찾는다.',
      voice: '밝은 반말, 비유와 상상, "이거 반전 각인데?"',
      aggression: 0.6,
      temperature: 0.75,
      grudge: 0.3,
      trustSeer: 0.75,
    },
    watches: ['round_skip', 'deny_when_accused'],
    watchLabel: '침묵과 변명',
    color: '#4a7fc1',
  },
];

export const charById = Object.fromEntries(CHARACTERS.map((c) => [c.id, c]));

export function displayName(id) {
  return id === HUMAN_ID ? '당신' : charById[id]?.name ?? id;
}
