import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMatch, openRound, submit, close, waitingOn, humanOptions, gameRecord } from '../src/core/engine.js';
import { parseIntent } from '../src/core/intent.js';
import { learnStyle, emptyStyle, styleForPrompt } from '../src/core/style.js';
import { checkLine } from '../src/ai/validate.js';
import { createRng } from '../src/core/rng.js';

function playMatch(nHumans, seed, memory = true, past = {}) {
  const humans = Array.from({ length: nHumans }, (_, i) => ({ id: `h${i + 1}`, n: (past[`h${i + 1}`]?.length || 0) + 1, games: past[`h${i + 1}`] || [] }));
  const g = createMatch({ mode: 'multi', humans, seed, memory });
  const rng = createRng(seed);
  let guard = 0;
  while (g.phase !== 'over' && guard++ < 60) {
    if (g.phase === 'statement') openRound(g);
    for (const h of waitingOn(g)) {
      const o = humanOptions(g, h);
      if (o.type === 'statement') submit(g, h, rng.next() < 0.3 ? { intent: 'skip' } : { intent: 'accuse', target: rng.pick(o.targets), text: 'x' });
      else if (o.type === 'defense') submit(g, h, { intent: 'deny', text: '나 아님' });
      else if (o.type === 'verdict') submit(g, h, { yes: rng.next() < 0.5 });
      else if (o.targets?.length) submit(g, h, { target: rng.pick(o.targets) });
    }
    close(g);
  }
  return g;
}

test('multi: seat counts and mafia count scale with humans', () => {
  for (const [h, seats, mafia] of [[1, 5, 1], [2, 6, 1], [3, 7, 1], [4, 8, 2]]) {
    const g = playMatch(h, 7);
    assert.equal(g.players.length, seats);
    assert.equal(g.players.filter((p) => p.role === 'mafia').length, mafia);
    assert.equal(g.phase, 'over');
  }
});

test('multi: every human gets only their own observations and flips', () => {
  for (let s = 1; s < 30; s++) {
    const g = playMatch(3, s);
    for (const h of g.humanIds) {
      const r = gameRecord(g, h);
      assert.ok(r.flips.every((f) => f.human === h));
      assert.ok(r.obs.every((o) => ['stance_accuse', 'stance_pass', 'round_skip', 'vote_retaliate', 'vote_own_accused', 'victim_accuser', 'deny_when_accused'].includes(o.f)));
    }
  }
});

test('multi: memory off means no evidence for anyone', () => {
  const past = { h1: [{ n: 1, role: 'mafia', obs: [{ f: 'stance_accuse', v: true, day: 1 }] }, { n: 2, role: 'villager', obs: [{ f: 'stance_accuse', v: false, day: 1 }] }] };
  for (let s = 1; s < 30; s++) {
    const g = playMatch(2, s, false, past);
    assert.equal(g.flips.length, 0);
    for (const e of g.events) assert.ok(!e.evidence?.length);
  }
});

test('intent parser reads common chat lines', () => {
  const names = { a: '곰돌이', b: '새벽세시' };
  assert.deepEqual(parseIntent('곰돌이 좀 수상함', names).intent, 'accuse');
  assert.deepEqual(parseIntent('새벽세시는 시민 같은데', names).intent, 'defend');
  assert.deepEqual(parseIntent('곰돌이 마피아 아닌듯', names).intent, 'defend');
  assert.deepEqual(parseIntent('나 아니라고', names).intent, 'deny');
  assert.deepEqual(parseIntent('흠 모르겠다', names).intent, 'pass');
  const c = parseIntent('나 예언자임 곰돌이 마피아 나옴', names);
  assert.equal(c.intent, 'claim');
  assert.equal(c.result, 'mafia');
});

test('style learning keeps no examples with numbers, links or handles', () => {
  const s = learnStyle(emptyStyle(), ['ㅋㅋ 곰돌이 수상', '내 번호 01012345678', 'http://x.com 봐봐', '@someone 어디야', '아 진짜 억울하네요'], { skipped: 1, rounds: 4 });
  assert.equal(s.count, 5);
  assert.deepEqual(s.examples, ['ㅋㅋ 곰돌이 수상', '아 진짜 억울하네요']);
  assert.ok(s.skipRate > 0 && s.skipRate <= 0.6);
  assert.ok(styleForPrompt(s).examples.length === 2);
});

test('validator allows in-game talk but not cross-game memory without evidence', () => {
  const spec = { speaker: 'leon', intent: 'pass', target: null, evidence: [], day: 1 };
  assert.equal(checkLine(spec, { text: '아까 걔가 한 말 기억남', evidence_ids: [] }), null);
  assert.equal(checkLine(spec, { text: '6명 중에 누구지', evidence_ids: [] }, { allowNumbers: [6] }), null);
  assert.equal(checkLine(spec, { text: '지난 판에도 그랬잖아', evidence_ids: [] }), 'memory-without-evidence');
});

test('multi render path: model lines with nicknames pass, cross-game memory falls back to casual template', async () => {
  const { createDialogue } = await import('../src/ai/dialogue.js');
  // Same shape the relay sends in a `render` message.
  const names = { h1: '곰돌이', leon: '새벽세시', mio: '두부' };
  const specs = [
    { speaker: 'leon', intent: 'accuse', target: 'h1', day: 1, evidence: [{ id: 'leon-d1r1-e1-now', f: 'stance_accuse', kind: 'now', text: '이번 판 1일차엔 첫 발언에서 누군가를 의심했다', short: '오늘도 첫 마디부터 의심' }] },
    { speaker: 'mio', intent: 'pass', target: null, day: 1, evidence: [] },
  ];
  const transport = {
    complete: async () => ({
      text: JSON.stringify({
        lines: [
          { speaker_id: 'mio', text: '지난 판에도 이랬잖아', evidence_ids: [] },
          { speaker_id: 'leon', text: '곰돌이 오늘 첫마디부터 몰아가던데', evidence_ids: ['leon-d1r1-e1-now'] },
        ],
      }),
      usage: {},
    }),
  };
  const d = createDialogue({ transport });
  const lines = await d.render('1일차 낮', specs, 'multi', { mode: 'multi', nameOf: (id) => names[id] ?? id, chat: [{ who: '곰돌이', says: '두부 수상함' }], style: null });
  assert.deepEqual(lines.map((l) => l.speaker), ['leon', 'mio']);
  assert.equal(lines[0].source, 'ai');
  assert.equal(lines[1].source, 'template');
  assert.equal(lines[1].reason, 'memory-without-evidence');
  assert.ok(!/입니다|습니다/.test(lines[1].text), 'fallback stays casual in multi');
});

test('self-defense: answering an accusation is recorded as a tell and counts in suspicion', async () => {
  const { createGame, act } = await import('../src/core/engine.js');
  let saw = false;
  for (let s = 1; s < 80 && !saw; s++) {
    const g = createGame({ n: 3, seed: s, forceRole: 'villager' });
    act(g, { intent: 'pass' }); // round 1: rivals speak after this
    if (g.pending?.type === 'statement' && g.pending.accusedBy.length) {
      act(g, { intent: 'deny' });
      const o = g.obs.you.find((x) => x.f === 'deny_when_accused');
      assert.ok(o && o.v === true);
      saw = true;
    }
  }
  assert.ok(saw, 'some seed has the player accused in round 1');
});
