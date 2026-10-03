import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, act, gameRecord } from '../src/core/engine.js';
import { createRng } from '../src/core/rng.js';
import { buildTellModel, logLR } from '../src/core/tells.js';
import { HUMAN_ID } from '../src/core/characters.js';
import { checkLine } from '../src/ai/validate.js';
import { createDialogue } from '../src/ai/dialogue.js';
import { addGame, emptyProfile, rivalReport, remarkSpecs } from '../src/core/profile.js';

// Plays one game with a habit: votes first and accuses only as mafia.
function play(n, past, memory, seed) {
  const rng = createRng(seed);
  const g = createGame({ n, pastGames: past, memory, seed });
  const mafia = g.humanRole === 'mafia';
  let guard = 0;
  while (g.pending && guard++ < 100) {
    const p = g.pending;
    if (p.type === 'spectate') act(g, { type: 'continue' });
    else if (p.type === 'statement') act(g, mafia ? { intent: 'accuse', target: rng.pick(p.targets) } : { intent: 'pass' });
    else if (p.type === 'vote') {
      if (!mafia && p.canWait && p.votes.length < 2) act(g, { type: 'wait' });
      else act(g, { type: 'vote', target: rng.pick(p.targets) });
    } else if (p.type === 'night') act(g, p.action === 'sleep' ? {} : { target: rng.pick(p.targets) });
  }
  return g;
}

function playMany(count, memory, seed = 1) {
  const past = [];
  const games = [];
  for (let n = 1; n <= count; n++) {
    const g = play(n, past, memory, seed * 100 + n);
    past.push(gameRecord(g));
    games.push(g);
  }
  return { past, games };
}

test('every game ends within two days', () => {
  for (let s = 1; s < 60; s++) {
    const { games } = playMany(3, true, s);
    for (const g of games) {
      assert.equal(g.phase, 'over');
      assert.ok(g.day <= 2);
    }
  }
});

test('first games alternate roles so both are observed by game 3', () => {
  const { past } = playMany(3, true, 7);
  assert.deepEqual(past.map((g) => g.side), ['town', 'mafia', 'town']);
});

test('memory off: no evidence is ever produced and no vote flips', () => {
  for (let s = 1; s < 40; s++) {
    const { games } = playMany(6, false, s);
    for (const g of games) {
      assert.equal(g.flips.length, 0);
      for (const e of g.events) if (e.evidence) assert.equal(e.evidence.length, 0);
    }
  }
});

test('evidence counts match the stored records exactly', () => {
  for (let s = 1; s < 40; s++) {
    const { past, games } = playMany(6, true, s);
    for (const g of games) {
      const model = buildTellModel(past.filter((r) => r.n < g.n), g.n);
      for (const e of g.events) {
        for (const ev of e.evidence || []) {
          if (ev.kind === 'now') continue;
          const side = model[ev.f][ev.kind];
          assert.ok(ev.text.includes(`${side.rawK}/${side.rawN}회`), ev.text);
          for (const gm of side.games) assert.ok(ev.text.includes(`${gm.n}판`));
        }
      }
    }
  }
});

test('a consistent habit becomes a cited tell by game 4', () => {
  let cited = 0;
  for (let s = 1; s <= 30; s++) {
    const { games } = playMany(4, true, s);
    const g4 = games[3];
    if (g4.events.some((e) => e.evidence?.length && e.target === HUMAN_ID)) cited++;
  }
  assert.ok(cited >= 24, `cited in ${cited}/30`);
});

test('tells are probabilistic: one observation per role gives a bounded ratio', () => {
  const games = [
    { n: 1, role: 'villager', obs: [{ f: 'vote_first', v: false, day: 1 }] },
    { n: 2, role: 'mafia', obs: [{ f: 'vote_first', v: true, day: 1 }] },
  ];
  const m = buildTellModel(games, 3);
  const llr = logLR(m, 'vote_first', true);
  assert.ok(llr > 0 && llr < 1.5);
});

test('validator rejects invented memories and numbers', () => {
  const spec = { speaker: 'leon', intent: 'accuse', target: 'mio', evidence: [], day: 1 };
  assert.equal(checkLine(spec, { text: '미오 씨, 지난 판에도 그랬죠.', evidence_ids: [] }), 'memory-without-evidence');
  assert.equal(checkLine(spec, { text: '미오 씨가 3번이나 그랬어요.', evidence_ids: [] }), 'number-without-evidence');
  assert.equal(checkLine(spec, { text: '레온은 수상해요.', evidence_ids: [] }), 'target-missing');
  assert.equal(checkLine(spec, { text: '미오 씨, 의심스럽네요.', evidence_ids: [] }), null);
  const withEv = {
    speaker: 'leon',
    intent: 'accuse',
    target: HUMAN_ID,
    day: 1,
    evidence: [{ id: 'x-mafia', kind: 'mafia', text: "마피아였던 2판에서 '가장 먼저 투표' 1/1회" }],
  };
  assert.equal(checkLine(withEv, { text: '당신, 2판에서 먼저 투표했죠.', evidence_ids: ['x-mafia'] }), null);
  assert.equal(checkLine(withEv, { text: '당신, 5판에서 먼저 투표했죠.', evidence_ids: ['x-mafia'] }), 'invented-number');
  assert.equal(checkLine(withEv, { text: '당신, 수상해요.', evidence_ids: [] }), 'evidence-not-cited');
  assert.equal(checkLine(withEv, { text: '당신, 수상해요.', evidence_ids: ['fake'] }), 'unknown-evidence');
});

test('dialogue falls back to grounded templates when the model invents', async () => {
  const transport = {
    complete: async () => ({ text: JSON.stringify({ lines: [{ speaker_id: 'mio', text: '레온, 넌 매번 그래!', evidence_ids: [] }] }), usage: {} }),
  };
  const d = createDialogue({ transport });
  const [line] = await d.render('scene', [{ speaker: 'mio', intent: 'accuse', target: 'leon', evidence: [], day: 1 }]);
  assert.equal(line.source, 'template');
  assert.equal(line.reason, 'memory-without-evidence');
  assert.ok(line.text.includes('레온'));
});

test('dialogue times out to templates without blocking', async () => {
  const transport = { complete: ({ signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' })))) };
  const d = createDialogue({ transport, timeoutMs: 50 });
  const t0 = Date.now();
  const [line] = await d.render('scene', [{ speaker: 'sera', intent: 'pass', target: null, evidence: [], day: 1 }]);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(line.source, 'template');
});

test('report remarks only carry evidence that matches the profile', () => {
  let profile = emptyProfile();
  const { past } = playMany(4, true, 3);
  for (const r of past) profile = addGame(profile, r);
  const report = rivalReport(profile, past[3]);
  const specs = remarkSpecs(report);
  assert.equal(specs.length, 4);
  for (const sp of specs) for (const e of sp.evidence) assert.ok(e.text.length > 0);
});
