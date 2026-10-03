// Tell storage layer. The game only talks to this interface:
//   load() -> Promise<profile>, save(profile) -> Promise<void>, clear() -> Promise<void>
// Desktop builds persist through the Electron bridge; a future browser build
// can swap in the localStorage store without touching game logic.

import { emptyProfile, normalizeProfile } from '../core/profile.js';

export function createMemoryStore(initial = emptyProfile()) {
  let p = initial;
  return {
    load: async () => structuredClone(p),
    save: async (next) => {
      p = structuredClone(next);
    },
    clear: async () => {
      p = emptyProfile();
    },
  };
}

export function createLocalStorageStore(key = 'second-read.profile') {
  return {
    async load() {
      try {
        return normalizeProfile(JSON.parse(localStorage.getItem(key)));
      } catch {
        return emptyProfile();
      }
    },
    async save(p) {
      localStorage.setItem(key, JSON.stringify(p));
    },
    async clear() {
      localStorage.removeItem(key);
    },
  };
}

// bridge = window.secondRead (preload). Profile JSON lives in the app's
// user-data folder on this machine only.
export function createBridgeStore(bridge) {
  return {
    load: async () => normalizeProfile(await bridge.profileLoad()),
    save: (p) => bridge.profileSave(p),
    clear: () => bridge.profileClear(),
  };
}
