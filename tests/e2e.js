// End-to-end test against the live site.
//   cd tests && npm install && node e2e.js
// Alice runs the extension; Bob and Carol are plain participants in separate
// browser contexts (no extension). Votes are checked from Bob's screen, i.e.
// what the other participants actually see.
const puppeteer = require('puppeteer-core');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXT = path.join(__dirname, '..', 'extension');
const OUT = path.join(__dirname, 'out');
const BASE = 'https://www.scrumpoker-online.org/en';
const ALLOWED_HOST = /(^|\.)(scrumpoker-online\.org|firebaseio\.com|googleapis\.com|gstatic\.com)$/;
const CMP_HOST = /(^|\.)inmobi\.com$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

let step = 0;
const log = (m) => console.log(`[${String(++step).padStart(2, '0')}] ${m}`);

async function preparePage(page, label) {
  // Ads are blocked so the test only talks to the site and Firebase; page.allowCmp
  // lets the cookie consent banner load (Alice gets it, like a real visitor).
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    let ok = /^(data|blob|chrome-extension):/.test(u);
    try {
      const host = new URL(u).hostname;
      ok = ok || ALLOWED_HOST.test(host) || (page.allowCmp === true && CMP_HOST.test(host));
    } catch (_) {}
    if (ok) req.continue();
    else req.abort();
  });
  page.on('pageerror', (e) => console.log(`  [${label} pageerror] ${e.message}`));
}

async function clickButton(page, re) {
  const h = await page.waitForFunction(
    (src) => [...document.querySelectorAll('button')].find((b) => new RegExp(src, 'i').test(b.textContent.trim()) && !b.disabled && b.offsetParent) || null,
    { timeout: 30000, polling: 200 },
    re.source,
  );
  await h.asElement().click();
}

async function deleteEstimates(page) {
  await clickButton(page, /^delete estimates$/);
  const h = await page.waitForFunction(
    () => [...document.querySelectorAll('mat-dialog-container button')].find((b) => /^delete estimates$/i.test(b.textContent.trim())) || null,
    { timeout: 10000, polling: 200 },
  );
  await h.asElement().click();
}

async function typeInto(page, selector, text) {
  await page.waitForSelector(selector, { visible: true, timeout: 30000 });
  await page.click(selector, { clickCount: 3 });
  await page.type(selector, text, { delay: 15 });
}

async function dismissDialogs(page) {
  await sleep(300);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.cdk-overlay-container button')].find((x) => /got it/i.test(x.textContent));
    if (b) b.click();
  });
  await sleep(400);
}

async function createRoom(page, name) {
  await page.goto(`${BASE}/create-room`, { waitUntil: 'networkidle2', timeout: 60000 });
  await typeInto(page, 'input[required][minlength="2"]', name);
  await clickButton(page, /^create room$/);
  await page.waitForFunction(() => /\/room\/[^/]+\//.test(location.pathname), { timeout: 30000, polling: 200 });
  await page.waitForSelector('provide-estimate .flex-container > div', { timeout: 30000 });
  await dismissDialogs(page);
  return page.url().match(/\/room\/([^/]+)\//)[1];
}

async function joinRoom(page, roomId, name) {
  await page.goto(`${BASE}/room/${roomId}/scrum-poker`, { waitUntil: 'networkidle2', timeout: 60000 });
  await typeInto(page, 'input[required]', name);
  await clickButton(page, /^enter room$/);
  await page.waitForSelector('provide-estimate .flex-container > div', { timeout: 30000 });
  await dismissDialogs(page);
}

async function vote(page, value) {
  const ok = await page.evaluate((v) => {
    for (const el of document.querySelectorAll('provide-estimate .flex-container > div')) {
      const mid = el.querySelector('.middle');
      if (!mid) continue;
      const t = mid.querySelector('mat-icon') ? (mid.textContent.trim() === 'coffee' ? 'cof' : mid.textContent.trim()) : mid.textContent.trim();
      if (t === v) {
        el.querySelector('button').click();
        return true;
      }
    }
    return false;
  }, value);
  assert.ok(ok, `card ${value} exists`);
}

// The vote of `name` as rendered in `page`'s results table (null = no vote).
async function seenVote(page, name) {
  return page.evaluate((n) => {
    for (const tr of document.querySelectorAll('table tbody tr')) {
      const cell = tr.querySelector('td.mat-column-displayName');
      if (!cell) continue;
      const nm = [...cell.childNodes].filter((x) => x.nodeType === 3).map((x) => x.textContent).join('').trim();
      if (nm !== n) continue;
      const back = tr.querySelector('.flip-card-back');
      const t = back.textContent.trim();
      if (back.querySelector('mat-icon')) return t === 'coffee' ? 'cof' : t;
      return t === '' ? null : t;
    }
    return undefined;
  }, name);
}

async function waitVote(page, name, expected, timeoutMs = 10000) {
  const t0 = Date.now();
  let v;
  while (Date.now() - t0 < timeoutMs) {
    v = await seenVote(page, name);
    if (v === expected) return Date.now() - t0;
    await sleep(100);
  }
  throw new Error(`${name}: expected ${expected}, still ${v} after ${timeoutMs}ms`);
}

async function stays(page, name, expected, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await seenVote(page, name);
    assert.equal(v, expected, `${name} must stay ${expected}`);
    await sleep(150);
  }
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: process.env.HEADFUL ? false : true,
    pipe: true,
    enableExtensions: true,
    args: ['--window-size=1280,900'],
    defaultViewport: { width: 1280, height: 900 },
  });
  const extId = await browser.installExtension(EXT);
  log(`extension installed: ${extId}`);
  let dump = async () => {};
  let stopGuard = () => {};

  try {
    const alice = await browser.newPage();
    await preparePage(alice, 'alice');
    alice.allowCmp = true;
    const roomId = await createRoom(alice, 'Alice');
    log(`room ${roomId} created by Alice (extension user)`);

    const bob = await (await browser.createBrowserContext()).newPage();
    await preparePage(bob, 'bob');
    await joinRoom(bob, roomId, 'Bob');
    const carol = await (await browser.createBrowserContext()).newPage();
    await preparePage(carol, 'carol');
    await joinRoom(carol, roomId, 'Carol');
    log('Bob and Carol joined');

    assert.equal(await alice.evaluate(() => window.__spmHookInstalled === true), true, 'hook runs in the extension user tab');
    assert.equal(await bob.evaluate(() => window.__spmHookInstalled === true), false, 'no extension in Bob tab');

    // Extension page used as a remote control; it also puts Alice's tab in the background.
    const ext = await browser.newPage();
    await ext.goto(`chrome-extension://${extId}/popup.html`);
    const setSettings = (s) => ext.evaluate((x) => chrome.storage.local.set({ settings: x }), s);
    const state = () =>
      ext.evaluate(async () => {
        for (const t of await chrome.tabs.query({})) {
          const r = await new Promise((res) => chrome.tabs.sendMessage(t.id, { type: 'spm:getState' }, (x) => res(chrome.runtime.lastError ? null : x)));
          if (r && r.ok && r.roomId) return r;
        }
        return null;
      });
    dump = async () => {
      const st = await state().catch((e) => String(e));
      console.log('state at failure:', JSON.stringify(st, null, 1));
      console.log('banner open:', await alice.evaluate(() => document.body.innerText.includes('We value your privacy')).catch(() => '?'));
      await alice.screenshot({ path: path.join(OUT, 'failure-alice.png') }).catch(() => {});
    };
    const base = { enabled: true, mode: 'copy', trackName: 'Bob', rounding: 'nearest', timing: 'immediate', delayMin: 0, delayMax: 0 };

    // --- data source ---
    await sleep(500);
    let st = await state();
    assert.equal(st.roomId, roomId);
    assert.equal(st.source, 'ws', 'room data comes from the Firebase socket');
    assert.equal(st.selfName, 'Alice');
    assert.deepEqual(st.participants.map((p) => p.name + (p.isSelf ? '*' : '')).sort(), ['Alice*', 'Bob', 'Carol']);
    log('extension sees the room through Firebase (source=ws), self detected');

    // --- the cookie consent banner swallows every click on the page while open ---
    // It is loaded by the site's ad stack after a variable delay.
    const bannerOpen = () => alice.evaluate(() => document.body.innerText.includes('We value your privacy')).catch(() => false);
    const waitBanner = (ms) =>
      alice.waitForFunction(() => document.body.innerText.includes('We value your privacy'), { timeout: ms, polling: 500 }).then(() => true, () => false);
    // Closes it the privacy-preserving way: More options → Reject all → Save & exit.
    const dismissBanner = async () => {
      for (let i = 0; i < 8 && (await bannerOpen()); i++) {
        await alice
          .evaluate(() => {
            const btns = [...document.querySelectorAll('button')].filter((b) => b.offsetParent);
            const pick = (re) => btns.find((b) => re.test(b.textContent.trim()));
            const b = pick(/^reject all$/i) || pick(/^save & exit$/i) || pick(/^more options$/i);
            if (b) b.click();
          })
          .catch(() => {});
        await sleep(1000);
      }
      return !(await bannerOpen());
    };
    await setSettings(base);
    let bannerShown = await waitBanner(10000);
    if (!bannerShown) {
      await alice.reload({ waitUntil: 'networkidle2', timeout: 60000 });
      await alice.waitForSelector('provide-estimate .flex-container > div', { timeout: 30000 });
      bannerShown = await waitBanner(50000);
    }
    await ext.bringToFront();
    if (!bannerShown) {
      log('consent banner did not appear within 60s — banner phase skipped');
    } else {
      await vote(bob, '100');
      await stays(bob, 'Alice', null, 3000);
      st = await state();
      assert.equal(st.blocked, true, 'clicks swallowed by the banner are reported');
      assert.equal(st.gaveUp, false);
      log('consent banner open: the site swallows the click, extension reports "blocked"');
      assert.equal(await dismissBanner(), true, 'banner closed');
      const t = await waitVote(bob, 'Alice', '100');
      log(`banner closed (non-essential cookies rejected) → Alice 100 by herself in ${t}ms`);
    }
    // Safety net: a real user would close a late banner too.
    let lateBanners = 0;
    let guardBusy = false;
    const guard = setInterval(async () => {
      if (guardBusy) return;
      guardBusy = true;
      if (await bannerOpen()) {
        lateBanners++;
        await dismissBanner();
      }
      guardBusy = false;
    }, 1500);
    stopGuard = () => clearInterval(guard);

    // --- copy mode, before the reveal ---
    await setSettings(base);
    await vote(bob, '5');
    let ms = await waitVote(bob, 'Alice', '5');
    log(`copy: Bob 5 → Alice 5 in ${ms}ms (cards still hidden)`);
    assert.equal((await state()).revealed, false);

    await vote(bob, 'cof');
    ms = await waitVote(bob, 'Alice', 'cof');
    log(`copy: Bob ☕ → Alice ☕ in ${ms}ms`);

    await vote(bob, '13');
    ms = await waitVote(bob, 'Alice', '13');
    log(`copy: Bob 13 → Alice 13 in ${ms}ms`);

    // --- manual override is respected until the target changes ---
    await vote(alice, '3');
    await waitVote(bob, 'Alice', '3');
    await stays(bob, 'Alice', '3', 3500);
    st = await state();
    assert.equal(st.manualOverride, true);
    log('manual pick 3 by Alice is kept (not overwritten) while Bob stays on 13');
    await vote(bob, '8');
    ms = await waitVote(bob, 'Alice', '8');
    log(`copy: Bob changes to 8 → Alice 8 in ${ms}ms`);

    // --- new round via "Delete Estimates" ---
    await alice.bringToFront();
    await deleteEstimates(alice);
    await waitVote(bob, 'Bob', null);
    await waitVote(bob, 'Alice', null);
    await ext.bringToFront();
    await stays(bob, 'Alice', null, 3000);
    log('Delete Estimates: all votes cleared, Alice does not re-vote on her own');
    await vote(bob, '2');
    ms = await waitVote(bob, 'Alice', '2');
    log(`copy after clear: Bob 2 → Alice 2 in ${ms}ms`);

    // --- tracked participant not in the room ---
    await setSettings({ ...base, trackName: 'Zed' });
    await sleep(300);
    st = await state();
    assert.match(st.decision.problem, /не найден/);
    await stays(bob, 'Alice', '2', 1500);
    log('unknown nickname → status "не найден", vote untouched');

    // --- average mode ---
    await setSettings({ ...base, mode: 'average' });
    await vote(carol, '8'); // Bob 2, Carol 8 → 5
    ms = await waitVote(bob, 'Alice', '5');
    log(`average: (2+8)/2=5 → Alice 5 in ${ms}ms`);
    await vote(bob, '5'); // 5, 8 → 6.5 tie → up
    ms = await waitVote(bob, 'Alice', '8');
    log(`average: (5+8)/2=6.5 → nearest (tie up) 8 in ${ms}ms`);
    await setSettings({ ...base, mode: 'average', rounding: 'down' });
    ms = await waitVote(bob, 'Alice', '5');
    log(`average: rounding down → 5 in ${ms}ms`);
    await vote(carol, '?'); // only Bob's 5 counts
    await stays(bob, 'Alice', '5', 1500);
    await vote(carol, '20'); // 5, 20 → 12.5
    await setSettings({ ...base, mode: 'average', rounding: 'up' });
    ms = await waitVote(bob, 'Alice', '13');
    log(`average: (5+20)/2=12.5, "?" ignored, rounding up → 13 in ${ms}ms`);
    st = await state();
    assert.equal(st.myVote, '13');
    assert.match(st.decision.info, /12\.5/);

    // --- vote only after the reveal ---
    await alice.bringToFront();
    await deleteEstimates(alice);
    await waitVote(bob, 'Alice', null);
    await ext.bringToFront();
    await setSettings({ ...base, timing: 'reveal' });
    await vote(bob, '20');
    await stays(bob, 'Alice', null, 3000);
    st = await state();
    assert.equal(st.waitingReveal, true);
    log('timing=reveal: Bob voted 20, Alice waits while cards are hidden');
    await alice.bringToFront();
    await clickButton(alice, /^show$/);
    await ext.bringToFront();
    ms = await waitVote(bob, 'Alice', '20');
    log(`timing=reveal: cards shown → Alice 20 in ${ms}ms`);

    // --- disabled ---
    await setSettings({ ...base, enabled: false });
    await vote(bob, '40');
    await stays(bob, 'Alice', '20', 3000);
    log('disabled: Bob 40, Alice stays 20');

    // --- popup UI against the live tab ---
    await setSettings({ ...base, trackName: 'Bob' });
    await waitVote(bob, 'Alice', '40');
    await alice.bringToFront();
    await ext.reload();
    await sleep(1500);
    const popup = await ext.evaluate(() => ({
      status: document.getElementById('statusLine').textContent,
      people: [...document.querySelectorAll('#people li')].map((li) => li.textContent),
      tracked: document.querySelector('#people li.tracked')?.textContent,
    }));
    await ext.setViewport({ width: 360, height: 640 });
    await ext.screenshot({ path: path.join(OUT, 'popup.png'), fullPage: true });
    console.log('    popup:', JSON.stringify(popup));
    assert.equal(popup.status, 'Стоит 40 ✓');
    assert.equal(popup.tracked, 'Bob40');
    log('popup shows the live room state');
    await ext.setViewport({ width: 1280, height: 900 });

    // --- reload keeps working ---
    await alice.reload({ waitUntil: 'networkidle2', timeout: 60000 });
    await alice.waitForSelector('provide-estimate .flex-container > div', { timeout: 30000 });
    await ext.bringToFront();
    await sleep(800);
    assert.equal((await state()).source, 'ws');
    await vote(bob, '1');
    ms = await waitVote(bob, 'Alice', '1');
    log(`after page reload: Bob 1 → Alice 1 in ${ms}ms`);

    // --- the page swallows clicks (what the cookie consent banner does while open) ---
    await alice.evaluate(() => {
      window.__wall = (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
      };
      document.addEventListener('click', window.__wall, true);
    });
    await vote(bob, '0.5');
    await stays(bob, 'Alice', '1', 3000);
    st = await state();
    assert.equal(st.blocked, true, 'blocked click is reported');
    assert.equal(st.gaveUp, false, 'blocked clicks do not use up attempts');
    await sleep(4000);
    assert.equal((await state()).gaveUp, false);
    await alice.evaluate(() => document.removeEventListener('click', window.__wall, true));
    ms = await waitVote(bob, 'Alice', '0.5');
    log(`click wall: reported as blocked, voted 0.5 ${ms}ms after the wall was removed`);

    // --- fallback: no WebSocket at all (Firebase falls back to long polling) ---
    await ext.evaluate(() => chrome.storage.local.remove('selfName'));
    await alice.evaluateOnNewDocument(() => {
      window.WebSocket = undefined;
    });
    await alice.reload({ waitUntil: 'networkidle2', timeout: 60000 });
    await alice.waitForSelector('provide-estimate .flex-container > div', { timeout: 30000 });
    await alice.waitForFunction(() => document.querySelectorAll('table tbody tr').length >= 3, { timeout: 30000, polling: 300 });
    await ext.bringToFront();
    await sleep(800);
    st = await state();
    assert.equal(st.source, 'dom', 'falls back to the results table');
    assert.equal(st.firebaseSeen, false);
    log('no WebSocket: extension switched to the results table (source=dom)');

    await vote(bob, '3');
    ms = await waitVote(bob, 'Alice', '3');
    log(`fallback copy: Bob 3 → Alice 3 in ${ms}ms`);

    await setSettings({ ...base, mode: 'average' });
    await vote(carol, '8');
    await vote(bob, '5');
    // Own 3 must not count: (5+8)/2 = 6.5 → 8; with it, (3+5+8)/3 = 5.33 → 5.
    ms = await waitVote(bob, 'Alice', '8');
    await stays(bob, 'Alice', '8', 2500);
    log(`fallback average without knowing own nickname: 6.5 → 8 in ${ms}ms, stable`);

    await alice.bringToFront();
    await deleteEstimates(alice);
    await waitVote(bob, 'Alice', null);
    await ext.bringToFront();
    await setSettings({ ...base, timing: 'reveal' });
    await vote(bob, '13');
    await stays(bob, 'Alice', null, 2500);
    await alice.bringToFront();
    await clickButton(alice, /^show$/);
    await ext.bringToFront();
    ms = await waitVote(bob, 'Alice', '13');
    log(`fallback timing=reveal: waits, then Alice 13 in ${ms}ms after Show`);

    stopGuard();
    if (lateBanners) console.log(`(a late consent banner was closed ${lateBanners}x by the test)`);
    console.log('\nE2E PASSED');
  } catch (e) {
    await dump();
    throw e;
  } finally {
    stopGuard();
    await browser.close();
  }
})().catch((e) => {
  console.error('\nE2E FAILED:', e);
  process.exit(1);
});
