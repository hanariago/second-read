// Dev helper: renders the UI offscreen (no ChatGPT bridge, template mode),
// clicks through games and saves screenshots. Usage: npx electron scripts/shot.mjs <outDir>
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] || path.join(root, 'shots');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'userdata'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1240, height: 820, show: false, webPreferences: { offscreen: true } });
  win.webContents.on('console-message', (e) => console.log('[renderer]', e.message));
  await win.loadFile(path.join(root, 'renderer', 'index.html'));
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
  const has = (sel) => js(`!!document.querySelector(${JSON.stringify(sel)})`);
  const click = (sel) => js(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (b) { b.click(); return true; } return false; })()`);
  await wait(500);
  await shot('01-title');
  // Scripted habit: as mafia accuse + vote first; as town pass + wait.
  const games = +(process.argv[3] || 4);
  for (let gnum = 1; gnum <= games; gnum++) {
    await click(gnum === 1 ? '[data-act="offline"]' : '[data-act="newGame"]');
    await wait(300);
    await shot(`g${gnum}-0-role`);
    await click('[data-act="closeModal"]');
    for (let step = 0; step < 40; step++) {
      await wait(250);
      if (await has('.report')) break;
      const mafia = await has('.my-role.mafia');
      if (await has('#say')) {
        const line = mafia ? '미오 좀 수상한데? 아까부터 말이 없음' : '음 난 아직 잘 모르겠어';
        await js(`(() => { const i = document.querySelector('#say'); i.value = ${JSON.stringify('')} + ${JSON.stringify('')}; i.value = ${JSON.stringify(line)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await wait(200);
        await shot(`g${gnum}-${String(step).padStart(2, '0')}-typing`);
        await click('[data-act="sayText"]');
        await wait(2600);
        await shot(`g${gnum}-${String(step).padStart(2, '0')}-statements`);
      } else if (gnum === 2 && (await has('[data-act="inputMode"][data-mode="text"]'))) {
        await click('[data-act="inputMode"][data-mode="text"]');
      } else if (await has('[data-act="say-accuse"]')) {
        await click(mafia ? '[data-act="say-accuse"]' : '[data-act="say-pass"]');
        await wait(2600);
        await shot(`g${gnum}-${String(step).padStart(2, '0')}-statements`);
      } else if (await has('[data-act="vote"]')) {
        if (!mafia) await wait(4800);
        await click('[data-act="vote"]');
        await wait(2600);
        await shot(`g${gnum}-${String(step).padStart(2, '0')}-vote`);
      } else if (await has('[data-act="night"]')) await click('[data-act="night"]');
      else if (await has('[data-act="sleep"]')) await click('[data-act="sleep"]');
      else if (await has('[data-act="spectate"]')) await click('[data-act="spectate"]');
    }
    await wait(800);
    await shot(`g${gnum}-9-report`);
  }
  await click('[data-act="title"]');
  await wait(300);
  await shot('99-title-after');
  app.quit();
});
