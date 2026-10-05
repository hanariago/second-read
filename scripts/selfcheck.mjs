// Drives the real app (main process + preload bridge) without a ChatGPT login:
// title, settings, one offline game through the bridge store, and the OAuth
// loopback listener. Run: SECOND_READ_SELFCHECK=<dir> npx electron .
import fs from 'node:fs';
import path from 'node:path';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function run(win, dir, app) {
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => fs.writeFileSync(path.join(dir, name + '.png'), (await win.webContents.capturePage()).toPNG());
  const has = (sel) => js(`!!document.querySelector(${JSON.stringify(sel)})`);
  const click = (sel) => js(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (b) { b.click(); return true; } return false; })()`);
  const log = (...a) => console.log('[selfcheck]', ...a);
  try {
    await wait(800);
    log('bridge present:', await js('!!window.secondRead'));
    log('auth status:', JSON.stringify(await js('window.secondRead.authStatus()')));
    const diag = await js('window.secondRead.diagnose()');
    log('diagnose (signed out):', diag.ok, diag.steps.map((s) => `${s.name}:${s.ok ? 'ok' : s.detail?.code}`).join(', '));
    await shot('a-title');
    await click('#settingsBtn');
    await wait(500);
    await shot('b-settings');
    await click('[data-act="closeSettings"]');
    await click('[data-act="offline"]');
    await wait(300);
    await click('[data-act="closeModal"]');
    for (let i = 0; i < 160 && !(await has('.report')); i++) {
      await wait(300);
      if (await has('[data-act="verdict-yes"]')) await click('[data-act="verdict-yes"]');
      else if (await has('[data-act="say-pass"]')) await click('[data-act="say-pass"]');
      else if (await has('[data-act="vote"]')) await click('[data-act="vote"]');
      else if (await has('[data-act="night"]')) await click('[data-act="night"]');
      else if (await has('[data-act="sleep"]')) await click('[data-act="sleep"]');
      else if (await has('[data-act="spectate"]')) await click('[data-act="spectate"]');
    }
    await wait(800);
    await shot('c-report');
    const prof = path.join(app.getPath('userData'), 'profile.json');
    log('profile.json written:', fs.existsSync(prof), fs.existsSync(prof) ? JSON.parse(fs.readFileSync(prof, 'utf8')).games.length + ' game(s)' : '');
    // OAuth loopback: start sign-in, hit the callback with a wrong state, expect rejection.
    await click('[data-act="title"]');
    await wait(400);
    await click('[data-act="signIn"]');
    await wait(1500);
    await shot('d-signing-in');
    const res = await fetch('http://127.0.0.1:1455/auth/callback?code=x&state=wrong');
    log('callback listener status:', res.status);
    await wait(800);
    log('title after bad callback:', (await js(`document.querySelector('.warn')?.innerText || ''`)) || '(none)');
    log('host id file:', fs.existsSync(path.join(app.getPath('userData'), 'auth', 'host.json')));
    await shot('e-after-callback');
  } catch (e) {
    log('ERROR', e.stack || e);
  }
  app.quit();
}
