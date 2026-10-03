// One multiplayer room. Runs the shared engine, collects each phase from the
// humans, asks players' apps to write their assigned rivals' lines (each on
// their own ChatGPT plan), and reveals every discussion round at once.

import { DurableObject } from 'cloudflare:workers';
import { createMatch, openRound, submit, close, waitingOn, humanOptions, gameRecord, setLineText } from '../../src/core/engine.js';
import { CHARACTERS } from '../../src/core/characters.js';
import { templateLine, humanLine } from '../../src/ai/templates.js';
import { sceneSummary, todayChat } from '../../src/ai/prompts.js';

const NICKS = ['고등어', '새벽세시', '감자칩', '민트초코', '레몬즙', '곰돌이', '택배왔어요', '슬리퍼', '구름빵', '호박죽', '두부', '라면왕', '달팽이', '소금빵', '오리발', '펭귄', '귤껍질', '양말한짝'];
const DEFAULT_TIMERS = { round: 75000, grace: 8000, vote: 30000, night: 25000, nightIdle: 1500 };
const MAX_HUMANS = 4;
const MAX_MSG = 64 * 1024;

const shuffle = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const clean = (s, max = 120) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.clients = new Map(); // pid -> { ws, name, canRender, n, records, memory, seat, joined }
    this.host = null;
    this.g = null;
    this.timer = null;
    this.T = DEFAULT_TIMERS;
  }

  async fetch() {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const pid = crypto.randomUUID();
    this.clients.set(pid, { ws: server, joined: false });
    server.addEventListener('message', (e) => {
      if (typeof e.data !== 'string' || e.data.length > MAX_MSG) return;
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      try {
        this.onMessage(pid, msg);
      } catch (err) {
        this.send(pid, { t: 'error', code: 'bad_request', message: String(err.message || err) });
      }
    });
    const gone = () => this.onLeave(pid);
    server.addEventListener('close', gone);
    server.addEventListener('error', gone);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------- transport ----------

  send(pid, msg) {
    const c = this.clients.get(pid);
    if (!c) return;
    try {
      c.ws.send(JSON.stringify(msg));
    } catch {
      /* socket closing */
    }
  }
  broadcast(msg) {
    for (const [pid, c] of this.clients) if (c.joined) this.send(pid, msg);
  }
  pidOfSeat(seat) {
    for (const [pid, c] of this.clients) if (c.seat === seat) return pid;
    return null;
  }
  setTimer(ms, fn) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      fn();
    }, ms);
  }

  lobbyState() {
    const players = [...this.clients.entries()].filter(([, c]) => c.joined).map(([pid, c]) => ({ name: c.name, host: pid === this.host, canRender: c.canRender }));
    return { t: 'lobby', players, inGame: !!this.g && this.g.phase !== 'over' };
  }

  // ---------- messages ----------

  onMessage(pid, msg) {
    const c = this.clients.get(pid);
    if (!c) return;
    if (msg.t === 'hello') {
      if (this.g && this.g.phase !== 'over') return this.send(pid, { t: 'error', code: 'in_progress' });
      const joined = [...this.clients.values()].filter((x) => x.joined).length;
      if (!c.joined && joined >= MAX_HUMANS) return this.send(pid, { t: 'error', code: 'full' });
      Object.assign(c, {
        joined: true,
        name: clean(msg.name, 20) || '플레이어',
        canRender: !!msg.canRender,
        n: Math.max(1, +msg.n || 1),
        // The player's own past records, used for this game only and never stored.
        records: Array.isArray(msg.records) ? msg.records.slice(-40) : [],
        memory: msg.memory !== false,
        skipRate: Number.isFinite(msg.skipRate) ? msg.skipRate : null,
      });
      if (!this.host || !this.clients.get(this.host)?.joined) this.host = pid;
      this.send(pid, { t: 'welcome', host: pid === this.host });
      this.broadcast(this.lobbyState());
      return;
    }
    if (!c.joined) return;
    if (msg.t === 'render_status') {
      c.canRender = !!msg.canRender;
      return;
    }
    if (msg.t === 'start') return this.startGame(pid, msg);
    if (!this.g || this.g.phase === 'over' || !c.seat) return;
    if (msg.t === 'say' && this.g.phase === 'statement') {
      submit(this.g, c.seat, { intent: msg.intent, target: msg.target, result: msg.result, text: clean(msg.text, 80) || null });
      this.send(pid, { t: 'ack', phase: 'statement' });
      this.progress();
    } else if (msg.t === 'vote' && this.g.phase === 'vote') {
      submit(this.g, c.seat, { target: msg.target });
      this.send(pid, { t: 'ack', phase: 'vote' });
      this.progress();
    } else if (msg.t === 'night' && this.g.phase === 'night') {
      submit(this.g, c.seat, { target: msg.target });
      this.send(pid, { t: 'ack', phase: 'night' });
      this.progress();
    } else if (msg.t === 'lines') {
      this.receiveLines(pid, msg);
    }
  }

  onLeave(pid) {
    const c = this.clients.get(pid);
    this.clients.delete(pid);
    if (!c) return;
    if (this.host === pid) this.host = [...this.clients.entries()].find(([, x]) => x.joined)?.[0] ?? null;
    if (this.g && this.g.phase !== 'over') {
      // Hand that player's rivals to someone else; pending lines fall back to templates.
      for (const [ai, owner] of Object.entries(this.owners)) if (owner === pid) this.owners[ai] = this.pickOwner();
      this.progress();
    }
    if (![...this.clients.values()].some((x) => x.joined)) {
      clearTimeout(this.timer);
      this.g = null;
    } else this.broadcast(this.lobbyState());
  }

  pickOwner() {
    const renderers = [...this.clients.entries()].filter(([, c]) => c.joined && c.canRender).map(([pid]) => pid);
    return renderers.length ? renderers[Math.floor(Math.random() * renderers.length)] : null;
  }

  // ---------- game ----------

  startGame(pid, msg) {
    if (pid !== this.host) return this.send(pid, { t: 'error', code: 'not_host' });
    if (this.g && this.g.phase !== 'over') return;
    if (msg.timers && this.env.ALLOW_TEST_TIMERS === '1') this.T = { ...DEFAULT_TIMERS, ...msg.timers };
    const players = [...this.clients.entries()].filter(([, c]) => c.joined).slice(0, MAX_HUMANS);
    if (!players.length) return;
    const humans = players.map(([p, c], i) => {
      c.seat = `h${i + 1}`;
      return { id: c.seat, n: c.n, games: c.memory ? c.records : [] };
    });
    // Rivals skip rounds about as often as people in these rooms do.
    const rates = players.map(([, c]) => c.skipRate).filter((x) => x !== null);
    const aiSkipRate = rates.length ? Math.min(0.5, Math.max(0.05, rates.reduce((a, b) => a + b, 0) / rates.length)) : 0.2;
    this.g = createMatch({ mode: 'multi', humans, seed: (Math.random() * 2 ** 31) | 0, aiSkipRate });
    const ids = this.g.players.map((p) => p.id);
    const nicks = shuffle(NICKS).slice(0, ids.length);
    this.nick = Object.fromEntries(ids.map((id, i) => [id, nicks[i]]));
    this.nameOf = (id) => this.nick[id] ?? id;
    // Split rivals among players who can write lines with their own ChatGPT plan.
    const renderers = shuffle(players.filter(([, c]) => c.canRender).map(([p]) => p));
    this.owners = {};
    CHARACTERS.forEach((ch, i) => (this.owners[ch.id] = renderers.length ? renderers[i % renderers.length] : null));
    this.humanTexts = [];
    const seats = shuffle(ids).map((id) => ({ id, nick: this.nick[id] }));
    for (const [p, c] of players) {
      const me = this.g.players.find((x) => x.id === c.seat);
      this.send(p, { t: 'started', you: c.seat, role: me.role, seats, rounds: this.g.rounds, timers: this.T });
    }
    this.openStatement();
  }

  phaseOptions(seat) {
    return humanOptions(this.g, seat);
  }

  openStatement() {
    const g = this.g;
    const plan = openRound(g);
    this.round = { day: g.day, round: g.round, lines: {}, waiting: new Set(), humansDoneAt: null, closed: false };
    const nameOf = this.nameOf;
    const scene = sceneSummary(g, nameOf);
    const chat = todayChat(g, nameOf);
    const byOwner = new Map();
    for (const s of plan) {
      if (s.intent === 'skip') continue;
      // In a mixed room, rivals only cite what everyone saw in this game;
      // memory still steers their votes and shows up in the end-of-game report.
      const spec = { speaker: s.speaker, intent: s.intent, target: s.target, result: s.result, day: s.day, evidence: (s.evidence || []).filter((e) => e.kind === 'now') };
      const owner = this.owners[s.speaker];
      if (owner && this.clients.has(owner)) {
        if (!byOwner.has(owner)) byOwner.set(owner, []);
        byOwner.get(owner).push(spec);
        this.round.waiting.add(s.speaker);
      } else {
        this.round.lines[s.speaker] = this.freshTemplate(spec);
      }
      this.round.specs = { ...(this.round.specs || {}), [s.speaker]: spec };
    }
    const names = Object.fromEntries(g.players.map((p) => [p.id, nameOf(p.id)]));
    for (const [owner, specs] of byOwner) {
      this.send(owner, { t: 'render', reqId: `${g.day}-${g.round}`, scene, chat, specs, names });
    }
    const deadline = Date.now() + this.T.round;
    for (const [p, c] of this.clients) {
      if (!c.joined || !c.seat) continue;
      this.send(p, { t: 'round_open', day: g.day, round: g.round, rounds: g.rounds, deadline, options: this.phaseOptions(c.seat) });
    }
    this.setTimer(this.T.round, () => this.finishRound());
  }

  // Identical fallback lines in one room would give the rivals away.
  freshTemplate(spec) {
    const used = new Set([...Object.values(this.round?.lines || {}), ...(this.usedLines || [])]);
    let text = '';
    for (let i = 0; i < 12; i++) {
      text = templateLine(spec, Math.floor(Math.random() * 1000), { nameOf: this.nameOf, casual: true });
      if (!used.has(text)) break;
    }
    this.usedLines = [...(this.usedLines || []), text].slice(-12);
    return text;
  }

  receiveLines(pid, msg) {
    const r = this.round;
    if (!r || r.closed || msg.reqId !== `${r.day}-${r.round}`) return;
    for (const l of Array.isArray(msg.lines) ? msg.lines : []) {
      if (this.owners[l.speaker] !== pid || !r.waiting.has(l.speaker)) continue;
      const text = clean(l.text);
      if (text) r.lines[l.speaker] = text;
      r.waiting.delete(l.speaker);
    }
    this.progress();
  }

  // Moves the current phase on once everyone needed has acted.
  progress() {
    const g = this.g;
    if (!g || g.phase === 'over') return;
    const humansLeft = waitingOn(g).filter((seat) => this.pidOfSeat(seat));
    if (g.phase === 'statement') {
      const r = this.round;
      if (!r || r.closed) return;
      for (const ai of [...r.waiting]) if (!this.clients.has(this.owners[ai])) r.waiting.delete(ai);
      if (humansLeft.length) return;
      if (!r.waiting.size) return this.finishRound();
      // Humans are done; give rival lines a short grace, then fall back to templates.
      if (!r.humansDoneAt) {
        r.humansDoneAt = Date.now();
        this.setTimer(this.T.grace, () => this.finishRound());
      }
    } else if (g.phase === 'vote') {
      if (!humansLeft.length) this.finishVote();
    } else if (g.phase === 'night') {
      if (!humansLeft.length) this.setTimer(this.T.nightIdle, () => this.finishNight());
    }
  }

  finishRound() {
    const g = this.g;
    const r = this.round;
    if (!g || !r || r.closed || g.phase !== 'statement') return;
    r.closed = true;
    clearTimeout(this.timer);
    for (const ai of Object.keys(r.specs || {})) {
      if (!r.lines[ai]) r.lines[ai] = this.freshTemplate(r.specs[ai]);
    }
    const events = close(g);
    const messages = [];
    for (const ev of events) {
      if (ev.t !== 'statement' || ev.intent === 'skip') continue;
      const human = ev.speaker.startsWith('h');
      const text = human ? ev.text || humanLine(ev) : r.lines[ev.speaker];
      if (!text) continue;
      setLineText(g, ev, text);
      if (human) this.humanTexts.push(text);
      messages.push({ seat: ev.speaker, text });
    }
    this.broadcast({ t: 'reveal', day: r.day, round: r.round, messages });
    if (g.phase === 'statement') this.openStatement();
    else this.openVote();
  }

  openVote() {
    const deadline = Date.now() + this.T.vote;
    for (const [p, c] of this.clients) {
      if (!c.joined || !c.seat) continue;
      this.send(p, { t: 'vote_open', day: this.g.day, deadline, options: this.phaseOptions(c.seat) });
    }
    this.setTimer(this.T.vote, () => this.finishVote());
  }

  finishVote() {
    const g = this.g;
    if (!g || g.phase !== 'vote') return;
    clearTimeout(this.timer);
    const events = close(g);
    const votes = events.filter((e) => e.t === 'vote').map((e) => ({ voter: e.voter, target: e.target }));
    const ex = events.find((e) => e.t === 'execute');
    this.broadcast({ t: 'vote_result', day: ex?.day, votes, executed: ex ? { seat: ex.target, role: ex.role, tie: ex.tie } : null });
    if (g.phase === 'over') return this.finishGame();
    this.openNight();
  }

  openNight() {
    const deadline = Date.now() + this.T.night;
    for (const [p, c] of this.clients) {
      if (!c.joined || !c.seat) continue;
      this.send(p, { t: 'night_open', day: this.g.day, deadline, options: this.phaseOptions(c.seat) });
    }
    this.setTimer(this.T.night, () => this.finishNight());
    this.progress();
  }

  finishNight() {
    const g = this.g;
    if (!g || g.phase !== 'night') return;
    clearTimeout(this.timer);
    const events = close(g);
    for (const ev of events) {
      if (ev.t === 'seerResult') this.send(this.pidOfSeat(ev.seer), { t: 'seer_result', target: ev.target, result: ev.result });
    }
    const night = events.find((e) => e.t === 'night');
    this.broadcast({ t: 'night_result', day: night?.day, victim: night ? { seat: night.victim, role: night.role } : null });
    if (g.phase === 'over') return this.finishGame();
    this.openStatement();
  }

  finishGame() {
    const g = this.g;
    clearTimeout(this.timer);
    const reveal = g.players.map((p) => {
      const pid = this.pidOfSeat(p.id);
      return { seat: p.id, nick: this.nick[p.id], role: p.role, human: p.human, name: p.human ? this.clients.get(pid)?.name ?? '(나감)' : null };
    });
    const texts = this.humanTexts.slice();
    for (const [pid, c] of this.clients) {
      if (!c.joined || !c.seat) continue;
      // Each player receives only their own record, to store on their own device.
      const record = { ...gameRecord(g, c.seat), memory: c.memory };
      this.send(pid, { t: 'over', winner: g.winner, reveal, record, humanTexts: texts });
      c.seat = null;
      c.n += 1;
      c.records = [...c.records, record].slice(-40);
    }
    this.broadcast(this.lobbyState());
  }
}
