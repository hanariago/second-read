// Game UI. All input is clicks; the engine decides, dialogue only renders.
import { createGame, act, gameRecord, publicView, setLineText, ROLE_KO } from '../src/core/engine.js';
import { parseIntent } from '../src/core/intent.js';
import { CHARACTERS, HUMAN_ID, charById, displayName } from '../src/core/characters.js';
import { nextGameNumber, addGame, rivalReport, remarkSpecs, tallies, emptyProfile } from '../src/core/profile.js';
import { createDialogue } from '../src/ai/dialogue.js';
import { createBridgeTransport } from '../src/ai/bridgeTransport.js';
import { templateLine, humanLine, withName } from '../src/ai/templates.js';
import { sceneSummary, todayChat } from '../src/ai/prompts.js';
import { createBridgeStore, createLocalStorageStore } from '../src/store/tellStore.js';

const bridge = window.secondRead ?? null;
const store = bridge ? createBridgeStore(bridge) : createLocalStorageStore();
const USAGE_URL = 'https://chatgpt.com/settings/usage';
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portrait = (id) => `../assets/${id === HUMAN_ID ? 'you' : id}.svg`;

const S = {
  auth: null,
  aiOn: false, // true when ChatGPT plan usage is active for this session
  profile: emptyProfile(),
  game: null,
  feed: [],
  busy: false,
  voteTimer: null,
  signingIn: false,
  gm: null, // per-game metrics
  lastReport: null,
  info: null,
};

// ---------- dialogue ----------

function onMetric(m) {
  if (S.gm && !m.label.endsWith(':validation')) {
    S.gm.calls++;
    if (m.ok) {
      S.gm.inputTokens += m.inputTokens || 0;
      S.gm.outputTokens += m.outputTokens || 0;
      S.gm.samples.push({ ttftMs: m.ttftMs, totalMs: m.totalMs });
    } else S.gm.failures++;
  }
  if (S.gm && m.label.endsWith(':validation')) S.gm.rejected += m.rejected;
  bridge?.metricsAppend({ ...m, game: S.game?.n ?? null });
}

function dialogue() {
  return createDialogue({ transport: S.aiOn && bridge ? createBridgeTransport(bridge) : null, onMetric });
}

async function renderLines(scene, specs, label, ctx = {}) {
  try {
    return await dialogue().render(scene, specs, label, ctx);
  } catch (err) {
    handleFatal(err);
    return createDialogue({ transport: null }).render(scene, specs, label, ctx);
  }
}

function handleFatal(err) {
  S.aiOn = false;
  updateBadges();
  if (err.code === 'usage_limit') showUsageLimit();
  else if (['reauth', 'reauth_required', 'signed_out', 'plan_not_enabled'].includes(err.code))
    showModal(`<h2>다시 로그인이 필요해요</h2><p>ChatGPT 세션이 만료되었거나 연결이 해제되었습니다. 이번 판은 AI 없이 이어서 진행하고, 끝나면 타이틀에서 다시 로그인할 수 있어요.</p><div class="row"><button class="primary" data-act="closeModal">확인</button></div>`);
  else if (err.code === 'not_eligible')
    showModal(`<h2>ChatGPT 플랜을 사용할 수 없어요</h2><p>이 계정이나 워크스페이스에서는 ChatGPT 플랜 사용이 허용되지 않습니다. AI 없이 규칙 체험으로 계속합니다.</p><div class="row"><button class="primary" data-act="closeModal">확인</button></div>`);
  else showModal(`<h2>AI 연결 문제</h2><p>${esc(err.code || err.message)} — 이번 판은 AI 없이 이어서 진행합니다.</p><div class="row"><button class="primary" data-act="closeModal">확인</button></div>`);
}

function showUsageLimit() {
  showModal(`
    <div class="modal-logo"><img src="../assets/chatgpt-logo-white.svg" alt="ChatGPT" /></div>
    <h2>Usage limit reached</h2>
    <p>ChatGPT 플랜 또는 이 앱에 설정된 사용 한도에 도달했어요. ChatGPT 설정에서 한도를 확인하세요.</p>
    <div class="row col">
      <button class="primary" data-open="${USAGE_URL}">Manage usage</button>
      <button class="ghost" data-act="closeModal">AI 없이 이어서 하기</button>
    </div>`);
}

// ---------- badges, modal, settings ----------

function updateBadges() {
  $('#planBadge').classList.toggle('hidden', !S.aiOn);
  $('#offlineBadge').classList.toggle('hidden', S.aiOn || !S.game);
}

function showModal(html) {
  const m = $('#modal');
  m.innerHTML = `<div class="modal">${html}</div>`;
  m.classList.remove('hidden');
}
function closeModal() {
  $('#modal').classList.add('hidden');
  $('#modal').innerHTML = '';
}

async function refreshAuth() {
  S.auth = bridge ? await bridge.authStatus() : { signedIn: false, planEnabled: false };
  S.aiOn = !!(S.auth.signedIn && S.auth.planEnabled);
  updateBadges();
}

// ---------- title ----------

function chatgptButton(label = 'Continue with ChatGPT', act = 'signIn') {
  return `<button class="cgpt-btn" data-act="${act}"><img src="../assets/chatgpt-logo-white.svg" alt="" /><span>${label}</span></button>`;
}

function renderTitle(msg = '') {
  S.game = null;
  updateBadges();
  const n = nextGameNumber(S.profile);
  const t = tallies(S.profile);
  const a = S.auth || {};
  let main;
  if (S.signingIn) {
    main = `<p class="hint">브라우저에서 ChatGPT 로그인을 마치면 자동으로 돌아옵니다.</p><button class="ghost" data-act="cancelSignIn">취소</button>`;
  } else if (a.signedIn && a.planEnabled) {
    main = `<button class="primary big" data-act="newGame">${n}판째 시작</button>
      <p class="hint">${esc(a.account?.label || 'ChatGPT 계정')}${a.account?.email ? ` · ${esc(a.account.email)}` : ''}</p>`;
  } else if (a.signedIn && !a.planEnabled) {
    main = `<p class="warn">ChatGPT 플랜 사용 권한이 허용되지 않아 AI 대사를 쓸 수 없어요.</p>
      ${chatgptButton('Continue with ChatGPT', 'reconsent')}
      <button class="link" data-act="offline">AI 없이 규칙 체험</button>`;
  } else {
    main = `${chatgptButton()}
      <p class="hint">ChatGPT Plus 또는 Pro 구독자만 AI 플레이가 가능합니다. 로그인하면 AI 라이벌의 대사가 본인 ChatGPT 플랜 사용량으로 생성됩니다.</p>
      <button class="link" data-act="offline">AI 없이 규칙 체험</button>`;
  }
  $('#screen').innerHTML = `
  <section class="title">
    <div class="title-art">${CHARACTERS.map((c) => `<img src="${portrait(c.id)}" alt="${esc(c.name)}" />`).join('')}</div>
    <h1>Second Read</h1>
    <p class="tagline">기존 AI 마피아는 판이 끝나면 나를 잊는다.<br/>이 게임은 판이 쌓일수록 AI가 나를 읽고, 나는 읽힌 나를 속인다.</p>
    ${msg ? `<p class="warn">${esc(msg)}</p>` : ''}
    <div class="title-actions">${main}</div>
    ${S.profile.games.length ? `<div class="tally"><span>지금까지 ${S.profile.games.length}판</span><span class="read">읽힘 ${t.caught}</span><span class="bluff">속임 ${t.bluffs}</span>${S.profile.settings.memory ? '' : '<span class="off">기억 꺼짐</span>'}</div>
    <button class="link" data-act="lastReport">AI가 본 당신 (지난 판까지)</button>` : ''}
    <ul class="howto">
      <li>5명 중 1명이 마피아. 낮에 한 마디 하고, 투표로 1명을 처형합니다. 판은 최대 2일, 5분 안쪽.</li>
      <li>라이벌 4명은 각자 다른 습관을 지켜봅니다. 판이 쌓이면 지난 판의 당신을 근거로 의심하거나 믿습니다.</li>
      <li>읽혔다 싶으면 습관을 바꿔서 속이세요. 속인 횟수도 기록됩니다.</li>
    </ul>
  </section>`;
}

async function signIn(opts = {}) {
  if (!bridge) return;
  S.signingIn = true;
  renderTitle();
  const r = await bridge.signIn(opts);
  S.signingIn = false;
  await refreshAuth();
  if (!r.ok) {
    const msg =
      r.error.code === 'access_denied'
        ? 'ChatGPT 플랜 사용을 허용하지 않아 로그인이 취소되었어요. 나중에 다시 허용할 수 있습니다.'
        : r.error.code === 'cancelled'
          ? ''
          : `로그인 실패: ${r.error.code}`;
    renderTitle(msg);
    return;
  }
  renderTitle();
  if (S.auth.showPlanWelcome && S.auth.planEnabled) {
    showModal(`
      <div class="modal-logo"><img src="../assets/chatgpt-logo-white.svg" alt="ChatGPT" /></div>
      <h2>You're using your ChatGPT plan</h2>
      <p>Second Read에서 AI 라이벌의 대사는 당신의 ChatGPT 플랜 사용량으로 생성됩니다. 사용량과 이 앱의 한도는 ChatGPT 설정에서 관리할 수 있어요.</p>
      <div class="row col"><button class="primary" data-act="planWelcomeOk">Got it</button><button class="link" data-open="${USAGE_URL}">Manage usage</button></div>`);
  }
}

// ---------- game ----------

function newGame() {
  const n = nextGameNumber(S.profile);
  S.game = createGame({
    n,
    pastGames: S.profile.games,
    memory: S.profile.settings.memory !== false,
    seed: (Math.random() * 2 ** 31) | 0,
  });
  S.feed = [];
  S.gm = { n, start: Date.now(), calls: 0, failures: 0, rejected: 0, inputTokens: 0, outputTokens: 0, samples: [], ai: S.aiOn };
  updateBadges();
  renderGame();
  const role = S.game.humanRole;
  const goal = role === 'mafia' ? '들키지 않고 끝까지 살아남으세요. 밤마다 한 명을 제거합니다.' : role === 'seer' ? '밤마다 한 명의 정체를 조사합니다. 마피아를 투표로 처형하세요.' : '마피아 1명을 찾아 투표로 처형하세요.';
  const firstTime = n <= 2;
  showModal(`
    <div class="role-card ${role}">
      <div class="role-kicker">${n}판째 · 당신의 역할</div>
      <div class="role-name">${ROLE_KO[role]}</div>
      <p>${goal}</p>
      ${S.game.memory && n > 1 ? `<p class="hint">라이벌들은 지난 ${n - 1}판의 당신을 기억하고 있습니다.</p>` : ''}
      ${!S.game.memory ? `<p class="hint">기억 꺼짐: 이번 판 라이벌은 지난 판을 참고하지 않습니다.</p>` : ''}
      ${firstTime ? `<p class="hint">처음 몇 판은 역할이 번갈아 배정됩니다 (라이벌이 두 역할의 당신을 모두 봐야 하니까요).</p>` : ''}
      <button class="primary" data-act="closeModal">시작</button>
    </div>`);
  pushFeed({ kind: 'system', text: `${n}판 시작 — 1일차 낮. 모두 한 마디씩 합니다.` });
  renderActions();
}

function pushFeed(item) {
  S.feed.push(item);
  const el = $('#feed');
  if (!el) return;
  el.insertAdjacentHTML('beforeend', feedItemHtml(item));
  el.scrollTop = el.scrollHeight;
}

function feedItemHtml(it) {
  if (it.kind === 'system') return `<div class="sys">${esc(it.text)}</div>`;
  if (it.kind === 'private') return `<div class="sys private">${esc(it.text)}</div>`;
  if (it.kind === 'vote') return `<div class="vote-line"><b>${esc(displayName(it.voter))}</b> → ${esc(displayName(it.target))}</div>`;
  const c = charById[it.speaker];
  const ev = it.evidence?.length
    ? `<div class="evidence">${it.evidence.map((e) => `<span class="chip ${e.kind}">${esc(e.text)}</span>`).join('')}</div>`
    : '';
  return `<div class="line ${it.speaker === HUMAN_ID ? 'me' : ''} ${it.memory ? 'memory' : ''}">
    <img src="${portrait(it.speaker)}" alt="" />
    <div class="bubble"><div class="who" style="color:${c?.color ?? '#d9a441'}">${esc(displayName(it.speaker))}${it.memory ? '<span class="tag">기억</span>' : ''}</div>
    <div class="text">${esc(it.text)}</div>${ev}</div></div>`;
}

function seatsHtml() {
  const v = publicView(S.game);
  const counts = {};
  for (const x of v.votes) counts[x.target] = (counts[x.target] || 0) + 1;
  const voted = Object.fromEntries(v.votes.map((x) => [x.voter, x.target]));
  return v.players
    .map((p) => {
      const c = charById[p.id];
      const role = p.role ? `<span class="role-tag ${p.role}">${ROLE_KO[p.role]}</span>` : '';
      const check = v.seerChecks.find((x) => x.target === p.id);
      return `<div class="seat ${p.alive ? '' : 'dead'} ${p.id === HUMAN_ID ? 'me' : ''}" data-seat="${p.id}">
        <img src="${portrait(p.id)}" alt="" />
        <div class="seat-name">${esc(displayName(p.id))} ${role}</div>
        <div class="seat-sub">${c ? esc(c.title) : '플레이어'}</div>
        ${c ? `<div class="seat-watch" title="이 라이벌이 지켜보는 습관">👁 ${esc(c.watchLabel)}</div>` : ''}
        ${check ? `<div class="seat-check ${check.result}">조사: ${check.result === 'mafia' ? '마피아' : '시민'}</div>` : ''}
        ${counts[p.id] ? `<div class="votes">${'●'.repeat(counts[p.id])}</div>` : ''}
        ${voted[p.id] ? `<div class="voted">→ ${esc(displayName(voted[p.id]))}</div>` : ''}
      </div>`;
    })
    .join('');
}

function renderGame() {
  const g = S.game;
  $('#screen').innerHTML = `
  <section class="game">
    <div class="game-head"><span>${g.n}판</span><span id="phaseLabel"></span><span class="my-role ${g.humanRole}">당신: ${ROLE_KO[g.humanRole]}</span>${g.memory ? '' : '<span class="off">기억 꺼짐</span>'}</div>
    <div class="seats" id="seats">${seatsHtml()}</div>
    <div class="feed" id="feed">${S.feed.map(feedItemHtml).join('')}</div>
    <div class="actions" id="actions"></div>
  </section>`;
}

function refreshSeats() {
  const el = $('#seats');
  if (el) el.innerHTML = seatsHtml();
  const ph = $('#phaseLabel');
  if (ph && S.game) ph.textContent = `${S.game.day}일차 ${{ statement: '낮 · 발언', vote: '낮 · 투표', night: '밤', over: '종료' }[S.game.phase]}`;
}

const INTENT_KO = { accuse: '의심', defend: '감싸기', pass: '관망', deny: '부인', claim: '예언 공개', skip: '말 안 함' };

// Live preview of how the typed sentence will be counted; click to override.
function updateIntentChips() {
  const row = $('#intentRow');
  const input = $('#say');
  if (!row || !input || !S.game?.pending) return;
  const p = S.game.pending;
  const names = Object.fromEntries(p.targets.map((t) => [t, displayName(t)]));
  const auto = parseIntent(input.value, names);
  const chosen = S.intentOverride ?? auto;
  const label = (x) => (x.target ? `${displayName(x.target)} ${INTENT_KO[x.intent]}${x.intent === 'claim' ? `(${x.result === 'mafia' ? '마피아' : '시민'})` : ''}` : INTENT_KO[x.intent]);
  const alts = [
    ...p.targets.flatMap((t) => [{ intent: 'accuse', target: t }, { intent: 'defend', target: t }]),
    { intent: 'pass', target: null },
    { intent: 'deny', target: null },
  ];
  row.innerHTML = `<span class="muted small">이렇게 집계됩니다:</span> <span class="chip-intent on">${esc(label(chosen))}</span>
    <details><summary class="muted small">바꾸기</summary>${alts.map((a, i) => `<button class="chip-intent" data-act="intentPick" data-i="${i}">${esc(label(a))}</button>`).join('')}</details>`;
  S.intentAlts = alts;
  S.intentChosen = chosen.intent === 'skip' ? { intent: 'pass', target: null } : chosen;
}

function targetButtons(targets, act, extra = '') {
  return targets.map((t) => `<button class="target" data-act="${act}" data-target="${t}" ${extra}><img src="${portrait(t)}" alt="" />${esc(displayName(t))}</button>`).join('');
}

function renderActions() {
  refreshSeats();
  const el = $('#actions');
  if (!el || !S.game) return;
  const p = S.game.pending;
  clearTimeout(S.voteTimer);
  if (!p) {
    el.innerHTML = '';
    return;
  }
  if (S.busy) {
    el.innerHTML = `<div class="waiting">…</div>`;
    return;
  }
  if (p.type === 'statement') {
    const textMode = S.profile.settings.inputMode === 'text';
    const head = `<div class="act-title">당신의 한 마디 <span class="muted">${p.round}/${p.rounds} 라운드</span>
      <span class="mode-switch"><button class="${textMode ? '' : 'on'}" data-act="inputMode" data-mode="buttons">빠른 버튼</button><button class="${textMode ? 'on' : ''}" data-act="inputMode" data-mode="text">직접 입력</button></span></div>`;
    if (textMode) {
      el.innerHTML = `${head}
        <div class="composer"><input id="say" maxlength="80" placeholder="예: 레온 좀 수상한데? / 미오는 시민 같아" autocomplete="off" /><button class="primary" data-act="sayText">말하기</button></div>
        <div class="intent-row" id="intentRow"></div>`;
      updateIntentChips();
      $('#say').focus();
    } else {
      el.innerHTML = `${head}
      <div class="act-row"><span class="act-label">의심한다</span>${targetButtons(p.targets, 'say-accuse')}</div>
      <div class="act-row"><span class="act-label">감싼다</span>${targetButtons(p.targets, 'say-defend')}</div>
      ${p.claims.length ? `<div class="act-row"><span class="act-label">조사 결과 공개</span>${p.claims.map((c) => `<button class="target claim" data-act="say-claim" data-target="${c.target}">${esc(withName(`{t}는 ${c.result === 'mafia' ? '마피아' : '시민'}`, c.target))}</button>`).join('')}</div>` : ''}
      <div class="act-row"><button class="ghost" data-act="say-pass">관망한다</button>${p.accusedBy.length ? `<button class="ghost" data-act="say-deny">나는 아니라고 한다</button>` : ''}</div>`;
    }
  } else if (p.type === 'vote') {
    const total = S.game.voteOrder[S.game.day].length;
    el.innerHTML = `
      <div class="act-title">처형 투표 <span class="muted">투표 진행 ${p.votes.length}/${total + 1} · 언제 투표할지도 당신의 선택</span></div>
      <div class="act-row">${targetButtons(p.targets, 'vote')}</div>`;
    if (p.canWait) S.voteTimer = setTimeout(() => doAct({ type: 'wait' }), p.votes.length === 0 ? 3200 : 1700);
  } else if (p.type === 'night') {
    if (p.action === 'kill') el.innerHTML = `<div class="act-title">밤 · 제거할 사람을 고르세요</div><div class="act-row">${targetButtons(p.targets, 'night')}</div>`;
    else if (p.action === 'check') el.innerHTML = `<div class="act-title">밤 · 정체를 조사할 사람을 고르세요</div><div class="act-row">${targetButtons(p.targets, 'night')}</div>`;
    else el.innerHTML = `<div class="act-title">밤 · 시민은 잠듭니다</div><div class="act-row"><button class="primary" data-act="sleep">잠들기</button></div>`;
  } else if (p.type === 'spectate') {
    el.innerHTML = `<div class="act-title">당신은 탈락했습니다</div><div class="act-row"><button class="primary" data-act="spectate">남은 판 결과 보기</button></div>`;
  }
}

async function doAct(action) {
  if (S.busy || !S.game) return;
  clearTimeout(S.voteTimer);
  S.busy = true;
  renderActions();
  let events = [];
  try {
    events = act(S.game, action);
  } catch (e) {
    console.error(e);
  }
  await processEvents(events);
  S.busy = false;
  if (S.game?.phase === 'over') return finishGame();
  renderActions();
}

async function processEvents(events) {
  const g = S.game;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.t === 'statement' && ev.speaker === HUMAN_ID) {
      const text = humanLine(ev);
      setLineText(g, ev, text);
      pushFeed({ kind: 'line', speaker: HUMAN_ID, text });
    } else if (ev.t === 'statement') {
      const batch = [];
      while (i < events.length && events[i].t === 'statement' && events[i].speaker !== HUMAN_ID) batch.push(events[i++]);
      i--;
      const specs = batch.map((e) => ({ speaker: e.speaker, intent: e.intent, target: e.target, result: e.result, evidence: e.evidence, day: e.day }));
      pushFeed({ kind: 'system', text: `${batch.map((b) => displayName(b.speaker)).join(', ')} 생각 중…` });
      const lines = await renderLines(sceneSummary(g), specs, `d${g.day}-statements`, { mode: 'single', chat: todayChat(g) });
      for (let k = 0; k < batch.length; k++) {
        setLineText(g, batch[k], lines[k].text);
        pushFeed({ kind: 'line', speaker: batch[k].speaker, text: lines[k].text, evidence: batch[k].evidence, memory: !!batch[k].evidence?.length });
        await sleep(450);
      }
    } else if (ev.t === 'aside') {
      pushFeed({ kind: 'line', speaker: ev.speaker, text: templateLine({ ...ev }), evidence: ev.evidence, memory: true });
      await sleep(700);
    } else if (ev.t === 'vote') {
      pushFeed({ kind: 'vote', voter: ev.voter, target: ev.target });
      refreshSeats();
      if (ev.voter !== HUMAN_ID) await sleep(380);
    } else if (ev.t === 'execute') {
      refreshSeats();
      await sleep(400);
      pushFeed({ kind: 'system', text: `${ev.tie ? '동표 — 제비뽑기로 ' : ''}${displayName(ev.target)} 처형. 정체: ${ROLE_KO[ev.role]}` });
    } else if (ev.t === 'night') {
      pushFeed({ kind: 'system', text: `밤사이 ${displayName(ev.victim)}${ev.victim === HUMAN_ID ? '이' : '가'} 쓰러졌습니다. 정체: ${ROLE_KO[ev.role]}` });
    } else if (ev.t === 'seerResult') {
      pushFeed({ kind: 'private', text: `조사 결과(당신만 봄): ${withName(`{t}는 ${ev.result === 'mafia' ? '마피아' : '시민'}입니다.`, ev.target)}` });
    } else if (ev.t === 'phase') {
      refreshSeats();
      if (ev.phase === 'vote') pushFeed({ kind: 'system', text: `${ev.day}일차 투표. 처형할 사람을 고르세요.` });
      if (ev.phase === 'night') pushFeed({ kind: 'system', text: `${ev.day}일차 밤.` });
      if (ev.phase === 'statement' && ev.day > 1 && ev.round === 1) pushFeed({ kind: 'system', text: `${ev.day}일차 낮.` });
      if (ev.phase === 'statement' && ev.round > 1) pushFeed({ kind: 'system', text: `${ev.round}라운드 — 방금 말에 반응할 차례.` });
    } else if (ev.t === 'over') {
      pushFeed({ kind: 'system', text: ev.winner === 'town' ? '시민 승리' : '마피아 승리' });
    }
  }
}

async function finishGame() {
  const g = S.game;
  const record = gameRecord(g);
  S.profile = addGame(S.profile, record);
  await store.save(S.profile);
  const report = rivalReport(S.profile, record);
  S.lastReport = { report, record, roles: Object.fromEntries(g.players.map((p) => [p.id, p.role])), remarks: null };
  renderReport();
  const mine = S.lastReport;
  const remarks = await renderLines(`${g.n}판 종료 후, 라이벌들이 플레이어에게 한마디씩 한다`, remarkSpecs(report), 'remarks');
  mine.remarks = remarks;
  if (S.gm) {
    const s = S.gm.samples.filter((x) => x.totalMs != null);
    bridge?.metricsAppend({
      label: 'game',
      game: g.n,
      ai: S.gm.ai,
      durationMs: Date.now() - S.gm.start,
      calls: S.gm.calls,
      failures: S.gm.failures,
      rejectedLines: S.gm.rejected,
      inputTokens: S.gm.inputTokens,
      outputTokens: S.gm.outputTokens,
      avgTtftMs: s.length ? Math.round(s.reduce((a, b) => a + (b.ttftMs || 0), 0) / s.length) : null,
      avgTotalMs: s.length ? Math.round(s.reduce((a, b) => a + b.totalMs, 0) / s.length) : null,
      tellCitations: record.tellCitations,
      flips: record.flips.length,
    });
  }
  // The player may already have started the next game while remarks loaded.
  if (S.lastReport === mine && !S.game && document.querySelector('.report')) renderReport();
}

const FLIP_LABEL = {
  read: ['읽힘', '기억이 없었다면 다른 사람을 찍었을 텐데, 지난 판의 당신을 근거로 마피아인 당신에게 투표했습니다.'],
  deceived: ['속임 성공', '기억이 없었다면 당신을 찍었을 텐데, 지난 판의 당신과 달라서 마피아인 당신을 놓쳤습니다.'],
  misread: ['오판 유도', '시민인 당신을 지난 판의 마피아 습관 때문에 찍었습니다.'],
  cleared: ['간파', '지난 판의 시민 습관을 보고 시민인 당신을 믿었습니다.'],
};

function renderReport() {
  const { report, record, roles, remarks } = S.lastReport;
  S.game = null;
  updateBadges();
  const won = record.humanWon;
  const flips = record.flips;
  const rivals = report.rivals
    .map((r, i) => {
      const remark = remarks?.[i]?.text;
      const rows = r.tells
        .map((t) => {
          const mRate = t.mafia.n ? Math.round((100 * t.mafia.k) / t.mafia.n) : null;
          const tRate = t.town.n ? Math.round((100 * t.town.k) / t.town.n) : null;
          return `<div class="tell-row ${t.ready ? 'ready' : ''}">
            <div class="tell-label">${esc(t.label)} ${t.ready ? `<span class="tag">${t.gap > 0 ? '마피아 쪽 신호' : '시민 쪽 신호'}</span>` : ''}</div>
            <div class="tell-bars">
              <div class="bar mafia"><span style="width:${mRate ?? 0}%"></span><em>마피아일 때 ${t.mafia.n ? `${t.mafia.k}/${t.mafia.n}` : '—'}</em></div>
              <div class="bar town"><span style="width:${tRate ?? 0}%"></span><em>시민일 때 ${t.town.n ? `${t.town.k}/${t.town.n}` : '—'}</em></div>
            </div></div>`;
        })
        .join('');
      const rf = r.flips.map((f) => `<div class="flip ${f.kind}"><b>${FLIP_LABEL[f.kind][0]}</b> ${f.day}일차 투표 — ${esc(FLIP_LABEL[f.kind][1])}</div>`).join('');
      return `<div class="rival">
        <div class="rival-head"><img src="${portrait(r.id)}" alt="" /><div><div class="rival-name">${esc(r.name)} ${roles[r.id] ? `<span class="role-tag ${roles[r.id]}">${ROLE_KO[roles[r.id]]}</span>` : ''}</div><div class="muted">지켜보는 것: ${esc(r.watchLabel)}</div></div></div>
        ${rows}${rf}
        <div class="remark">${remark ? `“${esc(remark)}”` : '<span class="muted">…</span>'}</div>
      </div>`;
    })
    .join('');
  const t = report.tally;
  $('#screen').innerHTML = `
  <section class="report">
    <div class="result ${won ? 'win' : 'lose'}">
      <div class="result-kicker">${record.n}판 · 당신은 ${ROLE_KO[record.role]}</div>
      <div class="result-main">${won ? '승리' : '패배'}</div>
      <div class="muted">${record.winner === 'town' ? '시민 승리' : '마피아 승리'}${record.memory ? '' : ' · 기억 꺼짐으로 플레이한 판'}</div>
    </div>
    <h2>AI가 본 당신 <span class="muted">라이벌들의 연구 노트 · ${report.gamesSeen}판 분량</span></h2>
    <div class="tally big"><span class="read">읽힘 ${t.caught}</span><span class="bluff">속임 ${t.bluffs}</span><span class="muted">이번 판 기억이 바꾼 투표 ${flips.length}표</span></div>
    ${flips.length ? '' : `<p class="muted">이번 판에는 기억 때문에 바뀐 투표가 없었습니다.</p>`}
    <div class="rivals">${rivals}</div>
    <p class="muted small">이 노트는 당신의 클릭(발언 종류, 투표 타이밍과 대상, 밤 선택)만으로 계산되며 이 컴퓨터에만 저장됩니다.</p>
    <div class="row"><button class="primary big" data-act="newGame">${nextGameNumber(S.profile)}판째 시작</button><button class="ghost" data-act="title">타이틀</button></div>
  </section>`;
}

function showLastReport() {
  const last = S.profile.games[S.profile.games.length - 1];
  if (!last) return;
  const report = rivalReport(S.profile, last);
  S.lastReport = { report, record: last, roles: Object.fromEntries(CHARACTERS.map((c) => [c.id, null])), remarks: null };
  renderReport();
}

// ---------- settings ----------

async function openSettings() {
  const d = $('#settings');
  const a = S.auth || {};
  const metrics = bridge ? await bridge.metricsLoad() : [];
  const games = metrics.filter((m) => m.label === 'game' && m.ai);
  const calls = metrics.filter((m) => m.label !== 'game' && !m.label?.endsWith(':validation') && m.ok);
  const avg = (arr, k) => (arr.length ? Math.round(arr.reduce((s, x) => s + (x[k] || 0), 0) / arr.length) : '—');
  d.innerHTML = `
    <div class="drawer-head"><h2>설정</h2><button class="icon-btn" data-act="closeSettings" aria-label="닫기">✕</button></div>
    <section><h3>ChatGPT 계정</h3>
      ${a.signedIn ? `<p>${esc(a.account?.label || '')}${a.account?.email ? `<br/><span class="muted">${esc(a.account.email)}</span>` : ''}</p>
        ${a.planEnabled ? `<div class="plan-inline"><img src="../assets/chatgpt-logo-white.svg" alt="" />Using ChatGPT plan <button class="link" data-open="${USAGE_URL}">Manage usage</button></div>` : `<p class="warn">ChatGPT 플랜 사용이 허용되지 않았습니다.</p>${chatgptButton('Continue with ChatGPT', 'reconsent')}`}
        <div class="row"><button class="ghost" data-act="signOut">로그아웃</button><button class="ghost" data-act="signInNew">다른 계정 추가</button></div>`
        : `<p class="muted">로그인하지 않음</p>${chatgptButton()}`}
    </section>
    ${a.planEnabled ? `<section><h3>모델</h3><select id="modelSelect"><option>불러오는 중…</option></select><p class="muted small">빠른 모델일수록 판 템포가 좋아집니다.</p></section>` : ''}
    <section><h3>기억</h3>
      <label class="toggle"><input type="checkbox" id="memToggle" ${S.profile.settings.memory !== false ? 'checked' : ''}/> 라이벌이 지난 판을 기억함</label>
      <p class="muted small">끄면 라이벌이 지난 판을 참고하지 않습니다(비교용). 꺼진 상태로 한 판은 기억에 쌓이지 않습니다.</p>
      <button class="ghost danger" data-act="resetMemory">기억 초기화</button>
      <p class="muted small">저장되는 것은 게임 안 클릭 기록뿐이며 이 컴퓨터에만 있습니다.</p>
    </section>
    <section><h3>측정 (AI 사용 판 기준)</h3>
      <p class="small">판 수 ${games.length} · 판당 평균 ${avg(games, 'durationMs') === '—' ? '—' : Math.round(avg(games, 'durationMs') / 1000) + '초'} · 판당 입력 ${avg(games, 'inputTokens')} / 출력 ${avg(games, 'outputTokens')} 토큰 · 판당 호출 ${avg(games, 'calls')}회</p>
      <p class="small">응답 ${calls.length}회 · 첫 토큰까지 평균 ${avg(calls, 'ttftMs')}ms · 완료까지 평균 ${avg(calls, 'totalMs')}ms</p>
      ${bridge ? `<button class="ghost" data-act="exportMetrics">측정 기록 내보내기</button>` : ''}
    </section>
    <section><h3>정보</h3><p class="small">Second Read ${esc(S.info?.version || '')} · 오픈소스 (MIT)</p>${S.info ? `<button class="link" data-open="${S.info.repo}">소스 코드 보기</button>` : ''}</section>`;
  d.classList.remove('hidden');
  if (a.planEnabled && bridge) {
    const r = await bridge.models();
    const sel = $('#modelSelect');
    if (sel && r.ok) sel.innerHTML = r.models.map((m) => `<option value="${esc(m.slug)}" ${m.slug === r.selected ? 'selected' : ''}>${esc(m.display_name)}</option>`).join('');
    else if (sel) sel.innerHTML = `<option>모델 목록을 불러오지 못함 (${esc(r.error?.code)})</option>`;
  }
}

// ---------- events ----------

document.addEventListener('click', async (e) => {
  const open = e.target.closest('[data-open]');
  if (open) {
    e.preventDefault();
    if (bridge) bridge.open(open.dataset.open);
    else window.open(open.dataset.open, '_blank', 'noopener');
    return;
  }
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const a = b.dataset.act;
  const t = b.dataset.target;
  switch (a) {
    case 'signIn':
      return signIn({ mode: 'continue' });
    case 'signInNew':
      $('#settings').classList.add('hidden');
      return signIn({ mode: 'new' });
    case 'reconsent':
      $('#settings').classList.add('hidden');
      return signIn({ mode: 'continue', reconsent: true });
    case 'cancelSignIn':
      return bridge?.cancelSignIn();
    case 'planWelcomeOk':
      closeModal();
      return bridge?.planWelcomeShown();
    case 'offline':
      S.aiOn = false;
      return newGame();
    case 'newGame':
      await refreshAuth();
      return newGame();
    case 'title':
      await refreshAuth();
      return renderTitle();
    case 'lastReport':
      return showLastReport();
    case 'closeModal':
      return closeModal();
    case 'say-accuse':
      return doAct({ intent: 'accuse', target: t });
    case 'say-defend':
      return doAct({ intent: 'defend', target: t });
    case 'say-claim':
      return doAct({ intent: 'claim', target: t });
    case 'say-pass':
      return doAct({ intent: 'pass' });
    case 'say-deny':
      return doAct({ intent: 'deny' });
    case 'inputMode':
      S.profile = { ...S.profile, settings: { ...S.profile.settings, inputMode: b.dataset.mode } };
      await store.save(S.profile);
      return renderActions();
    case 'intentPick':
      S.intentOverride = S.intentAlts[+b.dataset.i];
      return updateIntentChips();
    case 'sayText': {
      const text = $('#say')?.value.trim();
      if (!text) return;
      const c = S.intentChosen;
      S.intentOverride = null;
      return doAct({ intent: c.intent, target: c.target, result: c.result, text });
    }
    case 'vote':
      return doAct({ type: 'vote', target: t });
    case 'night':
      return doAct({ target: t });
    case 'sleep':
      return doAct({});
    case 'spectate':
      return doAct({ type: 'continue' });
    case 'closeSettings':
      return $('#settings').classList.add('hidden');
    case 'signOut': {
      const r = await bridge.signOut();
      await refreshAuth();
      $('#settings').classList.add('hidden');
      if (!S.game) renderTitle(r.revocationConfirmed ? '' : '로그아웃했지만 원격 세션 해제를 확인하지 못했어요. ChatGPT 설정에서 앱 연결을 해제할 수 있습니다.');
      return;
    }
    case 'resetMemory':
      if (!confirm('라이벌의 기억(지난 판 기록)을 모두 지울까요?')) return;
      await store.clear();
      S.profile = emptyProfile();
      $('#settings').classList.add('hidden');
      if (!S.game) renderTitle();
      return;
    case 'exportMetrics':
      return bridge?.metricsExport();
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'say') {
    S.intentOverride = null;
    updateIntentChips();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.target.id === 'say' && e.key === 'Enter' && !e.isComposing) $('[data-act="sayText"]')?.click();
});

document.addEventListener('change', async (e) => {
  if (e.target.id === 'memToggle') {
    S.profile = { ...S.profile, settings: { ...S.profile.settings, memory: e.target.checked } };
    await store.save(S.profile);
    if (!S.game) renderTitle();
  }
  if (e.target.id === 'modelSelect') await bridge?.setModel(e.target.value);
});

$('#settingsBtn').addEventListener('click', () => {
  const d = $('#settings');
  if (d.classList.contains('hidden')) openSettings();
  else d.classList.add('hidden');
});

(async function init() {
  S.profile = await store.load();
  S.info = bridge ? await bridge.info() : null;
  await refreshAuth();
  renderTitle();
})();
