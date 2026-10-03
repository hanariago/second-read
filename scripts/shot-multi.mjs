// Dev helper: two offscreen app windows play a multiplayer room against a local
// relay (wrangler dev) and save screenshots. Usage: npx electron scripts/shot-multi.mjs <outDir>
import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] || path.join(root, 'shots-multi');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'userdata'));
const PORT = 8798;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const relay = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--log-level', 'warn'], { cwd: path.join(root, 'server'), stdio: 'ignore' });

app.whenReady().then(async () => {
  try {
    for (let i = 0; i < 120; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break;
      } catch {}
      await wait(500);
    }
    const mk = async (part) => {
      const w = new BrowserWindow({ width: 1240, height: 820, show: false, webPreferences: { offscreen: true, partition: `persist:${part}` } });
      w.webContents.on('console-message', (e) => e.level === 'error' && console.log(`[${part}]`, e.message));
      await w.loadFile(path.join(root, 'renderer', 'index.html'));
      return w;
    };
    const A = await mk('p1');
    const B = await mk('p2');
    const js = (w, code) => w.webContents.executeJavaScript(code);
    // Window A plays as a signed-in player with a canned model, so it writes rival lines.
    await js(A, `localStorage.setItem('second-read.devFakeAI', '1')`);
    await A.webContents.reload();
    await wait(800);
    const has = (w, sel) => js(w, `!!document.querySelector(${JSON.stringify(sel)})`);
    const click = (w, sel) => js(w, `(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (b) { b.click(); return true; } return false; })()`);
    const setVal = (w, sel, v) => js(w, `(() => { const i = document.querySelector(${JSON.stringify(sel)}); if (!i) return; i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    const shot = async (w, name) => fs.writeFileSync(path.join(out, name + '.png'), (await w.webContents.capturePage()).toPNG());
    await wait(600);
    for (const [w, nm] of [[A, '레나'], [B, '친구']]) {
      await click(w, '[data-act="mOpen"]');
      await wait(200);
      await setVal(w, '#mName', nm);
      await js(w, `document.querySelector('details') && (document.querySelector('details').open = true)`);
      await setVal(w, '#mRelay', `http://127.0.0.1:${PORT}`);
    }
    await shot(A, 'm1-lobby-form');
    await click(A, '[data-act="mCreate"]');
    await wait(800);
    const code = await js(A, `document.querySelector('.room-code b')?.textContent`);
    console.log('room code', code);
    await setVal(B, '#mCode', code);
    await click(B, '[data-act="mJoin"]');
    await wait(800);
    await shot(A, 'm2-room');
    await click(A, '[data-act="mStart"]');
    await wait(800);
    await shot(A, 'm3-role');
    await click(A, '[data-act="closeModal"]');
    await click(B, '[data-act="closeModal"]');
    const lines = { A: ['음 다들 반가워 ㅋㅋ', '아까 그 사람 좀 이상한데', '난 시민임 진짜'], B: ['ㅎㅇ', '누구 찍지', '모르겠다 ㅋㅋ'] };
    let n = 0;
    for (let step = 0; step < 200; step++) {
      await wait(300);
      if ((await has(A, 'table.reveal')) && (await has(B, 'table.reveal'))) break;
      for (const [w, k] of [[A, 'A'], [B, 'B']]) {
        if (await has(w, '#mSay')) {
          if (k === 'B' && n % 3 === 2) await click(w, '[data-act="mSkip"]');
          else {
            await setVal(w, '#mSay', lines[k][n % 3]);
            if (k === 'A' && n === 0) await shot(A, 'm4-composer');
            await click(w, '[data-act="mSend"]');
          }
          if (k === 'B') n++;
        } else if (await has(w, '[data-act="mVerdictYes"]')) {
          if (k === 'A') await shot(A, `m5-verdict-${step}`);
          await click(w, '[data-act="mVerdictYes"]');
        } else if (await has(w, '[data-act="mVote"]')) {
          await click(w, '[data-act="mVote"]');
        } else if (await has(w, '[data-act="mNight"]')) await click(w, '[data-act="mNight"]');
      }
      if (step === 5) await shot(A, 'm5-play');
      if (step === 9) {
        await shot(B, 'm6-play-b');
        console.log('fake-AI lines seen by B so far:', await js(B, `(document.querySelector('#feed')?.innerText.match(/\\(fake\\)/g) || []).length`));
      }
    }
    await wait(500);
    await shot(A, 'm7-over');
    await click(A, '[data-act="mReport"]');
    await wait(500);
    await shot(A, 'm8-report');
    const style = await js(A, `JSON.parse(localStorage.getItem('second-read.profile') || '{}').style?.count ?? 0`);
    console.log('style lines learned (A):', style);
  } catch (e) {
    console.error(e);
  }
  relay.kill('SIGTERM');
  app.quit();
});
