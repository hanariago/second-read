// Electron main process: owns credentials, network calls to OpenAI, and the
// local files (profile of tells, metrics, settings). The renderer only gets
// game-level results through the preload bridge.

import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuth, AuthError } from './auth.mjs';
import { listModels, defaultModel, streamResponse } from './openai.mjs';
import { readJson, writeJsonAtomic, removeFile } from './files.mjs';

const APP_NAME = 'Second Read';
const REPO_URL = 'https://github.com/hanariago/second-read';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

app.setName(APP_NAME);
// Dev self-check (scripts/selfcheck.mjs): isolated data folder, no real browser.
const SELFCHECK = process.env.SECOND_READ_SELFCHECK || null;
if (SELFCHECK) app.setPath('userData', path.join(SELFCHECK, 'userdata'));
// Dev: SECOND_READ_PROFILE=<name> runs a second, separate copy (local multiplayer testing).
const DEV_PROFILE = process.env.SECOND_READ_PROFILE?.replace(/[^\w-]/g, '') || null;
if (DEV_PROFILE) app.setPath('userData', path.join(app.getPath('appData'), `Second Read (${DEV_PROFILE})`));
if (!DEV_PROFILE && !app.requestSingleInstanceLock()) app.quit();

const userDir = () => app.getPath('userData');
const files = {
  profile: () => path.join(userDir(), 'profile.json'),
  metrics: () => path.join(userDir(), 'metrics.json'),
  settings: () => path.join(userDir(), 'settings.json'),
};

const EXTERNAL_OK = [
  'https://chatgpt.com/settings/usage',
  'https://help.openai.com',
  REPO_URL,
  'https://auth.openai.com/',
];
const openExternal = (url) => {
  if (!EXTERNAL_OK.some((p) => url.startsWith(p))) throw new Error('blocked url');
  if (SELFCHECK) return console.log('[selfcheck] openExternal', new URL(url).origin + new URL(url).pathname);
  return shell.openExternal(url);
};

const log = (msg, data) => console.log(`[second-read] ${msg}`, data ?? '');
let auth;
let win;
const inflight = new Map();

async function settings() {
  return (await readJson(files.settings())) || {};
}
async function patchSettings(patch) {
  const next = { ...(await settings()), ...patch };
  await writeJsonAtomic(files.settings(), next);
  return next;
}

async function resolveModel(token) {
  const s = await settings();
  if (s.model) return s.model;
  const models = await listModels(token);
  const m = defaultModel(models);
  if (!m) throw Object.assign(new Error('no_models'), { code: 'no_models' });
  await patchSettings({ model: m.slug });
  return m.slug;
}

const errOut = (e) => ({
  ok: false,
  error: { code: e?.code || e?.name || 'error', fatal: !!e?.fatal || e?.code === 'reauth_required' || e?.code === 'signed_out' || e?.code === 'plan_not_enabled', message: e?.message, requestId: e?.requestId ?? null },
});

const EFFORT_LADDER = ['minimal', 'low'];

async function complete(id, req) {
  const ctrl = new AbortController();
  inflight.set(id, ctrl);
  try {
    let token = await auth.accessToken();
    const model = await resolveModel(token);
    const s = await settings();
    const dropped = new Set(s.dropped?.[model] || []);
    let refreshed = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      // Lowest reasoning effort the model accepts keeps lines fast and cheap: minimal -> low -> omitted.
      const effort = EFFORT_LADDER[s.effortStep?.[model] ?? 0];
      const extra = effort ? { reasoning: { effort } } : {};
      const schema = dropped.has('text') ? null : req.schema;
      try {
        const res = await streamResponse({ token, model, instructions: req.instructions, input: req.input, schema, extra, signal: ctrl.signal });
        return { ok: true, ...res };
      } catch (e) {
        const top = String(e.param ?? '').split('.')[0];
        if (top === 'reasoning' && (e.code === 'subscription_sharing_unsupported_capability' || e.status === 400)) {
          const step = (s.effortStep?.[model] ?? 0) + 1;
          if (step < EFFORT_LADDER.length + 1) {
            s.effortStep = { ...(s.effortStep || {}), [model]: step };
            await patchSettings({ effortStep: s.effortStep });
            log('reasoning effort step', step);
            continue;
          }
        }
        const droppable = top === 'text' && !dropped.has(top);
        if (droppable && (e.code === 'subscription_sharing_unsupported_capability' || e.status === 400)) {
          dropped.add(top);
          await patchSettings({ dropped: { ...(s.dropped || {}), [model]: [...dropped] } });
          log('dropped unsupported field', top);
          continue;
        }
        if (e.status === 401 && !refreshed && !e.fatal) {
          token = await auth.accessToken({ force: true });
          refreshed = true;
          continue;
        }
        throw e;
      }
    }
    throw new Error('retry_exhausted');
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, error: { code: 'aborted' } };
    log('ai error', { code: e.code, status: e.status, requestId: e.requestId });
    return errOut(e);
  } finally {
    inflight.delete(id);
  }
}

// "AI 연결 점검": one tiny real request through the whole path, so a first
// login can be verified in seconds. The report never contains tokens.
async function diagnose() {
  const steps = [];
  const step = async (name, fn) => {
    const t0 = Date.now();
    try {
      const detail = await fn();
      steps.push({ name, ok: true, ms: Date.now() - t0, detail });
      return detail;
    } catch (e) {
      steps.push({ name, ok: false, ms: Date.now() - t0, detail: { code: e.code || e.name, status: e.status ?? null, message: String(e.message || '').slice(0, 200), requestId: e.requestId ?? null } });
      return null;
    }
  };
  const status = await step('로그인 상태', async () => {
    const s = await auth.status();
    if (!s.signedIn) throw Object.assign(new Error('로그인되어 있지 않습니다'), { code: 'signed_out' });
    if (!s.planEnabled) throw Object.assign(new Error('ChatGPT 플랜 사용 권한이 없습니다'), { code: 'plan_not_enabled' });
    return { planEnabled: true };
  });
  let token = null;
  // The token itself never goes into the report.
  if (status) {
    await step('토큰 갱신', async () => {
      token = await auth.accessToken({ force: true });
      return { refreshed: true };
    });
  }
  let model = null;
  if (token) {
    const models = await step('모델 목록', async () => {
      const list = await listModels(token);
      return { count: list.length, first: list.slice(0, 5).map((m) => m.slug) };
    });
    if (models) model = await step('사용할 모델', async () => ({ slug: await resolveModel(token) }));
  }
  if (model) {
    await step('응답 생성 (스트리밍)', async () => {
      const r = await complete('diagnose', {
        instructions: 'Reply with JSON only.',
        input: [{ role: 'user', content: '{"speakers":[{"speaker_id":"leon","intent":"pass"}]}' }],
        schema: { type: 'json_schema', name: 'rival_lines', strict: true, schema: { type: 'object', additionalProperties: false, required: ['lines'], properties: { lines: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['speaker_id', 'text', 'evidence_ids'], properties: { speaker_id: { type: 'string' }, text: { type: 'string' }, evidence_ids: { type: 'array', items: { type: 'string' } } } } } } } },
      });
      if (!r.ok) throw Object.assign(new Error(r.error?.message || r.error?.code), { code: r.error?.code });
      let parsed = false;
      try {
        parsed = Array.isArray(JSON.parse(r.text).lines);
      } catch {
        /* not JSON */
      }
      const s = await settings();
      return { model: r.model, ttftMs: r.ttftMs, totalMs: r.totalMs, usage: r.usage, jsonOk: parsed, reasoningStep: s.effortStep?.[model.slug] ?? 0, droppedFields: s.dropped?.[model.slug] ?? [] };
    });
  }
  const report = { at: new Date().toISOString(), app: app.getVersion(), platform: process.platform, ok: steps.every((s) => s.ok), steps };
  await writeJsonAtomic(path.join(userDir(), 'diagnostics.json'), report);
  return report;
}

function registerIpc() {
  const h = (ch, fn) => ipcMain.handle(ch, (_e, ...args) => fn(...args));
  h('auth:status', () => auth.status());
  h('auth:signIn', async (opts) => {
    try {
      return { ok: true, status: await auth.signIn(opts) };
    } catch (e) {
      log('sign-in failed', e.code || e.message);
      return { ok: false, error: { code: e instanceof AuthError ? e.code : 'sign_in_failed', message: e.message } };
    }
  });
  h('auth:cancel', () => auth.cancelSignIn());
  h('auth:signOut', async () => {
    await patchSettings({ model: null });
    return auth.signOut();
  });
  h('auth:planWelcomeShown', () => auth.markPlanWelcomeShown());

  h('ai:models', async () => {
    try {
      const token = await auth.accessToken();
      const models = await listModels(token);
      const s = await settings();
      return { ok: true, models, selected: s.model || defaultModel(models)?.slug || null };
    } catch (e) {
      return errOut(e);
    }
  });
  h('ai:setModel', (slug) => patchSettings({ model: slug }));
  h('ai:diagnose', () => diagnose());
  h('ai:complete', (id, req) => complete(id, req));
  h('ai:abort', (id) => inflight.get(id)?.abort());

  h('profile:load', () => readJson(files.profile()));
  h('profile:save', (p) => writeJsonAtomic(files.profile(), p));
  h('profile:clear', () => removeFile(files.profile()));

  h('metrics:append', async (entry) => {
    const m = (await readJson(files.metrics())) || [];
    m.push({ ...entry, at: new Date().toISOString() });
    await writeJsonAtomic(files.metrics(), m.slice(-1000));
  });
  h('metrics:load', async () => (await readJson(files.metrics())) || []);
  h('metrics:export', async () => {
    const m = (await readJson(files.metrics())) || [];
    const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: 'second-read-metrics.json' });
    if (canceled || !filePath) return false;
    await writeJsonAtomic(filePath, m);
    return true;
  });

  h('app:open', (url) => openExternal(url));
  h('app:info', () => ({ version: app.getVersion(), repo: REPO_URL, platform: process.platform }));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 660,
    backgroundColor: '#f7f4ee',
    title: APP_NAME,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu?.();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(root, 'renderer', 'index.html'));
  if (SELFCHECK) {
    win.webContents.on('console-message', (e) => console.log('[renderer]', e.message));
    win.webContents.once('did-finish-load', () => import('../scripts/selfcheck.mjs').then((m) => m.run(win, SELFCHECK, app)));
  }
}

app.whenReady().then(() => {
  auth = createAuth({ dir: path.join(userDir(), 'auth'), appName: APP_NAME, openExternal, log });
  registerIpc();
  createWindow();
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
});
app.on('window-all-closed', () => app.quit());
