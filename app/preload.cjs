// Narrow bridge between the game UI and the main process. No tokens cross it.
const { contextBridge, ipcRenderer } = require('electron');

const inv = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('secondRead', {
  authStatus: inv('auth:status'),
  signIn: inv('auth:signIn'),
  cancelSignIn: inv('auth:cancel'),
  signOut: inv('auth:signOut'),
  planWelcomeShown: inv('auth:planWelcomeShown'),
  models: inv('ai:models'),
  setModel: inv('ai:setModel'),
  complete: inv('ai:complete'),
  abort: inv('ai:abort'),
  profileLoad: inv('profile:load'),
  profileSave: inv('profile:save'),
  profileClear: inv('profile:clear'),
  metricsAppend: inv('metrics:append'),
  metricsLoad: inv('metrics:load'),
  metricsExport: inv('metrics:export'),
  open: inv('app:open'),
  info: inv('app:info'),
});
