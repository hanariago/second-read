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
if (!app.requestSingleInstanceLock()) app.quit();

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
  'https://auth.openai.com/api/accounts/authorize',
];
const openExternal = (url) => {
  if (!EXTERNAL_OK.some((p) => url.startsWith(p))) throw new Error('blocked url');
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

async function complete(id, req) {
  const ctrl = new AbortController();
  inflight.set(id, ctrl);
  try {
    let token = await auth.accessToken();
    const model = await resolveModel(token);
    const s = await settings();
    const dropped = new Set(s.dropped?.[model] || []);
    let refreshed = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      // Low reasoning effort keeps rival lines fast; dropped automatically if the model rejects it.
      const extra = dropped.has('reasoning') ? {} : { reasoning: { effort: 'low' } };
      const schema = dropped.has('text') ? null : req.schema;
      try {
        const res = await streamResponse({ token, model, instructions: req.instructions, input: req.input, schema, extra, signal: ctrl.signal });
        return { ok: true, ...res };
      } catch (e) {
        if (e.code === 'subscription_sharing_unsupported_capability' && e.param) {
          const top = String(e.param).split('.')[0];
          if (!['reasoning', 'text'].includes(top) || dropped.has(top)) throw e;
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
    backgroundColor: '#0f1115',
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
