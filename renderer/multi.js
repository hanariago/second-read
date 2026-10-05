// Multiplayer mode: up to 4 people + 4 rivals, everyone under a random nickname.
// Each discussion round is written privately and revealed at once, so typing
// speed can't separate people from rivals. Rival lines assigned to this player
// are written here with their own ChatGPT plan.

import { parseIntent } from '../src/core/intent.js';
import { learnStyle, styleForPrompt, emptyStyle } from '../src/core/style.js';
import { nextGameNumber, addGame, rivalReport } from '../src/core/profile.js';
import { ROLE_KO } from '../src/core/engine.js';

const DEFAULT_RELAY = 'http://127.0.0.1:8787';
const INTENT_KO = { accuse: '의심', defend: '감싸기', pass: '관망', deny: '부인', claim: '예언 공개', skip: '말 안 함' };
const COLORS = ['#5b8def', '#e36fa4', '#c7903a', '#4fb39a', '#9b7be0', '#d0505a', '#6fb3d9', '#b9b34f'];

export function setupMulti(ctx) {
  const { S, store, $, esc, showModal, closeModal, renderTitle, renderLines, updateBadges, bridge, showReport, seatStanceHtml } = ctx;
  const M = { ws: null, code: null, players: [], host: false, msg: '' };
  let tick = null;

  const relayUrl = () => (S.profile.settings.relayUrl || DEFAULT_RELAY).replace(/\/+$/, '');
  const wsUrl = (code) => `${relayUrl().replace(/^http/, 'ws')}/room/${code}/ws`;
  const nameOf = (id) => M.nick?.[id] ?? id;
  const send = (m) => M.ws?.readyState === 1 && M.ws.send(JSON.stringify(m));

  // ---------- lobby ----------

  function renderLobby(msg = M.msg) {
    M.msg = msg;
    S.game = null;
    updateBadges();
    const inRoom = !!M.code && M.ws;
    $('#screen').innerHTML = `
    <section class="title lobby">
      <h1>친구와 하기</h1>
      <p class="tagline">사람 최대 6명 + AI 4명 이상. 모두 무작위 닉네임으로 섞입니다.<br/>매 라운드 각자 쓰고, 다 같이 공개. 누가 사람인지 맞혀보세요.</p>
      ${msg ? `<p class="warn">${esc(msg)}</p>` : ''}
      ${
        inRoom
          ? `<div class="room-code">방 코드 <b>${esc(M.code)}</b></div>
             <ul class="players">${M.players.map((p) => `<li>${esc(p.name)}${p.host ? ' <span class="tag">방장</span>' : ''}${p.canRender ? '' : ' <span class="muted small">(AI 대사 없음)</span>'}</li>`).join('')}</ul>
             ${M.host ? `<button class="primary big" data-act="mStart">시작 (${M.players.length}명 + AI 4명)</button>` : '<p class="hint">방장이 시작하면 바로 들어갑니다.</p>'}
             <button class="link" data-act="mLeave">방 나가기</button>`
          : `<div class="lobby-form">
               <label>내 이름 <input id="mName" maxlength="20" value="${esc(S.profile.settings.playerName || '')}" placeholder="친구들에게 보일 이름" /></label>
               <div class="row"><button class="primary" data-act="mCreate">방 만들기</button></div>
               <div class="row"><input id="mCode" maxlength="5" placeholder="방 코드" class="code-input" /><button class="ghost" data-act="mJoin">참가</button></div>
               <details class="small"><summary class="muted">서버 주소</summary><input id="mRelay" value="${esc(relayUrl())}" /></details>
             </div>
             <button class="link" data-act="title">돌아가기</button>`
      }
      ${S.aiOn ? '' : '<p class="hint">ChatGPT로 로그인하지 않으면 내 몫의 AI 대사는 다른 참가자나 미리 쓴 대사가 맡습니다.</p>'}
    </section>`;
  }

  async function saveLobbyFields() {
    const name = $('#mName')?.value.trim();
    const relay = $('#mRelay')?.value.trim();
    S.profile = { ...S.profile, settings: { ...S.profile.settings, playerName: name || S.profile.settings.playerName, relayUrl: relay || S.profile.settings.relayUrl } };
    await store.save(S.profile);
  }

  async function createRoom() {
    await saveLobbyFields();
    try {
      const r = await fetch(`${relayUrl()}/room`, { method: 'POST' });
      const { code } = await r.json();
      connect(code);
    } catch {
      renderLobby('서버에 연결할 수 없어요. 서버 주소를 확인하세요.');
    }
  }

  async function joinRoom() {
    await saveLobbyFields();
    const code = ($('#mCode')?.value || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{5}$/.test(code)) return renderLobby('방 코드 5자리를 입력하세요.');
    connect(code);
  }

  function connect(code) {
    leave(false);
    M.code = code;
    const ws = new WebSocket(wsUrl(code));
    M.ws = ws;
    ws.addEventListener('open', () => {
      send({
        t: 'hello',
        name: S.profile.settings.playerName || '플레이어',
        canRender: S.aiOn,
        n: nextGameNumber(S.profile),
        records: S.profile.settings.memory !== false ? S.profile.games.filter((g) => g.memory !== false) : [],
        memory: S.profile.settings.memory !== false,
        skipRate: S.profile.style?.skipRate ?? null,
      });
    });
    ws.addEventListener('message', (e) => onMessage(JSON.parse(e.data)));
    ws.addEventListener('close', () => {
      if (M.ws !== ws) return;
      M.ws = null;
      if (M.phase && M.phase !== 'over') renderLobby('연결이 끊겼어요.');
    });
    renderLobby('');
  }

  function leave(rerender = true) {
    clearInterval(tick);
    if (M.ws) {
      const ws = M.ws;
      M.ws = null;
      ws.close();
    }
    Object.assign(M, { code: null, players: [], host: false, phase: null });
    if (rerender) renderLobby('');
  }

  // ---------- messages ----------

  async function onMessage(m) {
    if (m.t === 'welcome') {
      M.host = m.host;
      if (M.phase === 'over') renderOver();
      else if (!M.phase || M.phase === 'lobby') renderLobby();
    }
    else if (m.t === 'lobby') {
      M.players = m.players;
      M.host = M.players.some((p) => p.host) && M.host;
      if (!M.phase || M.phase === 'lobby') renderLobby();
    } else if (m.t === 'error') {
      const text = { full: '방이 가득 찼어요 (최대 6명).', in_progress: '이미 게임이 진행 중이에요.', not_host: '방장만 시작할 수 있어요.' }[m.code] || m.message || m.code;
      if (m.code === 'full' || m.code === 'in_progress') leave(false);
      renderLobby(text);
    } else if (m.t === 'started') startGame(m);
    else if (m.t === 'render') renderForRoom(m);
    else if (m.t === 'round_open') openPhase('statement', m);
    else if (m.t === 'vote_open') openPhase('vote', m);
    else if (m.t === 'night_open') openPhase('night', m);
    else if (m.t === 'defense_open') openPhase('defense', m);
    else if (m.t === 'verdict_open') openPhase('verdict', m);
    else if (m.t === 'defense') pushFeed({ kind: 'chat', seat: m.seat, text: m.text || '(말없이 받아들임)', final: true });
    else if (m.t === 'verdict_result') {
      const yes = m.verdicts.filter((v) => v.yes).map((v) => nameOf(v.voter));
      const no = m.verdicts.filter((v) => !v.yes).map((v) => nameOf(v.voter));
      pushFeed({ kind: 'sys', text: `처형 찬성: ${yes.join(', ') || '없음'} / 반대: ${no.join(', ') || '없음'}` });
      if (m.executed) {
        M.alive[m.executed.seat] = false;
        pushFeed({ kind: 'sys', text: `찬성 ${m.yes} : 반대 ${m.no} — ${nameOf(m.executed.seat)} 처형. 정체: ${ROLE_KO[m.executed.role]}` });
      } else if (m.immune) pushFeed({ kind: 'sys', text: `찬성 ${m.yes} : 반대 ${m.no} — ${nameOf(m.target)}는 정치인이라 처형되지 않음.` });
      else pushFeed({ kind: 'sys', text: `찬성 ${m.yes} : 반대 ${m.no} — ${nameOf(m.target)} 살아남음.` });
      renderSeats();
    }
    else if (m.t === 'ack') {
      M.submitted = true;
      renderActions();
    } else if (m.t === 'reveal') {
      if (m.round === 1) M.stance = {};
      for (const x of m.messages) {
        pushFeed({ kind: 'chat', seat: x.seat, text: x.text });
        if (x.intent) M.stance[x.seat] = x;
      }
      renderSeats();
      if (!m.messages.length) pushFeed({ kind: 'sys', text: '아무도 말하지 않았다.' });
    } else if (m.t === 'vote_result') {
      pushFeed({ kind: 'sys', text: m.votes.map((v) => `${nameOf(v.voter)}→${nameOf(v.target)}`).join('  ') });
      if (m.trial) pushFeed({ kind: 'sys', text: `${m.trial.tie ? '동표, 제비뽑기로 ' : ''}${nameOf(m.trial.seat)} 최다 득표(${m.trial.count}표). 최후 변론.` });
      if (m.executed) {
        M.alive[m.executed.seat] = false;
        pushFeed({ kind: 'sys', text: `${m.executed.tie ? '동표, 제비뽑기로 ' : ''}${nameOf(m.executed.seat)} 처형. 정체: ${ROLE_KO[m.executed.role]}` });
      }
      renderSeats();
    } else if (m.t === 'seer_result') {
      pushFeed({ kind: 'private', text: `조사 결과(나만 봄): ${nameOf(m.target)} → ${m.result === 'mafia' ? '마피아' : '시민'}` });
    } else if (m.t === 'night_result') {
      if (m.victim) {
        M.alive[m.victim.seat] = false;
        pushFeed({ kind: 'sys', text: `밤사이 ${nameOf(m.victim.seat)} 쓰러짐. 정체: ${ROLE_KO[m.victim.role]}` });
      } else if (m.armored) pushFeed({ kind: 'sys', text: `밤사이 ${nameOf(m.armored)}가 습격을 버텨냄. 군인이었다.` });
      else pushFeed({ kind: 'sys', text: m.saved ? '조용한 밤. 누군가 의사 덕에 살았다.' : '조용한 밤.' });
      if (m.report) pushFeed({ kind: 'sys', text: `📰 기자의 특종: ${nameOf(m.report.seat)}는 ${ROLE_KO[m.report.role]}.` });
      renderSeats();
    } else if (m.t === 'over') finishGame(m);
  }

  function startGame(m) {
    M.phase = 'started';
    M.seat = m.you;
    M.role = m.role;
    M.seats = m.seats;
    M.nick = Object.fromEntries(m.seats.map((s) => [s.id, s.nick]));
    M.alive = Object.fromEntries(m.seats.map((s) => [s.id, true]));
    M.color = Object.fromEntries(m.seats.map((s, i) => [s.id, COLORS[i % COLORS.length]]));
    M.feed = [];
    M.stance = {};
    M.startedAt = Date.now();
    S.game = null;
    $('#screen').innerHTML = `
      <section class="game multi">
        <div class="game-head"><span>방 ${esc(M.code)}</span><span id="phaseLabel"></span><span class="my-role ${M.role}">나: ${esc(nameOf(M.seat))} · ${ROLE_KO[M.role]}</span><span id="timer" class="muted"></span></div>
        <div class="seats" id="seats"></div>
        <div class="feed" id="feed"></div>
        <div class="actions" id="actions"></div>
      </section>`;
    renderSeats();
    M.partners = m.partners || [];
    const goal =
      M.role === 'mafia'
        ? `동료: ${M.partners.map((x) => nameOf(x)).join(', ') || '없음'}. 들키지 않고 살아남으세요.`
        : M.role === 'seer'
          ? '밤마다 한 명을 조사합니다.'
          : M.role === 'doctor'
            ? '밤마다 한 명을 지킵니다.'
            : M.role === 'soldier'
              ? '습격을 한 번 버텨냅니다.'
              : M.role === 'politician'
                ? '투표로는 처형되지 않습니다.'
                : '마피아를 찾아 처형하세요.';
    showModal(`<div class="role-card ${M.role}"><div class="role-kicker">내 닉네임 ${esc(nameOf(M.seat))}</div><div class="role-name">${ROLE_KO[M.role]}</div><p>${goal}</p><p class="hint">누가 사람이고 누가 AI인지는 끝날 때 공개됩니다.</p><button class="primary" data-act="closeModal">시작</button></div>`);
    pushFeed({ kind: 'sys', text: '1일차 낮. 각자 쓰고, 다 같이 공개됩니다.' });
  }

  function renderSeats() {
    const el = $('#seats');
    if (!el) return;
    el.innerHTML = M.seats
      .map(
        (s) => `<div class="seat ${M.alive[s.id] ? '' : 'dead'} ${s.id === M.seat ? 'me' : ''}">
        <div class="nick-avatar" style="background:${M.color[s.id]}">${esc(s.nick.slice(0, 1))}</div>
        <div class="seat-name">${esc(s.nick)}${s.id === M.seat ? ' <span class="muted small">(나)</span>' : ''}${M.partners?.includes(s.id) ? ' <span class="role-tag mafia">동료</span>' : ''}</div>
        ${M.alive[s.id] ? seatStanceHtml(s.id, M.stance, nameOf) : ''}</div>`,
      )
      .join('');
  }

  function pushFeed(it) {
    M.feed.push(it);
    const el = $('#feed');
    if (!el) return;
    let html;
    if (it.kind === 'chat') html = `<div class="chat ${it.final ? 'final' : ''}"><b style="color:${M.color[it.seat]}">${esc(nameOf(it.seat))}</b>${it.final ? '<span class="tag final">최후 변론</span>' : ''} ${esc(it.text)}</div>`;
    else html = `<div class="sys ${it.kind === 'private' ? 'private' : ''}">${esc(it.text)}</div>`;
    el.insertAdjacentHTML('beforeend', html);
    el.scrollTop = el.scrollHeight;
  }

  function openPhase(phase, m) {
    M.phase = phase;
    M.day = m.day;
    M.round = m.round;
    M.options = m.options;
    M.deadline = m.deadline;
    M.submitted = false;
    M.override = null;
    const label = { statement: `${m.day}일차 낮 · ${m.round}/${m.rounds} 라운드`, vote: `${m.day}일차 투표`, defense: `${m.day}일차 최후 변론`, verdict: `${m.day}일차 찬반 투표`, night: `${m.day}일차 밤` }[phase];
    const pl = $('#phaseLabel');
    if (pl) pl.textContent = label;
    if (phase === 'vote') pushFeed({ kind: 'sys', text: `${m.day}일차 투표. 다 같이 공개됩니다.` });
    if (phase === 'night') pushFeed({ kind: 'sys', text: `${m.day}일차 밤.` });
    clearInterval(tick);
    tick = setInterval(() => {
      const t = $('#timer');
      if (t) t.textContent = `${Math.max(0, Math.ceil((M.deadline - Date.now()) / 1000))}초`;
    }, 500);
    renderActions();
  }

  function targetBtns(targets, act) {
    return targets.map((t) => `<button class="target" data-act="${act}" data-target="${t}"><span class="dot" style="background:${M.color[t]}"></span>${esc(nameOf(t))}</button>`).join('');
  }

  function renderActions() {
    const el = $('#actions');
    if (!el) return;
    const o = M.options;
    if (!o || o.type === 'spectate' || !M.alive[M.seat]) {
      el.innerHTML = `<div class="act-title muted">탈락했습니다. 끝까지 지켜보세요.</div>`;
      return;
    }
    if (M.submitted) {
      el.innerHTML = `<div class="act-title muted">제출했어요. 다른 사람들을 기다리는 중…</div>`;
      return;
    }
    if (o.type === 'wait') {
      el.innerHTML = `<div class="act-title muted">${M.phase === 'defense' ? `${esc(nameOf(o.target))}의 최후 변론을 기다리는 중…` : '다른 사람들이 처형 여부를 정하는 중…'}</div>`;
    } else if (o.type === 'defense') {
      el.innerHTML = `<div class="act-title">최후 변론 <span class="muted small">내가 최다 득표. 이 한마디 뒤에 찬반 투표</span></div>
        <div class="composer"><input id="mSay" maxlength="80" placeholder="예: 나 아님, 진짜 마피아는 저 사람" autocomplete="off" /><button class="primary" data-act="mSend">변론</button><button class="ghost" data-act="mSkip">말없이</button></div>
        <div class="intent-row" id="mIntent"></div>`;
      updateChips();
      $('#mSay').focus();
    } else if (o.type === 'verdict') {
      el.innerHTML = `<div class="act-title">${esc(nameOf(o.target))} 처형할까요? <span class="muted small">찬성이 과반이어야 처형</span></div>
        <div class="act-row"><button class="primary" data-act="mVerdictYes">처형 찬성</button><button class="ghost" data-act="mVerdictNo">반대 (살린다)</button></div>`;
    } else if (o.type === 'statement') {
      el.innerHTML = `<div class="act-title">메시지 <span class="muted small">80자, 다 같이 공개됩니다</span></div>
        <div class="composer"><input id="mSay" maxlength="80" placeholder="예: ${esc(nameOf(o.targets[0]))} 좀 수상한데" autocomplete="off" /><button class="primary" data-act="mSend">보내기</button><button class="ghost" data-act="mSkip">스킵</button></div>
        <div class="intent-row" id="mIntent"></div>`;
      updateChips();
      $('#mSay').focus();
    } else if (o.type === 'vote') {
      el.innerHTML = `<div class="act-title">처형 투표</div><div class="act-row">${targetBtns(o.targets, 'mVote')}</div>`;
    } else if (o.type === 'night') {
      if (o.action === 'sleep') el.innerHTML = `<div class="act-title muted">밤입니다. 잠드는 중…</div>`;
      else el.innerHTML = `<div class="act-title">${{ kill: '제거할 사람', check: '조사할 사람', protect: '오늘 밤 지킬 사람 (자신도 가능)', report: '기자: 내일 정체를 공개할 사람 (판마다 한 번)' }[o.action]}</div><div class="act-row">${targetBtns(o.targets, 'mNight')}${o.optional ? `<button class="ghost" data-act="mNightSkip">아껴 둔다</button>` : ''}</div>`;
    }
  }

  function updateChips() {
    const row = $('#mIntent');
    const input = $('#mSay');
    const defense = M.options?.type === 'defense';
    if (!row || !input || (M.options?.type !== 'statement' && !defense)) return;
    const names = Object.fromEntries(M.options.targets.map((t) => [t, nameOf(t)]));
    let auto = parseIntent(input.value, names);
    if (auto.intent === 'skip') auto = { intent: defense ? 'deny' : 'pass', target: null };
    if (defense && !['deny', 'accuse', 'claim', 'pass'].includes(auto.intent)) auto = { intent: 'deny', target: null };
    const chosen = M.override ?? auto;
    const label = (x) => (x.target ? `${nameOf(x.target)} ${INTENT_KO[x.intent]}` : INTENT_KO[x.intent]);
    const alts = defense
      ? [{ intent: 'deny', target: null }, ...M.options.targets.map((t) => ({ intent: 'accuse', target: t })), { intent: 'pass', target: null }]
      : [...M.options.targets.flatMap((t) => [{ intent: 'accuse', target: t }, { intent: 'defend', target: t }]), { intent: 'pass', target: null }, { intent: 'deny', target: null }];
    M.alts = alts;
    M.chosen = chosen;
    row.innerHTML = `<span class="muted small">이렇게 집계:</span> <span class="chip-intent on">${esc(label(chosen))}</span>
      <details><summary class="muted small">바꾸기</summary>${alts.map((a, i) => `<button class="chip-intent" data-act="mPick" data-i="${i}">${esc(label(a))}</button>`).join('')}</details>`;
  }

  // Writes this player's share of rival lines with their own ChatGPT plan.
  async function renderForRoom(m) {
    // Short casual "pass" lines read like people as templates; only real moves use the plan.
    const ctxR = { mode: 'multi', nameOf: (id) => m.names[id] ?? id, chat: m.chat, style: styleForPrompt(S.profile.style), allowNumbers: [Object.keys(m.names).length], useModel: (sp) => sp.intent !== 'pass' };
    const lines = await renderLines(m.scene, m.specs, 'multi', ctxR);
    send({ t: 'lines', reqId: m.reqId, lines: lines.map((l) => ({ speaker: l.speaker, text: l.text })) });
    if (!S.aiOn) send({ t: 'render_status', canRender: false });
  }

  async function finishGame(m) {
    clearInterval(tick);
    M.phase = 'over';
    S.profile = addGame(S.profile, { ...m.record, n: nextGameNumber(S.profile) });
    const skipped = m.record.obs.filter((o) => o.f === 'round_skip' && o.v).length;
    const rounds = m.record.obs.filter((o) => o.f === 'round_skip').length;
    S.profile = { ...S.profile, style: learnStyle(S.profile.style ?? emptyStyle(), m.humanTexts, { skipped, rounds }) };
    await store.save(S.profile);
    bridge?.metricsAppend({ label: 'multi-game', durationMs: Date.now() - M.startedAt, humans: m.reveal.filter((r) => r.human).length, rivalLines: m.lineStats?.total, fallbackLines: m.lineStats?.fallback });
    M.last = m;
    renderOver();
  }

  function renderOver() {
    const m = M.last;
    const won = m.record.humanWon;
    $('#screen').innerHTML = `
    <section class="report">
      <div class="result ${won ? 'win' : 'lose'}"><div class="result-kicker">나: ${esc(nameOf(M.seat))} · ${ROLE_KO[m.record.role]}</div><div class="result-main">${won ? '승리' : '패배'}</div><div class="muted">${m.winner === 'town' ? '시민 승리' : '마피아 승리'}</div></div>
      <h2>정체 공개</h2>
      <table class="reveal"><tr><th>닉네임</th><th>정체</th><th>역할</th></tr>
        ${m.reveal.map((r) => `<tr class="${r.human ? 'human' : 'ai'}"><td>${esc(r.nick)}${r.seat === M.seat ? ' (나)' : ''}</td><td>${r.human ? `사람 · ${esc(r.name)}` : 'AI'}</td><td><span class="role-tag ${r.role}">${ROLE_KO[r.role]}</span></td></tr>`).join('')}
      </table>
      <p class="muted small">이번 판 사람들의 말투 ${m.humanTexts.length}줄을 이 컴퓨터에 학습했습니다. 다음 판 AI는 더 사람처럼 말합니다.</p>
      <div class="row">
        <button class="primary" data-act="mReport">AI가 본 나</button>
        ${M.host ? `<button class="primary" data-act="mStart">같은 방에서 한 판 더</button>` : '<span class="muted">방장이 다음 판을 시작할 수 있어요.</span>'}
        <button class="ghost" data-act="mLeave">방 나가기</button>
      </div>
    </section>`;
  }

  // ---------- clicks ----------

  async function onClick(a, b) {
    switch (a) {
      case 'mOpen':
        return renderLobby('');
      case 'mCreate':
        return createRoom();
      case 'mJoin':
        return joinRoom();
      case 'mLeave':
        leave(true);
        return;
      case 'mStart':
        return send({ t: 'start' });
      case 'mPick':
        M.override = M.alts[+b.dataset.i];
        return updateChips();
      case 'mSend': {
        const text = $('#mSay')?.value.trim();
        if (!text) return;
        const c = M.chosen;
        return send({ t: 'say', text, intent: c.intent, target: c.target, result: c.result, day: M.day, round: M.round });
      }
      case 'mSkip':
        return send({ t: 'say', intent: 'skip', day: M.day, round: M.round });
      case 'mVerdictYes':
        return send({ t: 'verdict', yes: true });
      case 'mVerdictNo':
        return send({ t: 'verdict', yes: false });
      case 'mVote':
        return send({ t: 'vote', target: b.dataset.target });
      case 'mNight':
        return send({ t: 'night', target: b.dataset.target });
      case 'mNightSkip':
        return send({ t: 'night', target: null });
      case 'mReport': {
        const m = M.last;
        const roles = Object.fromEntries(m.reveal.filter((r) => !r.human).map((r) => [r.seat, r.role]));
        return showReport(rivalReport(S.profile, m.record), S.profile.games[S.profile.games.length - 1], roles);
      }
    }
    return false;
  }

  document.addEventListener('input', (e) => {
    if (e.target.id === 'mSay') {
      M.override = null;
      updateChips();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.id === 'mSay' && e.key === 'Enter' && !e.isComposing) $('[data-act="mSend"]')?.click();
  });

  return { renderLobby, onClick, isMultiAction: (a) => a.startsWith('m') && a.length > 1 && a[1] === a[1].toUpperCase(), backToRoom: () => (M.last ? renderOver() : renderLobby()) };
}
