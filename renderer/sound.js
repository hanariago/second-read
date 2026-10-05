// Sound: short CC0 effects (Kenney) and an optional generated background pad.
// Audio starts only after the first click (browsers block it before that).

const FILES = ['click', 'line', 'vote', 'card', 'role', 'read', 'trial', 'execute', 'win', 'lose', 'predict', 'ask', 'night'];
const VOLUME = { click: 0.35, line: 0.25, vote: 0.5, card: 0.6, role: 0.6, read: 0.55, trial: 0.5, execute: 0.6, win: 0.6, lose: 0.5, predict: 0.6, ask: 0.45, night: 0.4 };

export function createSound(getSettings) {
  const pool = {};
  let unlocked = false;
  let ctx = null;
  let pad = null;

  function unlock() {
    if (unlocked) return;
    unlocked = true;
    for (const n of FILES) {
      const a = new Audio(`../assets/sfx/${n}.ogg`);
      a.preload = 'auto';
      pool[n] = a;
    }
    if (getSettings().music) startPad();
  }

  function play(name) {
    const s = getSettings();
    if (!unlocked || s.sfx === false) return;
    const base = pool[name];
    if (!base) return;
    const a = base.cloneNode();
    a.volume = Math.min(1, (VOLUME[name] ?? 0.5) * (s.volume ?? 0.8));
    a.play().catch(() => {});
  }

  // A slow, quiet four-chord pad: warm late-night cafe, never in the way.
  function startPad() {
    if (pad) return;
    try {
      ctx = ctx || new AudioContext();
    } catch {
      return;
    }
    const out = ctx.createGain();
    out.gain.value = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    filter.connect(out);
    out.connect(ctx.destination);
    const chords = [
      [261.63, 329.63, 392.0, 493.88],
      [220.0, 261.63, 329.63, 392.0],
      [174.61, 220.0, 261.63, 329.63],
      [196.0, 246.94, 293.66, 392.0],
    ];
    const voices = chords[0].map(() => {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      const g = ctx.createGain();
      g.gain.value = 0.18;
      o.connect(g);
      g.connect(filter);
      o.start();
      return o;
    });
    let i = 0;
    const step = () => {
      const t = ctx.currentTime;
      chords[i % chords.length].forEach((f, k) => voices[k].frequency.setTargetAtTime(f / 2, t, 1.2));
      i++;
    };
    step();
    const timer = setInterval(step, 6000);
    out.gain.setTargetAtTime(0.035 * (getSettings().volume ?? 0.8), ctx.currentTime, 2);
    pad = { out, voices, timer, filter };
  }

  function stopPad() {
    if (!pad) return;
    clearInterval(pad.timer);
    pad.out.gain.setTargetAtTime(0, ctx.currentTime, 0.4);
    const p = pad;
    pad = null;
    setTimeout(() => p.voices.forEach((o) => o.stop()), 1500);
  }

  // Night darkens the pad a little.
  function mood(night) {
    if (pad) pad.filter.frequency.setTargetAtTime(night ? 500 : 900, ctx.currentTime, 1.5);
  }

  document.addEventListener('pointerdown', unlock, { once: false, capture: true });
  return { play, startPad, stopPad, mood, unlock };
}
