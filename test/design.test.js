// Rules that make a game deducible and the rival duel fair.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, act } from '../src/core/engine.js';
import { createRng } from '../src/core/rng.js';
import { HUMAN_ID } from '../src/core/characters.js';

function play(seed, { role = 'villager', ask = null, pastGames = [], n = 1 } = {}) {
  const rng = createRng(seed ^ 0x77);
  const g = createGame({ n, seed, forceRole: role, pastGames });
  let guard = 0;
  while (g.pending && guard++ < 300) {
    const p = g.pending;
    if (p.type === 'statement' && ask && p.canAsk && p.askable.length) act(g, { type: 'ask', target: rng.pick(p.askable), q: ask });
    else if (p.type === 'spectate') act(g, { type: 'continue' });
    else if (p.type === 'statement') act(g, { intent: 'pass' });
    else if (p.type === 'vote') act(g, { type: 'vote', target: rng.pick(p.targets) });
    else if (p.type === 'defense') act(g, { intent: 'deny' });
    else if (p.type === 'verdict') act(g, { yes: rng.next() < 0.5 });
    else act(g, p.action === 'sleep' ? {} : { target: rng.pick(p.targets) });
  }
  return g;
}

test('mafia rivals never vote for or accuse a teammate', () => {
  for (let s = 1; s < 150; s++) {
    const g = play(s * 31);
    const mafia = g.players.filter((p) => p.role === 'mafia').map((p) => p.id);
    for (const vs of Object.values(g.votes)) for (const v of vs) if (mafia.includes(v.voter) && v.voter !== HUMAN_ID) assert.ok(!mafia.includes(v.target), `seed ${s}`);
    for (const st of Object.values(g.statements).flat()) if (mafia.includes(st.speaker) && st.intent === 'accuse') assert.ok(!mafia.includes(st.target) || st.target === st.speaker);
  }
});

test('town rivals keep vote promises; only mafia breaks them', () => {
  let broken = 0;
  for (let s = 1; s < 300; s++) {
    const g = play(s * 17, { ask: 'vote' });
    for (const b of g.brokenPromises) {
      assert.equal(g.players.find((p) => p.id === b.who).role, 'mafia', `seed ${s}`);
      broken++;
    }
  }
  assert.ok(broken > 10, `broken promises seen: ${broken}`);
});

test('every rival accusation names a reason (a fact or an honest hunch)', () => {
  for (let s = 1; s < 80; s++) {
    const g = play(s * 13);
    for (const st of Object.values(g.statements).flat()) {
      if (st.speaker === HUMAN_ID || st.intent !== 'accuse' || st.final) continue;
      assert.ok(st.reason && st.reason.kind, `missing reason seed ${s}`);
    }
  }
});

test('fake seer claims come only from mafia; the real seer can contest', () => {
  let fakes = 0;
  for (let s = 1; s < 300; s++) {
    const g = play(s * 7);
    for (const st of Object.values(g.statements).flat()) {
      if (st.fake) {
        assert.equal(g.players.find((p) => p.id === st.speaker).role, 'mafia');
        fakes++;
      }
    }
  }
  assert.ok(fakes > 10, `fake claims seen: ${fakes}`);
});

test('prediction: made only with a role-dependent read, resolved on day 1, changes that rival', () => {
  // Past: as mafia always accused first; as town never did.
  const past = [
    { n: 1, role: 'villager', obs: [{ f: 'stance_accuse', v: false, day: 1 }, { f: 'stance_accuse', v: false, day: 2 }] },
    { n: 2, role: 'mafia', obs: [{ f: 'stance_accuse', v: true, day: 1 }, { f: 'stance_accuse', v: true, day: 2 }] },
  ];
  assert.equal(createGame({ n: 1, seed: 1 }).prediction, null);
  const g = createGame({ n: 3, seed: 5, pastGames: past, forceRole: 'villager' });
  assert.ok(g.prediction && g.prediction.f === 'stance_accuse');
  assert.equal(g.prediction.expect.town, false);
  act(g, { intent: 'accuse', target: g.pending.targets[0] }); // breaks the town prediction
  assert.equal(g.prediction.status, 'broken');
  assert.equal(g.predMult[g.prediction.rival], 0);
});

test('a seer may claim without a result ("I am the real seer")', () => {
  const g = createGame({ n: 1, seed: 3, forceRole: 'seer' });
  act(g, { intent: 'claim' });
  const st = g.statements[1].find((s) => s.speaker === HUMAN_ID);
  assert.equal(st.intent, 'claim');
  assert.equal(st.target, null);
});
