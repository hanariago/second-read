// End-to-end multiplayer check against a local relay (wrangler dev).
// Fake clients play full games: simultaneous reveal, rival lines from the
// assigned player (or templates on timeout), owner hand-off when a player
// leaves, and per-player records. Run: node test/multi.e2e.mjs

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const TIMERS = { round: 4000, grace: 700, vote: 3000, night: 2000, nightIdle: 150 };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, msg) => {
  if (!ok) failures.push(msg);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
};

function startRelay() {
  const p = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--var', 'ALLOW_TEST_TIMERS:1', '--log-level', 'warn'], {
    cwd: path.join(root, 'server'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  p.stderr.on('data', (d) => process.env.DEBUG && process.stderr.write(d));
  return p;
}

async function waitHealthy() {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await wait(500);
  }
  throw new Error('relay did not start');
}

// behavior: { render: 'ok' | 'silent' | false, skipRate, leaveAfterRounds }
function makeClient(code, name, behavior) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/room/${code}/ws`);
  const c = { name, ws, log: [], submits: {}, reveals: {}, record: null, over: null, seat: null, renderReqs: 0, rounds: 0, closed: false };
  const send = (m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
  c.send = send;
  c.ready = new Promise((res) => ws.addEventListener('open', res));
  ws.addEventListener('message', async (e) => {
    const m = JSON.parse(e.data);
    c.log.push(m);
    if (m.t === 'started') {
      c.seat = m.you;
      c.seats = m.seats;
    } else if (m.t === 'render') {
      c.renderReqs++;
      if (behavior.render === 'ok') {
        await wait(150);
        send({ t: 'lines', reqId: m.reqId, lines: m.specs.map((s) => ({ speaker: s.speaker, text: `ai-${s.speaker} ${s.intent}` })) });
      }
    } else if (m.t === 'round_open') {
      c.rounds++;
      if (behavior.leaveAfterRounds && c.rounds > behavior.leaveAfterRounds) {
        c.closed = true;
        ws.close();
        return;
      }
      if (m.options.type !== 'statement') return;
      await wait(100 + Math.random() * 600);
      const key = `${m.day}-${m.round}`;
      c.submits[key] = Date.now();
      if (Math.random() < (behavior.skipRate ?? 0)) send({ t: 'say', intent: 'skip' });
      else {
        const target = m.options.targets[Math.floor(Math.random() * m.options.targets.length)];
        send({ t: 'say', intent: 'accuse', target, text: `${name} says ${key}` });
      }
    } else if (m.t === 'reveal') {
      c.reveals[`${m.day}-${m.round}`] = { at: Date.now(), messages: m.messages };
    } else if (m.t === 'vote_open') {
      if (m.options.type !== 'vote') return;
      await wait(100 + Math.random() * 300);
      send({ t: 'vote', target: m.options.targets[Math.floor(Math.random() * m.options.targets.length)] });
    } else if (m.t === 'night_open') {
      if (m.options.type !== 'night' || m.options.action === 'sleep') return;
      await wait(100);
      send({ t: 'night', target: m.options.targets[0] });
    } else if (m.t === 'over') {
      c.over = m;
      c.record = m.record;
    }
  });
  return c;
}

async function playRoom(label, behaviors, { games = 1 } = {}) {
  const { code } = await (await fetch(`${BASE}/room`, { method: 'POST' })).json();
  const clients = behaviors.map((b, i) => makeClient(code, `P${i + 1}`, b));
  await Promise.all(clients.map((c) => c.ready));
  clients.forEach((c, i) => c.send({ t: 'hello', name: c.name, canRender: !!behaviors[i].render, n: 1, records: [], memory: true }));
  await wait(400);
  const results = [];
  for (let k = 0; k < games; k++) {
    clients.forEach((c) => {
      c.over = null;
      c.submits = {};
      c.reveals = {};
      c.rounds = 0;
    });
    clients[0].send({ t: 'start', timers: TIMERS });
    const t0 = Date.now();
    while (Date.now() - t0 < 120000 && clients.some((c) => !c.closed && !c.over)) await wait(200);
    results.push(clients.map((c) => ({ ...c })));
    console.log(`  ${label} game ${k + 1}: ${((Date.now() - t0) / 1000).toFixed(1)}s, winner=${clients.find((c) => c.over)?.over?.winner}`);
  }
  clients.forEach((c) => !c.closed && c.ws.close());
  return { clients, results };
}

const relay = startRelay();
try {
  await waitHealthy();

  // 1) Three players, one renders rival lines, two games in the same room.
  {
    const { clients } = await playRoom('3p', [{ render: 'ok', skipRate: 0.2 }, { render: false, skipRate: 0.2 }, { render: false }], { games: 2 });
    const live = clients;
    check(live.every((c) => c.over), '3p: every player received the game result');
    const seats = new Set(live.map((c) => c.record?.n !== undefined && c.seat));
    check(live.every((c) => c.record && c.record.flips.every((f) => f.human === c.seat || f.human === undefined)), '3p: each record only carries that player\'s flips');
    check(live.every((c) => c.record?.n === 2), '3p: game number advances per player across games in a room');
    // Reveal never happens before every human who submitted has submitted.
    let ordered = true;
    for (const c of live) {
      for (const [key, rv] of Object.entries(c.reveals)) {
        for (const o of live) if (o.submits[key] && o.submits[key] > rv.at + 5) ordered = false;
      }
    }
    check(ordered, '3p: rounds are revealed only after all human messages are in');
    const anyReveal = Object.values(live[0].reveals)[0];
    check(!!anyReveal && anyReveal.messages.some((m) => m.text.startsWith('ai-')), '3p: rival lines come from the assigned player');
    check(live[0].renderReqs > 0 && live[1].renderReqs === 0, '3p: only players with a ChatGPT plan get render requests');
    const reveal = live[0].over.reveal;
    check(reveal.filter((r) => r.human).length === 3 && reveal.length === 7, '3p: final reveal shows 3 humans among 7 seats');
    check(live[0].over.humanTexts.length > 0, '3p: human lines are sent back for style learning');
    void seats;
  }

  // 2) Renderer goes silent: templates fill in after the grace period.
  {
    const { clients } = await playRoom('silent', [{ render: 'silent' }, { render: false }]);
    const rv = Object.values(clients[0].reveals)[0];
    check(clients.every((c) => c.over), 'silent: game still finishes');
    check(!!rv && rv.messages.filter((m) => !m.seat.startsWith('h')).length > 0 && rv.messages.every((m) => !m.text.startsWith('ai-')), 'silent: rival lines fall back to templates');
  }

  // 3) A player who owns rivals leaves mid-game: the game continues.
  {
    const { clients } = await playRoom('leave', [{ render: 'ok' }, { render: 'ok', leaveAfterRounds: 1 }, { render: false }]);
    check(clients[0].over && clients[2].over, 'leave: remaining players finish the game');
  }

  // 4) Fifth player is refused.
  {
    const { code } = await (await fetch(`${BASE}/room`, { method: 'POST' })).json();
    const cs = [1, 2, 3, 4, 5].map((i) => makeClient(code, `Q${i}`, {}));
    await Promise.all(cs.map((c) => c.ready));
    for (const c of cs) {
      c.send({ t: 'hello', name: c.name, canRender: false, n: 1, records: [] });
      await wait(80);
    }
    await wait(300);
    check(cs[4].log.some((m) => m.t === 'error' && m.code === 'full'), 'room: a fifth human is refused');
    cs.forEach((c) => c.ws.close());
  }
} catch (e) {
  failures.push(String(e.stack || e));
  console.error(e);
} finally {
  relay.kill('SIGTERM');
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
