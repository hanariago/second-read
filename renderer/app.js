// Game UI. All input is clicks; the engine decides, dialogue only renders.
import { createGame, act, gameRecord, publicView, setLineText, mafiaTeam, roleDeck, ROLE_KO, TABLE_SIZES } from '../src/core/engine.js';
import { parseIntent } from '../src/core/intent.js';
import { CHARACTERS, HUMAN_ID, charById, displayName } from '../src/core/characters.js';
import { nextGameNumber, addGame, rivalReport, remarkSpecs, tallies, emptyProfile } from '../src/core/profile.js';
import { createDialogue } from '../src/ai/dialogue.js';
import { createBridgeTransport } from '../src/ai/bridgeTransport.js';
import { templateLine, humanLine, withName } from '../src/ai/templates.js';
import { sceneSummary, todayChat } from '../src/ai/prompts.js';
import { createBridgeStore, createLocalStorageStore } from '../src/store/tellStore.js';
import { setupMulti } from './multi.js';
import { assignHabits, maybeRerollHabits, notebookFor, seatNote } from '../src/core/notebook.js';
import { FEATURES } from '../src/core/tells.js';
import { reasonText, QUESTIONS, ANSWER_TEXT, PREDICTION_TEXT, PREDICTABLE } from '../src/data/reasons.ko.js';
import { TIPS, UI } from '../src/data/ui.ko.js';
import { createSound } from './sound.js';

const bridge = window.secondRead ?? null;
const store = bridge ? createBridgeStore(bridge) : createLocalStorageStore();
const USAGE_URL = 'https://chatgpt.com/settings/usage';
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Once the player is out, the rest of the game plays fast.
const sleep = (ms) => new Promise((r) => setTimeout(r, S.game && !publicView(S.game).players.find((p) => p.id === HUMAN_ID)?.alive ? Math.min(ms, 60) : ms));
const portrait = (id) => `../assets/portraits/${id === HUMAN_ID ? 'you' : id}.jpg`;

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

// Dev only: localStorage['second-read.devFakeAI'] = '1' answers with canned lines,
// so the multiplayer render path can be tested without a ChatGPT login.
function devFakeTransport() {
  try {
    if (localStorage.getItem('second-read.devFakeAI') !== '1') return null;
  } catch {
    return null;
  }
  return {
    async complete({ input }) {
      const { speakers } = JSON.parse(input[0].content);
      const lines = speakers.map((s) => ({ speaker_id: s.speaker_id, text: s.target ? `${s.target} 쪽이 좀 걸림 (fake)` : '음 일단 봄 (fake)', evidence_ids: s.evidence.slice(0, 1).map((e) => e.id) }));
      return { text: JSON.stringify({ lines }), usage: { input_tokens: 0, output_tokens: 0 }, ttftMs: 0, totalMs: 0, model: 'fake' };
    },
  };
}

function dialogue() {
  const transport = devFakeTransport() ?? (S.aiOn && bridge ? createBridgeTransport(bridge) : null);
  return createDialogue({ transport, onMetric });
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
    <div class="modal-logo"><img src="../assets/chatgpt-logo-black.svg" alt="ChatGPT" /></div>
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
  S.aiOn = !!(S.auth.signedIn && S.auth.planEnabled) || !!devFakeTransport();
  updateBadges();
}

// ---------- title ----------

function chatgptButton(label = 'Continue with ChatGPT', act = 'signIn') {
  return `<button class="cgpt-btn" data-act="${act}"><img src="../assets/chatgpt-logo-white.svg" alt="" /><span>${label}</span></button>`;
}

const sound = createSound(() => S.profile.settings);

// Table size: roles grow with the number of players.
function tablePicker() {
  const cur = S.profile.settings.tableSize ?? 7;
  const deck = roleDeck(cur);
  const count = (r) => deck.filter((x) => x === r).length;
  const parts = ['mafia', 'seer', 'doctor', 'soldier', 'politician', 'villager'].filter((r) => count(r)).map((r) => `${ROLE_KO[r]} ${count(r)}`);
  return `<div class="table-picker"><span class="muted small">인원</span>${TABLE_SIZES.map((n) => `<button class="${n === cur ? 'on' : ''}" data-act="tableSize" data-n="${n}">${n}명</button>`).join('')}<div class="muted small">${parts.join(' · ')}</div></div>`;
}

function rivalryLine() {
  const r = S.profile.rivalry || {};
  const rows = CHARACTERS.filter((c) => r[c.id] && (r[c.id].win || r[c.id].loss));
  if (!rows.length) return '';
  return `<div class="tally rivalry">${rows.map((c) => `<span><img src="${portrait(c.id)}" alt="" />${esc(c.name)} ${r[c.id].win}승 ${r[c.id].loss}패</span>`).join('')}</div>`;
}

// First games: one short tip per new kind of decision, shown once.
function tipHtml(kind) {
  const seen = S.profile.settings.tipsSeen || {};
  if (seen[kind] || !TIPS[kind] || S.profile.games.length > 3) return '';
  return `<div class="tip"><span>💡 ${esc(TIPS[kind])}</span><button class="link" data-act="tipOk" data-kind="${kind}">알겠어요</button></div>`;
}

function firstTip(kinds) {
  for (const k of kinds) {
    const h = k ? tipHtml(k) : '';
    if (h) return h;
  }
  return '';
}

function predictionText(p) {
  const P = PREDICTABLE[p.f];
  const rival = displayName(p.rival);
  return {
    head: PREDICTION_TEXT.intro.replace('{rival}', rival),
    body: PREDICTION_TEXT.body.replace('{mafia}', p.expect.mafia ? P.yes : P.no).replace('{town}', p.expect.town ? P.yes : P.no),
  };
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
    main = `${tablePicker()}<button class="primary big" data-act="newGame">${n}판째 시작</button>
      <p class="hint">${esc(a.account?.label || 'ChatGPT 계정')}${a.account?.email ? ` · ${esc(a.account.email)}` : ''}</p>`;
  } else if (a.signedIn && !a.planEnabled) {
    main = `<p class="warn">ChatGPT 플랜 사용 권한이 허용되지 않아 AI 대사를 쓸 수 없어요.</p>
      ${chatgptButton('Continue with ChatGPT', 'reconsent')}
      ${tablePicker()}<button class="link" data-act="offline">AI 없이 규칙 체험</button>`;
  } else {
    main = `${chatgptButton()}
      <p class="hint">ChatGPT Plus 또는 Pro 구독자만 AI 플레이가 가능합니다. 로그인하면 AI 라이벌의 대사가 본인 ChatGPT 플랜 사용량으로 생성됩니다.</p>
      ${tablePicker()}<button class="link" data-act="offline">AI 없이 규칙 체험</button>`;
  }
  $('#screen').innerHTML = `
  <section class="title">
    <div class="hero"><img src="../assets/portraits/keyart.jpg" alt="여섯 라이벌이 둘러앉은 테이블" /></div>
    <h1>Second Read</h1>
    <p class="tagline">기존 AI 마피아는 판이 끝나면 나를 잊는다.<br/>이 게임은 판이 쌓일수록 AI가 나를 읽고, 나는 읽힌 나를 속인다.</p>
    ${msg ? `<p class="warn">${esc(msg)}</p>` : ''}
    <div class="title-actions">${main}${S.signingIn ? '' : `<button class="ghost" data-act="mOpen">친구와 하기 (멀티)</button>`}</div>
    ${S.profile.games.length ? `<div class="tally"><span>지금까지 ${S.profile.games.length}판</span><span class="read">읽힘 ${t.caught}</span><span class="bluff">속임 ${t.bluffs}</span>${S.profile.settings.memory ? '' : '<span class="off">기억 꺼짐</span>'}</div>
    ${rivalryLine()}
    <button class="link" data-act="lastReport">AI가 본 당신 (지난 판까지)</button>` : ''}
    <ul class="howto">
      <li>7명 중 마피아 2명(서로를 앎), 예언자·의사 1명씩. 낮에 말하고, 하루 한 번 추궁하고, 투표합니다. 최다 득표자는 최후 변론 뒤 찬반으로 처형.</li>
      <li>라이벌의 말에는 근거가 붙습니다. 마피아는 흔적을 남겨요: 동료에겐 표를 안 주고, 자길 의심한 사람을 밤에 노리고, 추궁당하면 거짓말을 합니다.</li>
      <li>라이벌들은 판을 넘어 당신의 버릇을 기억하고, 판 시작 전에 예측합니다. 예측을 깨면 그 라이벌은 그 판 동안 당신을 못 읽어요.</li>
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
      <div class="modal-logo"><img src="../assets/chatgpt-logo-black.svg" alt="ChatGPT" /></div>
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
    aiHabits: S.profile.aiHabits,
    tableSize: S.profile.settings.tableSize ?? 7,
  });
  // Notes from past games only; this game's roles are never reflected here.
  S.seatNotes = Object.fromEntries(CHARACTERS.map((c) => [c.id, seatNote(S.profile.games, c.id, n)]));
  S.feed = [];
  S.stance = {};
  S.gm = { n, start: Date.now(), calls: 0, failures: 0, rejected: 0, inputTokens: 0, outputTokens: 0, samples: [], ai: S.aiOn };
  updateBadges();
  renderGame();
  const role = S.game.humanRole;
  const partners = mafiaTeam(S.game, HUMAN_ID);
  const mafiaN = S.game.players.filter((p) => p.role === 'mafia').length;
  const goal = {
    reporter: `판마다 한 번, 밤에 한 명을 골라 다음 날 아침 정체를 공개합니다. 마피아 ${mafiaN}명을 찾아내세요.`,
    mafia: partners.length ? `동료 ${partners.map((x) => displayName(x)).join(', ')}와 함께 들키지 않고 살아남으세요. 밤마다 한 명을 제거합니다.` : '혼자 들키지 않고 살아남으세요. 밤마다 한 명을 제거합니다.',
    seer: `밤마다 한 명의 정체를 조사합니다. 마피아 ${mafiaN}명을 투표로 처형하세요.`,
    doctor: `밤마다 한 명을 지킵니다(자신도 가능). 마피아 ${mafiaN}명을 찾아내세요.`,
    soldier: `마피아의 습격을 한 번 버텨냅니다(그때 정체가 공개돼요). 마피아 ${mafiaN}명을 찾아내세요.`,
    politician: `투표로는 처형되지 않습니다(그때 정체가 공개돼요). 마피아 ${mafiaN}명을 찾아내세요.`,
    villager: `마피아 ${mafiaN}명을 찾아 투표로 처형하세요.`,
  }[role];
  const firstTime = n <= 2;
  showModal(`
    <div class="role-card ${role}">
      <div class="role-kicker">${n}판째 · 당신의 역할</div>
      <div class="role-name">${ROLE_KO[role]}</div>
      <p>${goal}</p>
      ${S.game.memory && n > 1 ? `<p class="hint">라이벌들은 지난 ${n - 1}판의 당신을 기억하고 있습니다.</p>` : ''}
      ${!S.game.memory ? `<p class="hint">기억 꺼짐: 이번 판 라이벌은 지난 판을 참고하지 않습니다.</p>` : ''}
      ${firstTime ? `<p class="hint">처음 몇 판은 역할이 번갈아 배정됩니다 (라이벌이 두 역할의 당신을 모두 봐야 하니까요).</p>` : ''}
      ${S.game.prediction ? (() => { const t = predictionText(S.game.prediction); return `<div class="prediction-card"><img src="${portrait(S.game.prediction.rival)}" alt="" /><div><div class="pc-head">🎯 ${esc(t.head)}</div><div class="pc-body">“${esc(t.body)}”</div><div class="muted small">깨면 이번 판 ${esc(displayName(S.game.prediction.rival))}의 기억이 흐려지고, 맞으면 더 날카로워져요.</div></div></div>`; })() : ''}
      <button class="primary" data-act="closeModal">시작</button>
    </div>`);
  sound.play('role');
  pushFeed({ kind: 'system', text: `${n}판 시작 — 1일차 낮. 모두 한 마디씩 합니다.` });
  renderActions();
}

function answerLine(ev) {
  const r = ev.result === 'mafia' ? '마피아' : '시민';
  const tpl = ANSWER_TEXT[ev.kind] ?? '';
  if (ev.kind === 'why') return reasonText(ev.reason, displayName) || ANSWER_TEXT.why_none;
  return withName(tpl, ev.target).replace('{r}', r);
}

function predictionToast(p, text) {
  const el = document.createElement('div');
  el.className = `read-flash pred ${p.status}`;
  el.innerHTML = `<img src="${portrait(p.rival)}" alt="" /><div><div class="rf-kicker">🎯 예측 대결</div><div class="rf-title">${p.status === 'broken' ? '예측을 깼다' : '예측 적중'}</div><div class="rf-text">${esc(text)}</div></div>`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

function renderPredictionChip() {
  const el = $('#predChip');
  const p = S.game?.prediction;
  if (!el || !p) return;
  const t = predictionText(p);
  const state = { pending: '진행 중', hit: '적중당함', broken: '깨뜨림' }[p.status];
  el.className = `pred-chip ${p.status}`;
  el.title = `${t.head}: ${t.body}`;
  el.innerHTML = `<img src="${portrait(p.rival)}" alt="" />🎯 ${esc(t.head)} <b>${state}</b>`;
}

// The "들켰다" moment: a rival calls you out from memory. Never blocks input.
function readFlash(speaker, text) {
  const el = document.createElement('div');
  el.className = 'read-flash';
  el.innerHTML = `<img src="${portrait(speaker)}" alt="" /><div><div class="rf-kicker">${esc(displayName(speaker))}에게</div><div class="rf-title">읽혔다</div><div class="rf-text">${esc(text)}</div></div>`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
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
  if (it.kind === 'alert') return `<div class="sys alert">${esc(it.text)}</div>`;
  if (it.kind === 'vote') return `<div class="vote-line"><b>${esc(displayName(it.voter))}</b> → ${esc(displayName(it.target))}</div>`;
  const c = charById[it.speaker];
  const ev = it.evidence?.length
    ? `<div class="evidence">${it.evidence.map((e) => `<span class="chip ${e.kind}">${esc(e.text)}</span>`).join('')}</div>`
    : '';
  const why = it.reason ? `<div class="reason ${it.reason.kind.startsWith('gut') ? 'gut' : ''}">${UI.reasonLabel}: ${esc(reasonText(it.reason, displayName))}</div>` : '';
  return `<div class="line ${it.speaker === HUMAN_ID ? 'me' : ''} ${it.memory ? 'memory' : ''}">
    <img src="${portrait(it.speaker)}" alt="" />
    <div class="bubble"><div class="who" style="color:${c?.color ?? '#b7791f'}">${esc(displayName(it.speaker))}${it.final ? '<span class="tag final">최후 변론</span>' : ''}${it.asked ? '<span class="tag asked">추궁 답변</span>' : ''}${it.memory ? '<span class="tag">기억</span>' : ''}</div>
    <div class="text">${esc(it.text)}</div>${why}${ev}</div></div>`;
}

// What a seat said most recently today, shown under the seat once the line is on screen.
function stanceLabel(st, nameOf = displayName) {
  if (!st) return '';
  const t = st.target ? nameOf(st.target) : '';
  switch (st.intent) {
    case 'accuse':
      return `🗯 ${t} 의심`;
    case 'defend':
      return `🤝 ${t} 감쌈`;
    case 'deny':
      return '🙅 자기 부인';
    case 'claim':
      return st.target ? `🔮 예언: ${t} ${st.result === 'mafia' ? '마피아' : '시민'}` : '🔮 예언자 주장';
    case 'skip':
      return '… 말 없음';
    default:
      return '👀 관망';
  }
}

function seatStanceHtml(id, stance, nameOf = displayName) {
  const st = stance?.[id];
  const accused = Object.values(stance || {}).filter((x) => x.intent === 'accuse' && x.target === id).length;
  return `${st ? `<div class="seat-stance ${st.intent}">${esc(stanceLabel(st, nameOf))}</div>` : ''}${accused ? `<div class="seat-accused">의심받음 ${accused}</div>` : ''}`;
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
        ${c ? `<div class="seat-watch" title="이 라이벌이 지켜보는 당신의 습관">👁 ${esc(c.watchLabel)}</div>` : ''}
        ${S.seatNotes?.[p.id] ? `<div class="seat-note" title="내 노트: 지난 판들에서 본 이 라이벌">📓 ${esc(S.seatNotes[p.id])}</div>` : ''}
        ${check ? `<div class="seat-check ${check.result}">조사: ${check.result === 'mafia' ? '마피아' : '시민'}</div>` : ''}
        ${p.alive ? seatStanceHtml(p.id, S.stance) : ''}
        ${p.alive && S.game.promises[S.game.day]?.[p.id] ? `<div class="seat-badge promise">${esc(UI.promiseBadge.replace('{x}', displayName(S.game.promises[S.game.day][p.id])))}</div>` : ''}
        ${S.game.brokenPromises.some((b) => b.who === p.id) ? `<div class="seat-badge broke">${UI.brokeBadge}</div>` : ''}
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
    <div class="game-head"><span>${g.n}판</span><span id="phaseLabel"></span><span class="my-role ${g.humanRole}">당신: ${ROLE_KO[g.humanRole]}</span>${g.memory ? '' : '<span class="off">기억 꺼짐</span>'}<span id="predChip"></span></div>
    <div class="seats ${g.players.length > 9 ? 'dense' : ''}" id="seats">${seatsHtml()}</div>
    <div class="feed" id="feed">${S.feed.map(feedItemHtml).join('')}</div>
    <div class="actions" id="actions"></div>
  </section>`;
  renderPredictionChip();
}

function refreshSeats() {
  const el = $('#seats');
  if (el) el.innerHTML = seatsHtml();
  const ph = $('#phaseLabel');
  if (ph && S.game) ph.textContent = `${S.game.day}일차 ${{ statement: '낮 · 발언', vote: '낮 · 투표', defense: '낮 · 최후 변론', verdict: '낮 · 찬반 투표', night: '밤', over: '종료' }[S.game.phase]}`;
}

// Plan usage goes only to lines the player feels: aimed at them, citing memory,
// final words, or answering something they said. Rival-vs-rival talk uses templates.
// A hard cap per game; plain accusations of the player only get the model early on.
const MODEL_BUDGET = 4;
function worthModel(g, sp) {
  const used = S.gm?.modelBatches ?? 0;
  if (used >= MODEL_BUDGET) return false;
  if (!g.players.find((p) => p.id === HUMAN_ID)?.alive) return false; // spectating: no plan usage
  if (sp.evidence?.length || sp.final) return true;
  if (sp.intent === 'deny') return (g.statements[sp.day] || []).some((s) => s.speaker === HUMAN_ID && s.intent === 'accuse' && s.target === sp.speaker);
  if (sp.target === HUMAN_ID) return used < 2;
  return false;
}

const INTENT_KO = { accuse: '의심', defend: '감싸기', pass: '관망', deny: '부인', claim: '예언 공개', skip: '말 안 함' };

// Live preview of how the typed sentence will be counted; click to override.
function updateIntentChips() {
  const row = $('#intentRow');
  const input = $('#say');
  if (!row || !input || !S.game?.pending) return;
  const p = S.game.pending;
  const names = Object.fromEntries(p.targets.map((t) => [t, displayName(t)]));
  let auto = parseIntent(input.value, names);
  const defense = p.type === 'defense';
  if (defense && !['deny', 'accuse', 'claim', 'pass'].includes(auto.intent)) auto = { intent: auto.intent === 'skip' ? 'pass' : 'deny', target: null };
  const chosen = S.intentOverride ?? auto;
  const label = (x) => (x.target ? `${displayName(x.target)} ${INTENT_KO[x.intent]}${x.intent === 'claim' ? `(${x.result === 'mafia' ? '마피아' : '시민'})` : ''}` : INTENT_KO[x.intent]);
  const alts = defense
    ? [{ intent: 'deny', target: null }, ...p.targets.map((t) => ({ intent: 'accuse', target: t })), { intent: 'pass', target: null }]
    : [...p.targets.flatMap((t) => [{ intent: 'accuse', target: t }, { intent: 'defend', target: t }]), { intent: 'pass', target: null }, { intent: 'deny', target: null }];
  row.innerHTML = `<span class="muted small">이렇게 집계됩니다:</span> <span class="chip-intent on">${esc(label(chosen))}</span>
    <details><summary class="muted small">바꾸기</summary>${alts.map((a, i) => `<button class="chip-intent" data-act="intentPick" data-i="${i}">${esc(label(a))}</button>`).join('')}</details>`;
  S.intentAlts = alts;
  S.intentChosen = chosen.intent === 'skip' ? { intent: 'pass', target: null } : chosen;
}

function targetButtons(targets, act, extra = '') {
  return targets.map((t) => `<button class="target" data-act="${act}" data-target="${t}" ${extra}><img src="${portrait(t)}" alt="" />${esc(displayName(t))}</button>`).join('');
}

// "추궁하기": once a day, pick a rival, then one of three questions.
function askHtml(p) {
  if (!p.askable?.length) return '';
  if (!p.canAsk) return `<div class="ask-row used">🔎 ${UI.askUsed}</div>`;
  const t = S.askTarget && p.askable.includes(S.askTarget) ? S.askTarget : null;
  const hasAccused = t && (S.game.statements[S.game.day] || []).some((s) => s.speaker === t && s.intent === 'accuse');
  return `<div class="ask-row"><span class="act-label">🔎 ${UI.askTitle} <span class="muted small">${UI.askHint}</span></span>
    ${t
      ? `<span class="ask-who"><img src="${portrait(t)}" alt="" />${esc(displayName(t))}에게</span>${Object.entries(QUESTIONS)
          .filter(([q]) => q !== 'why' || hasAccused)
          .map(([q, v]) => `<button class="target q" data-act="ask" data-target="${t}" data-q="${q}">${esc(v.label)}</button>`)
          .join('')}<button class="link" data-act="askCancel">취소</button>`
      : targetButtons(p.askable, 'askPick')}</div>`;
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
      <div class="act-row"><span class="act-label">나를 변호</span><button class="ghost ${p.accusedBy.length ? 'hot' : ''}" data-act="say-deny">나는 아니다</button>${p.accusedBy.length ? `<span class="muted small">당신을 의심 중: ${esc(p.accusedBy.map((x) => displayName(x)).join(', '))}</span>` : ''}</div>
      <div class="act-row"><button class="ghost" data-act="say-pass">관망한다</button>${p.canClaimBare ? `<button class="ghost seer" data-act="say-claim-bare">내가 진짜 예언자다</button>` : ''}</div>`;
    }
    el.innerHTML = firstTip(['statement', S.game.prediction ? 'prediction' : null, p.canAsk ? 'ask' : null]) + el.innerHTML + askHtml(p);
  } else if (p.type === 'vote') {
    const total = S.game.voteOrder[S.game.day].length;
    el.innerHTML = tipHtml('vote') + `
      <div class="act-title">처형 투표 <span class="muted">투표 진행 ${p.votes.length}/${total + 1} · 언제 투표할지도 당신의 선택</span></div>
      <div class="act-row">${targetButtons(p.targets, 'vote')}</div>`;
    if (p.canWait) S.voteTimer = setTimeout(() => doAct({ type: 'wait' }), p.votes.length === 0 ? 3200 : 1700);
  } else if (p.type === 'defense') {
    const textMode = S.profile.settings.inputMode === 'text';
    const head = tipHtml('defense') + `<div class="act-title">최후 변론 <span class="muted">당신이 최다 득표(${p.counts[HUMAN_ID]}표). 이 한마디 뒤에 찬반 투표가 열립니다.</span></div>`;
    if (textMode) {
      el.innerHTML = `${head}
        <div class="composer"><input id="say" maxlength="80" placeholder="예: 나 아니야, 진짜 마피아는 미오야" autocomplete="off" /><button class="primary" data-act="sayText">변론하기</button></div>
        <div class="intent-row" id="intentRow"></div>`;
      updateIntentChips();
      $('#say').focus();
    } else {
      el.innerHTML = `${head}
        <div class="act-row"><button class="primary" data-act="say-deny">나는 아니다</button><button class="ghost" data-act="say-pass">말없이 받아들인다</button></div>
        <div class="act-row"><span class="act-label">진짜 마피아는</span>${targetButtons(p.targets, 'say-accuse')}</div>
        ${p.claims.length ? `<div class="act-row"><span class="act-label">조사 결과 공개</span>${p.claims.map((c) => `<button class="target claim" data-act="say-claim" data-target="${c.target}">${esc(withName(`{t}는 ${c.result === 'mafia' ? '마피아' : '시민'}`, c.target))}</button>`).join('')}</div>` : ''}`;
    }
  } else if (p.type === 'verdict') {
    el.innerHTML = tipHtml('verdict') + `<div class="act-title">${esc(displayName(p.target))}의 처형 <span class="muted">최후 변론을 듣고 결정하세요. 찬성이 과반이어야 처형됩니다.</span></div>
      <div class="act-row"><button class="primary" data-act="verdict-yes">처형 찬성</button><button class="ghost" data-act="verdict-no">반대 (살린다)</button></div>`;
  } else if (p.type === 'night') {
    sound.mood(true);
    if (p.action === 'kill') el.innerHTML = `<div class="act-title">밤 · 제거할 사람을 고르세요</div><div class="act-row">${targetButtons(p.targets, 'night')}</div>`;
    else if (p.action === 'check') el.innerHTML = `<div class="act-title">밤 · 정체를 조사할 사람을 고르세요</div><div class="act-row">${targetButtons(p.targets, 'night')}</div>`;
    else if (p.action === 'protect') el.innerHTML = `<div class="act-title">밤 · 오늘 밤 지킬 사람을 고르세요 <span class="muted">(자신도 가능)</span></div><div class="act-row">${targetButtons(p.targets, 'night')}</div>`;
    else if (p.action === 'report') el.innerHTML = `<div class="act-title">밤 · 기자: 내일 아침 정체를 공개할 사람 <span class="muted">(판마다 한 번)</span></div><div class="act-row">${targetButtons(p.targets, 'night')}<button class="ghost" data-act="sleep">이번엔 아껴 둔다</button></div>`;
    else el.innerHTML = `<div class="act-title">밤 · 시민은 잠듭니다</div><div class="act-row"><button class="primary" data-act="sleep">잠들기</button></div>`;
    el.innerHTML = tipHtml('night') + el.innerHTML;
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
      pushFeed({ kind: 'line', speaker: HUMAN_ID, text, final: ev.final });
      S.stance[HUMAN_ID] = ev;
      refreshSeats();
    } else if (ev.t === 'statement') {
      const all = [];
      while (i < events.length && events[i].t === 'statement' && events[i].speaker !== HUMAN_ID) all.push(events[i++]);
      i--;
      // Silent skips stay silent; plain "watching" lines collapse into one line.
      const quiet = all.filter((e) => (e.intent === 'pass' || e.intent === 'skip') && !e.evidence?.length && !e.final);
      const batch = all.filter((e) => !quiet.includes(e));
      for (const q of quiet) S.stance[q.speaker] = q.intent === 'pass' ? q : S.stance[q.speaker];
      const watchers = quiet.filter((e) => e.intent === 'pass');
      if (watchers.length) pushFeed({ kind: 'system', text: UI.passGroup.replace('{names}', watchers.map((e) => displayName(e.speaker)).join('·')) });
      if (!batch.length) {
        refreshSeats();
        continue;
      }
      const specs = batch.map((e) => ({ speaker: e.speaker, intent: e.intent, target: e.target, result: e.result, evidence: e.evidence, day: e.day, final: e.final, reason: e.reason }));
      pushFeed({ kind: 'system', text: `${batch.map((b) => displayName(b.speaker)).join(', ')} 생각 중…` });
      const worth = specs.map((sp) => worthModel(g, sp));
      if (S.gm && S.aiOn && worth.some(Boolean)) S.gm.modelBatches = (S.gm.modelBatches ?? 0) + 1;
      const lines = await renderLines(sceneSummary(g), specs, `d${g.day}-statements`, { mode: 'single', chat: todayChat(g), useModel: (sp) => worth[specs.indexOf(sp)] });
      for (let k = 0; k < batch.length; k++) {
        setLineText(g, batch[k], lines[k].text);
        pushFeed({ kind: 'line', speaker: batch[k].speaker, text: lines[k].text, evidence: batch[k].evidence, memory: !!batch[k].evidence?.length, final: batch[k].final, reason: batch[k].reason });
        S.stance[batch[k].speaker] = batch[k];
        refreshSeats();
        sound.play('line');
        if (batch[k].evidence?.length && batch[k].target === HUMAN_ID && batch[k].intent === 'accuse') readFlash(batch[k].speaker, lines[k].text);
        await sleep(450);
      }
    } else if (ev.t === 'aside') {
      const text = templateLine({ ...ev });
      pushFeed({ kind: 'line', speaker: ev.speaker, text, evidence: ev.evidence, memory: true });
      if (ev.kind === 'suspect') readFlash(ev.speaker, text);
      await sleep(700);
    } else if (ev.t === 'answer') {
      const text = answerLine(ev);
      pushFeed({ kind: 'line', speaker: ev.speaker, text, asked: true, reason: ev.kind === 'why' ? ev.reason : null });
      if (ev.kind === 'role_seer' || ev.kind === 'role_seer_bare') S.stance[ev.speaker] = { intent: 'claim', target: ev.target, result: ev.result };
      sound.play('ask');
      refreshSeats();
      await sleep(400);
    } else if (ev.t === 'promiseBroken') {
      pushFeed({ kind: 'alert', text: UI.promiseBroken.replace('{t}', displayName(ev.who)).replace('{x}', displayName(ev.promised)).replace('{y}', displayName(ev.voted)) });
      sound.play('read');
      await sleep(500);
    } else if (ev.t === 'prediction') {
      const msg = PREDICTION_TEXT[ev.status].replaceAll('{rival}', displayName(ev.rival));
      predictionToast(ev, msg);
      sound.play(ev.status === 'broken' ? 'predict' : 'read');
      renderPredictionChip();
    } else if (ev.t === 'vote') {
      pushFeed({ kind: 'vote', voter: ev.voter, target: ev.target });
      refreshSeats();
      sound.play('vote');
      if (ev.voter !== HUMAN_ID) await sleep(380);
    } else if (ev.t === 'execute') {
      refreshSeats();
      await sleep(400);
      pushFeed({ kind: 'system', text: `찬성 ${ev.yes} : 반대 ${ev.no} — ${displayName(ev.target)} 처형. 정체: ${ROLE_KO[ev.role]}` });
      sound.play('execute');
    } else if (ev.t === 'trial') {
      refreshSeats();
      pushFeed({ kind: 'system', text: `${ev.tie ? '동표 — 제비뽑기로 ' : ''}${displayName(ev.target)} 최다 득표(${ev.counts[ev.target]}표). 처형 전에 최후 변론.` });
      sound.play('trial');
      await sleep(500);
    } else if (ev.t === 'verdict') {
      const batch = [];
      while (i < events.length && events[i].t === 'verdict') batch.push(events[i++]);
      i--;
      const yes = batch.filter((v) => v.yes).map((v) => displayName(v.voter));
      const no = batch.filter((v) => !v.yes).map((v) => displayName(v.voter));
      pushFeed({ kind: 'system', text: `처형 찬성: ${yes.join(', ') || '없음'} / 반대: ${no.join(', ') || '없음'}` });
      await sleep(500);
    } else if (ev.t === 'report') {
      pushFeed({ kind: 'alert', text: `📰 기자의 특종: ${withName('{t}는', ev.target)} ${ROLE_KO[ev.role]}입니다.` });
      sound.play('trial');
      refreshSeats();
    } else if (ev.t === 'immune') {
      pushFeed({ kind: 'alert', text: `찬성 ${ev.yes} : 반대 ${ev.no} — 그러나 ${withName('{t}는', ev.target)} 정치인이라 투표로 처형되지 않습니다.` });
      refreshSeats();
    } else if (ev.t === 'spared') {
      pushFeed({ kind: 'system', text: `찬성 ${ev.yes} : 반대 ${ev.no} — ${withName('{t}는', ev.target)} 살아남았습니다.` });
    } else if (ev.t === 'night') {
      if (ev.victim) pushFeed({ kind: 'system', text: `밤사이 ${withName('{t}가', ev.victim)} 쓰러졌습니다. 정체: ${ROLE_KO[ev.role]}` });
      else if (ev.armored) pushFeed({ kind: 'alert', text: `밤사이 ${withName('{t}가', ev.armored)} 습격을 버텨냈습니다. 군인이었습니다.` });
      else pushFeed({ kind: 'system', text: ev.saved ? '조용한 밤이었습니다. 누군가 의사의 손에 살아났습니다.' : '조용한 밤이었습니다.' });
    } else if (ev.t === 'seerResult') {
      pushFeed({ kind: 'private', text: `조사 결과(당신만 봄): ${withName(`{t}는 ${ev.result === 'mafia' ? '마피아' : '시민'}입니다.`, ev.target)}` });
    } else if (ev.t === 'phase') {
      refreshSeats();
      if (ev.phase === 'vote') pushFeed({ kind: 'system', text: `${ev.day}일차 투표. 처형할 사람을 고르세요.` });
      if (ev.phase === 'night') {
        pushFeed({ kind: 'system', text: `${ev.day}일차 밤.` });
        sound.play('night');
      }
      if (ev.phase === 'statement' && ev.day > 1 && ev.round === 1) {
        S.stance = {};
        sound.mood(false);
        refreshSeats();
        pushFeed({ kind: 'system', text: `${ev.day}일차 낮.` });
      }
      if (ev.phase === 'statement' && ev.round > 1) pushFeed({ kind: 'system', text: `${ev.round}라운드 — 방금 말에 반응할 차례.` });
    } else if (ev.t === 'over') {
      pushFeed({ kind: 'system', text: ev.timeout ? '4일이 지났습니다 — 마피아가 끝까지 숨어 승리' : ev.winner === 'town' ? '시민 승리' : '마피아 승리' });
      sound.play(ev.humanWon ? 'win' : 'lose');
      sound.mood(false);
    }
  }
}

async function finishGame() {
  const g = S.game;
  const record = gameRecord(g);
  S.profile = addGame(S.profile, record);
  // Prediction duel record, per rival.
  if (record.prediction && record.prediction.status !== 'pending') {
    const rv = { ...(S.profile.rivalry || {}) };
    const cur = rv[record.prediction.rival] || { win: 0, loss: 0 };
    rv[record.prediction.rival] = record.prediction.status === 'broken' ? { ...cur, win: cur.win + 1 } : { ...cur, loss: cur.loss + 1 };
    S.profile = { ...S.profile, rivalry: rv };
  }
  // A rival caught with its habit may quietly change it.
  const { habits, changed } = maybeRerollHabits(S.profile.aiHabits, record);
  S.profile = { ...S.profile, aiHabits: habits };
  await store.save(S.profile);
  const report = rivalReport(S.profile, record);
  S.lastReport = { report, record, roles: Object.fromEntries(g.players.map((p) => [p.id, p.role])), remarks: null, habitChanged: changed };
  renderReport();
  const mine = S.lastReport;
  // End-of-game remarks are templates built from the same evidence (no plan usage).
  const remarks = await renderLines(`${g.n}판 종료`, remarkSpecs(report), 'remarks', { useModel: () => false });
  mine.remarks = remarks;
  if (S.gm) mine.cost = { ai: S.gm.ai, calls: S.gm.calls, inputTokens: S.gm.inputTokens, outputTokens: S.gm.outputTokens };
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
  // Only the rivals who sat at this table (all of them when browsing from the title).
  const seated = Object.keys(roles || {});
  const rivals = report.rivals
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => !seated.length || Object.values(roles).every((x) => x === null) || seated.includes(r.id))
    .map(({ r, i }) => {
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
      const rf = r.flips.map((f) => `<div class="flip ${f.kind}"><b>${FLIP_LABEL[f.kind][0]}</b> ${f.day}일차 ${f.verdict ? '최후 판결' : '투표'} — ${esc(FLIP_LABEL[f.kind][1])}</div>`).join('');
      // First games: the rival hasn't got a tell on you yet, so it shows its notes and promises to compare.
      const ready = r.tells.some((x) => x.ready);
      const watched = (record.obs || []).filter((o) => charById[r.id].watches.includes(o.f));
      const memoParts = [...new Set(watched.map((o) => o.f))].map((f) => {
        const xs = watched.filter((o) => o.f === f);
        return `'${FEATURES[f].label}' ${xs.filter((o) => o.v).length}/${xs.length}`;
      });
      const memo = !ready && memoParts.length ? `<div class="memo">📝 ${esc(r.name)}의 메모: 이번 판(${ROLE_KO[record.role]}) ${esc(memoParts.join(', '))}. ${record.side === 'mafia' ? '시민' : '마피아'}일 때와 비교해 볼게요.</div>` : '';
      const nb = record.aiObs ? notebookFor(S.profile.games, r.id, nextGameNumber(S.profile)).filter((x) => x.mafia.n || x.town.n) : [];
      const notebook = nb.length
        ? `<details class="notebook" ${nb.some((x) => x.ready) ? 'open' : ''}><summary>📓 내가 본 ${esc(r.name)}</summary>${nb
            .map((x) => `<div class="nb-row ${x.ready ? 'ready' : ''}">${esc(x.label)} <span class="muted">마피아 ${x.mafia.n ? `${x.mafia.k}/${x.mafia.n}` : '—'} · 시민 ${x.town.n ? `${x.town.k}/${x.town.n}` : '—'}</span>${x.ready ? ` <span class="tag">${x.gap > 0 ? '마피아일 때 더' : '시민일 때 더'}</span>` : ''}</div>`)
            .join('')}</details>`
        : '';
      const changedNote = S.lastReport.habitChanged?.includes(r.id) ? `<div class="memo">😏 ${esc(r.name)}: 들킨 걸 눈치챈 것 같습니다. 다음 판부터 버릇이 바뀔 수 있어요.</div>` : '';
      return `<div class="rival">
        <div class="rival-head"><img src="${portrait(r.id)}" alt="" /><div><div class="rival-name">${esc(r.name)} ${roles[r.id] ? `<span class="role-tag ${roles[r.id]}">${ROLE_KO[roles[r.id]]}</span>` : ''}</div><div class="muted">지켜보는 것: ${esc(r.watchLabel)}</div></div></div>
        ${rows}${rf}${memo}${notebook}${changedNote}
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
    ${record.prediction ? (() => { const pt = predictionText(record.prediction); const st = { pending: '이번 판엔 판정 없음', hit: '적중당했다', broken: '깨뜨렸다' }[record.prediction.status]; return `<div class="pred-result ${record.prediction.status}"><img src="${portrait(record.prediction.rival)}" alt="" /><div><b>🎯 ${esc(pt.head)} — ${st}</b><div class="muted">“${esc(pt.body)}”</div></div></div>`; })() : ''}
    ${rivalryLine()}
    ${surveyHtml(record)}
    <h2>AI가 본 당신 <span class="muted">라이벌들의 연구 노트 · ${report.gamesSeen}판 분량</span></h2>
    <div class="tally big"><span class="read">읽힘 ${t.caught}</span><span class="bluff">속임 ${t.bluffs}</span><span class="muted">이번 판 기억이 바꾼 투표 ${flips.length}표</span></div>
    ${flips.length ? '' : `<p class="muted">이번 판에는 기억 때문에 바뀐 투표가 없었습니다.</p>`}
    <div class="rivals">${rivals}</div>
    ${S.lastReport.cost?.ai ? `<p class="muted small">이번 판 ChatGPT 플랜 사용: AI 호출 ${S.lastReport.cost.calls}회 · 입력 ${S.lastReport.cost.inputTokens.toLocaleString()} / 출력 ${S.lastReport.cost.outputTokens.toLocaleString()} 토큰</p>` : ''}
    <p class="muted small">이 노트는 당신의 클릭(발언 종류, 투표 타이밍과 대상, 밤 선택)만으로 계산되며 이 컴퓨터에만 저장됩니다.</p>
    <div class="row">${S.lastReport.multi ? `<button class="primary big" data-act="mBack">방으로 돌아가기</button>` : `<button class="primary big" data-act="newGame">${nextGameNumber(S.profile)}판째 시작</button>`}<button class="ghost" data-act="title">타이틀</button></div>
  </section>`;
}

// Used by multiplayer to show the same rival notebook after a room game.
function showReport(report, record, roles) {
  S.lastReport = { report, record, roles, remarks: null, multi: true };
  renderReport();
}

const multi = setupMulti({ S, store, $, esc, showModal, closeModal, renderTitle, renderLines, updateBadges, bridge, showReport, seatStanceHtml });

function showLastReport() {
  const last = S.profile.games[S.profile.games.length - 1];
  if (!last) return;
  const report = rivalReport(S.profile, last);
  S.lastReport = { report, record: last, roles: Object.fromEntries(CHARACTERS.map((c) => [c.id, null])), remarks: null };
  renderReport();
}

// Two quick questions after a game (kept locally, exported only by the player).
function surveyHtml(record) {
  if (!S.profile.games.length || S.profile.games[S.profile.games.length - 1].n !== record.n) return '';
  const s = record.survey || {};
  const q = (key, label, opts) => `<div class="survey-q"><span>${label}</span>${opts.map(([v, t]) => `<button class="${s[key] === v ? 'on' : ''}" data-act="survey" data-q="${key}" data-v="${v}">${t}</button>`).join('')}</div>`;
  return `<div class="survey">${q('read', '이번 판, 라이벌에게 읽혔다고 느꼈나요?', [['yes', '네'], ['bit', '조금'], ['no', '아니요']])}${q('again', '한 판 더 하고 싶나요?', [['yes', '네'], ['no', '아니요']])}</div>`;
}

function diagHtml(r) {
  return `<div class="diag ${r.ok ? 'ok' : 'bad'}"><b>${r.ok ? '정상' : '문제 있음'}</b>${r.steps
    .map((s) => `<div class="diag-step ${s.ok ? 'ok' : 'bad'}">${s.ok ? '✓' : '✕'} ${esc(s.name)} <span class="muted small">${s.ms}ms ${esc(JSON.stringify(s.detail ?? {}))}</span></div>`)
    .join('')}<button class="link" data-act="copyDiag">결과 복사</button></div>`;
}

// Playtest export: per-game outcome, the player's own answers and the rivals' reads.
function playtestExport() {
  const games = S.profile.games.map((g) => ({
    n: g.n,
    role: g.role,
    won: g.humanWon,
    days: g.days,
    memory: g.memory,
    tellCitations: g.tellCitations,
    flips: (g.flips || []).map((f) => f.kind),
    prediction: g.prediction ? { rival: g.prediction.rival, f: g.prediction.f, status: g.prediction.status } : null,
    survey: g.survey ?? null,
  }));
  return { app: S.info?.version ?? null, exportedAt: new Date().toISOString(), tableSize: S.profile.settings.tableSize ?? 7, games, rivalry: S.profile.rivalry ?? {}, tally: tallies(S.profile) };
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
        ${a.planEnabled ? `<div class="plan-inline"><img src="../assets/chatgpt-logo-black.svg" alt="" />Using ChatGPT plan <button class="link" data-open="${USAGE_URL}">Manage usage</button></div>` : `<p class="warn">ChatGPT 플랜 사용이 허용되지 않았습니다.</p>${chatgptButton('Continue with ChatGPT', 'reconsent')}`}
        <div class="row"><button class="ghost" data-act="signOut">로그아웃</button><button class="ghost" data-act="signInNew">다른 계정 추가</button></div>`
        : `<p class="muted">로그인하지 않음</p>${chatgptButton()}`}
    </section>
    ${a.signedIn ? `<section><h3>AI 연결 점검</h3><p class="muted small">로그인부터 실제 응답까지 한 번에 확인합니다(아주 짧은 요청 1회).</p><button class="ghost" data-act="diagnose">점검하기</button><div id="diagOut">${S.diag ? diagHtml(S.diag) : ''}</div></section>` : ''}
    ${a.planEnabled ? `<section><h3>모델</h3><select id="modelSelect"><option>불러오는 중…</option></select><p class="muted small">빠른 모델일수록 판 템포가 좋아집니다.</p></section>` : ''}
    <section><h3>소리</h3>
      <label class="toggle"><input type="checkbox" id="sfxToggle" ${S.profile.settings.sfx !== false ? 'checked' : ''}/> 효과음</label>
      <label class="toggle"><input type="checkbox" id="musicToggle" ${S.profile.settings.music ? 'checked' : ''}/> 배경음 (조용한 패드)</label>
      <label class="toggle">볼륨 <input type="range" id="volume" min="0" max="1" step="0.05" value="${S.profile.settings.volume ?? 0.8}" /></label>
    </section>
    <section><h3>기억</h3>
      <label class="toggle"><input type="checkbox" id="memToggle" ${S.profile.settings.memory !== false ? 'checked' : ''}/> 라이벌이 지난 판을 기억함</label>
      <p class="muted small">끄면 라이벌이 지난 판을 참고하지 않습니다(비교용). 꺼진 상태로 한 판은 기억에 쌓이지 않습니다.</p>
      <button class="ghost danger" data-act="resetMemory">기억 초기화</button>
      ${S.profile.style?.count ? `<button class="ghost danger" data-act="resetStyle">멀티 말투 학습 지우기 (${S.profile.style.count}줄)</button>` : ''}
      <p class="muted small">저장되는 것은 게임 안 클릭 기록뿐이며 이 컴퓨터에만 있습니다.</p>
    </section>
    <section><h3>측정 (AI 사용 판 기준)</h3>
      <p class="small">판 수 ${games.length} · 판당 평균 ${avg(games, 'durationMs') === '—' ? '—' : Math.round(avg(games, 'durationMs') / 1000) + '초'} · 판당 입력 ${avg(games, 'inputTokens')} / 출력 ${avg(games, 'outputTokens')} 토큰 · 판당 호출 ${avg(games, 'calls')}회</p>
      <p class="small">응답 ${calls.length}회 · 첫 토큰까지 평균 ${avg(calls, 'ttftMs')}ms · 완료까지 평균 ${avg(calls, 'totalMs')}ms</p>
      ${bridge ? `<button class="ghost" data-act="exportMetrics">측정 기록 내보내기</button>` : ''}
      <button class="ghost" data-act="exportPlaytest">플레이테스트 기록 내보내기</button>
      <p class="muted small">판 결과·설문·텔 통계만 담깁니다(계정·토큰 없음).</p>
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
  sound.play('click');
  const a = b.dataset.act;
  const t = b.dataset.target;
  if (a === 'mBack') return multi.backToRoom();
  if (multi.isMultiAction(a)) return multi.onClick(a, b);
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
    case 'say-claim-bare':
      return doAct({ intent: 'claim' });
    case 'askPick':
      S.askTarget = t;
      return renderActions();
    case 'askCancel':
      S.askTarget = null;
      return renderActions();
    case 'ask':
      S.askTarget = null;
      return doAct({ type: 'ask', target: t, q: b.dataset.q });
    case 'tableSize':
      S.profile = { ...S.profile, settings: { ...S.profile.settings, tableSize: +b.dataset.n } };
      await store.save(S.profile);
      return renderTitle();
    case 'tipOk':
      S.profile = { ...S.profile, settings: { ...S.profile.settings, tipsSeen: { ...(S.profile.settings.tipsSeen || {}), [b.dataset.kind]: true } } };
      await store.save(S.profile);
      return renderActions();
    case 'verdict-yes':
      return doAct({ yes: true });
    case 'verdict-no':
      return doAct({ yes: false });
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
    case 'resetStyle':
      S.profile = { ...S.profile, style: null };
      await store.save(S.profile);
      return openSettings();
    case 'diagnose': {
      const out = $('#diagOut');
      if (out) out.innerHTML = '<span class="muted">점검 중…</span>';
      S.diag = await bridge.diagnose();
      if ($('#diagOut')) $('#diagOut').innerHTML = diagHtml(S.diag);
      return;
    }
    case 'copyDiag':
      return navigator.clipboard?.writeText(JSON.stringify(S.diag, null, 2));
    case 'exportPlaytest': {
      const blob = new Blob([JSON.stringify(playtestExport(), null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `second-read-playtest-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      return;
    }
    case 'survey': {
      const games = S.profile.games.slice();
      const last = { ...games[games.length - 1] };
      last.survey = { ...(last.survey || {}), [b.dataset.q]: b.dataset.v };
      games[games.length - 1] = last;
      S.profile = { ...S.profile, games };
      await store.save(S.profile);
      if (S.lastReport) S.lastReport.record = last;
      return renderReport();
    }
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
  if (['sfxToggle', 'musicToggle', 'volume'].includes(e.target.id)) {
    const v = e.target.id === 'volume' ? { volume: +e.target.value } : e.target.id === 'sfxToggle' ? { sfx: e.target.checked } : { music: e.target.checked };
    S.profile = { ...S.profile, settings: { ...S.profile.settings, ...v } };
    await store.save(S.profile);
    if (e.target.id === 'musicToggle') (e.target.checked ? sound.startPad() : sound.stopPad());
  }
});

$('#settingsBtn').addEventListener('click', () => {
  const d = $('#settings');
  if (d.classList.contains('hidden')) openSettings();
  else d.classList.add('hidden');
});

(async function init() {
  S.profile = await store.load();
  const habits = assignHabits(S.profile.aiHabits || {});
  if (JSON.stringify(habits) !== JSON.stringify(S.profile.aiHabits)) {
    S.profile = { ...S.profile, aiHabits: habits };
    await store.save(S.profile);
  }
  S.info = bridge ? await bridge.info() : null;
  await refreshAuth();
  renderTitle();
})();
