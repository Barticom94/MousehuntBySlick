// Mock-only smoke test: loads dist/ into headless Chromium on a stubbed MouseHunt page (no live game, no network).
// Needs Playwright (not a dependency of this repo): `npm i -g playwright` or run where it is preinstalled.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(`${process.env.NODE_PATH || '/usr/lib/node_modules'}/playwright`)); }

const script = readFileSync(new URL('../dist/MHbS.js', import.meta.url), 'utf8');

const PAGE = `<!doctype html><html><body>
<div class="mousehuntHeaderView-gameTabs"><div class="mousehuntHeaderView-dropdownContainer"></div></div>
<div class="mousehuntHud-gameInfo"></div>
<div id="mousehuntContainer">
  <div class="huntersHornView__horn huntersHornView__horn--reveal"></div>
  <div class="huntersHornView__message"></div>
  <div class="huntersHornView__timerState--type-countdown">15:00</div>
</div></body></html>`;

// Game globals the modules expect. Stubs record what the script does with them.
const GAME_STUBS = () => {
  window.user = { user_id: 4242, unique_hash: 'hash' };
  window.callbackurl = 'https://www.mousehuntgame.com/';
  window.__ajaxHandlers = [];
  window.eventRegistry = { addEventListener: (ev, fn, a, b, c, id) => { if (ev === 'ajax_response') window.__ajaxHandlers.push({ id, fn }); } };
  window.__dialogs = [];
  window.jsDialog = class { setIsModal() {} setTemplate() {} addToken(k, v) { (this.t ||= {})[k] = v; } setAttributes(a) { this.a = a; } show() { window.__dialogs.push(this); } };
  window.__claims = [];
  window.hg = { utils: {
    UserInventory: { getItems: (types, ok) => ok(types.map((t, i) => ({ type: t, item_id: 100 + i, classification: 'crafting_item' }))) },
    SocialGift: { claimGift: (id, hash, ok) => { window.__claims.push([id, hash]); ok(); } },
  }, views: {} };
  window.__hornEvents = [];
  document.querySelector('.huntersHornView__horn').addEventListener('mousedown', () => window.__hornEvents.push('down'));
  document.querySelector('.huntersHornView__horn').addEventListener('mouseup', () => window.__hornEvents.push('up'));
};

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.route('https://www.mousehuntgame.com/**', (r) => r.fulfill({ contentType: 'text/html', body: PAGE }));
await page.route('https://api.markethunt.win/**', (r) => r.fulfill({ json: [{ item_info: { item_id: 100, currently_tradeable: true }, latest_market_data: { price: 500, sb_price: 1.5, date: '2026-01-01' } }] }));
await page.route('https://api.mouse.rip/**', (r) => r.fulfill({ json: { links: [] } }));

const load = async () => {
  await page.goto('https://www.mousehuntgame.com/');
  await page.evaluate(GAME_STUBS);
  await page.addScriptTag({ content: script });
};
const panel = (sel) => page.locator(`#mhs-root ${sel}`); // playwright pierces open shadow roots
let n = 0;
const step = (name) => console.log(`ok ${++n} - ${name}`);

// Pre-seed what the standalone scripts left behind: Auto Horn settings, and a claimable MH Improved gift link.
await page.goto('https://www.mousehuntgame.com/');
await page.evaluate(() => {
  localStorage.setItem('mh_auto_horn_cfg_v1', JSON.stringify({ hornDelayMin: 1, hornDelayMax: 2, krRetryLimit: 5 }));
  localStorage.setItem('mh-improved-gift-links-cache-v1', JSON.stringify({ attemptedAt: Date.now(), links: [{ code: 'abc', url: 'https://x.test/abc', gift: { id: 'g1', hash: 'h1', name: 'Gift' } }] }));
});
await load();

// 1. Panel and modules
await panel('.launcher').click();
assert.equal(await panel('.card').count(), 4);
assert.deepEqual(await panel('.switch').evaluateAll((els) => els.map((e) => e.getAttribute('aria-checked'))), ['true', 'true', 'true', 'true']);
step('panel lists four modules, all on');

// 2. Migrated horn settings
await panel('[data-mod=auto-horn] summary').click();
assert.equal(await panel('#f-auto-horn-hornDelayMax').inputValue(), '2');
assert.equal(await panel('#f-auto-horn-krRetryLimit').inputValue(), '5');
step('horn settings migrated from the standalone script');

// 3. Horn: sounds, then waits with a delay inside the configured range (1-2 s)
await page.waitForFunction(() => window.__hornEvents.join() === 'down,up', null, { timeout: 8000 });
await page.waitForFunction(() => document.querySelector('#mhs-root').shadowRoot.querySelector('[data-status=auto-horn]').textContent.startsWith('Waiting for next horn'), null, { timeout: 8000 });
step('horn sounded and status shows the next horn time');

// 4. Loot log: pure parsing, ajax capture, popup
const parsed = await page.evaluate(() => window.mhLootLog.parseEntry({ css_class: 'entry short catchsuccess active', text: 'I caught a Mouse worth 10 points and 20 gold! My hunt dropped the following loot: 3 <a href="item.php?item_type=cheese_pie">Pies</a>', mouse_type: 'mouse' }));
assert.equal(parsed.kind, 'catch'); assert.equal(parsed.gold, 20); assert.equal(parsed.loot[0].qty, 3);
await page.evaluate(() => {
  const ts = Math.floor(Date.now() / 1000);
  const h = window.__ajaxHandlers.find((x) => x.id === 'mhll-loot-log-ajax');
  h.fn({ journal_markup: [{ render_data: { entry_id: 9001, entry_timestamp: ts, css_class: 'entry short catchsuccess active', environment: 'Meadow', mouse_type: 'mouse', entry_date: '3:45 pm - ',
    text: 'I caught a Mouse worth 10 points and 20 gold! My hunt dropped the following loot: 3 <a href="item.php?item_type=cheese_pie">Pies</a>' } }] });
});
await page.waitForFunction(() => document.querySelector('#mhs-root').shadowRoot.querySelector('[data-status=loot-log]').textContent.startsWith('1 journal entry'), null, { timeout: 8000 }).catch(() => {});
await page.locator('#mhll-menu').click();
await page.waitForFunction(() => window.__dialogs.length === 1);
const html = await page.evaluate(() => window.__dialogs[0].t['{*content*}']);
assert.match(html, /Pies/); assert.match(html, /mhll-tabs/);
step('loot log captured an entry and the popup shows its loot');

// 5. Gift links: pill, claim all
assert.match(await page.locator('#mhll-gift-alert').textContent(), /1 gift link/);
await page.locator('#mhll-gift-alert [data-mhll-claim]').click();
await page.waitForFunction(() => window.__claims.length === 1);
assert.deepEqual(await page.evaluate(() => window.__claims[0]), ['g1', 'h1']);
await page.waitForFunction(() => !document.getElementById('mhll-gift-alert'));
step('gift pill appears and Claim all claims through the game helper');

// 6. Toggling a module removes and restores its pieces, and persists
await panel('[data-mod=loot-log] .switch').click();
await page.waitForFunction(() => !document.getElementById('mhll-menu') && !document.querySelector('[id^="mhs-loot-log-style"]'));
assert.equal(await panel('[data-status=loot-log]').textContent(), 'Off');
const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('mhs-settings-v1')));
assert.equal(saved['loot-log'].enabled, false);
await panel('[data-mod=loot-log] .switch').click();
await page.waitForFunction(() => document.getElementById('mhll-menu') && document.querySelector('[id^="mhs-loot-log-style"]'));
step('loot log switches off and on cleanly');

// 7. Number fields clamp; horn can be switched off and stays off after a reload
await panel('#f-auto-horn-krRetryLimit').fill('99');
await panel('#f-auto-horn-krRetryLimit').dispatchEvent('change');
assert.equal(await panel('#f-auto-horn-krRetryLimit').inputValue(), '10');
await panel('[data-mod=auto-horn] .switch').click();
await load();
await panel('.launcher').click();
assert.equal(await panel('[data-mod=auto-horn] .switch').getAttribute('aria-checked'), 'false');
assert.equal(await panel('[data-status=auto-horn]').textContent(), 'Off');
step('settings clamp and persist across reloads');

// 8. Not on a game page: modules report why instead of throwing
await page.route('https://www.mousehuntgame.com/other', (r) => r.fulfill({ contentType: 'text/html', body: '<html><body><div id="mousehuntContainer"></div></body></html>' }));
await page.goto('https://www.mousehuntgame.com/other');
await page.addScriptTag({ content: script });
await panel('.launcher').click();
assert.match(await panel('[data-status=loot-log]').textContent(), /MouseHunt globals not found/);
step('modules degrade gracefully without game globals');

// 9a. School of Sorcery: arms the saved setup for the current power type, then does nothing once it matches
await page.route('https://www.mousehuntgame.com/sos', (r) => r.fulfill({ contentType: 'text/html', body: PAGE.replace('<div id="mousehuntContainer">', '<div id="hudLocationContent"></div><div id="mousehuntContainer">') }));
await page.goto('https://www.mousehuntgame.com/sos');
await page.evaluate(GAME_STUBS);
await page.evaluate(() => {
  localStorage.removeItem('mhs-settings-v1');
  localStorage.setItem('mh-sos-autoswap', JSON.stringify({ enabled: true, swapBait: false, setups: {
    arcane: { weapon: { id: 1, name: 'Arc Trap' }, base: { id: 2, name: 'Arc Base' }, trinket: null, bait: { id: 9, name: 'Cheese' } },
    shadow: null } }));
  Object.assign(window.user, { environment_type: 'school_of_sorcery', weapon_item_id: 5, base_item_id: 2, trinket_item_id: 0, bait_item_id: 8,
    quests: { QuestSchoolOfSorcery: { in_course: true, current_course: { course_type: 'arcane_101_course', power_type: 'arcane', course_name: 'Arcane Arts' } } } });
  window.__armed = [];
  window.hg.utils.TrapControl = { armItem: (id, slot) => window.__armed.push([id, slot]), go: (ok) => ok() };
});
await page.addScriptTag({ content: script });
await page.waitForFunction(() => window.__armed.length > 0, null, { timeout: 5000 });
assert.deepEqual(await page.evaluate(() => window.__armed), [[1, 'weapon']]); // base already matches, cheese swap is off
assert.match(await page.locator('#mh-sos-autoswap').textContent(), /Arc Trap/);
step('School of Sorcery arms only what differs and shows its panel');

// 9. King's Reward: OCR result is typed in and submitted, then the page reloads
const KR_PAGE = PAGE.replace('<div id="mousehuntContainer">', `<div id="mousehuntContainer"><div class="puzzleView--active"><div class="puzzleView__image"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=="></div>
<input class="puzzleView__code"><button class="puzzleView__solveButton"></button><a class="puzzleView__requestNewPuzzleButton"></a></div>`).replace('</div></body>', '</div></div></body>');
await page.route('https://www.mousehuntgame.com/kr', (r) => r.fulfill({ contentType: 'text/html', body: KR_PAGE }));
await page.goto('https://www.mousehuntgame.com/kr');
await page.evaluate(GAME_STUBS);
await page.evaluate(() => {
  sessionStorage.clear();
  localStorage.removeItem('mhs-settings-v1'); // the horn was switched off earlier in this run
  window.Tesseract = { createWorker: async () => ({ loadLanguage: async () => {}, initialize: async () => {}, recognize: async () => ({ data: { text: ' AB-12c \n' } }), terminate: async () => { sessionStorage.setItem('terminated', '1'); } }) };
  document.querySelector('.puzzleView__solveButton').addEventListener('click', () => {
    sessionStorage.setItem('code', document.querySelector('.puzzleView__code').value);
    document.querySelector('.puzzleView--active').classList.remove('puzzleView--active');
  });
});
const reloaded = page.waitForNavigation({ timeout: 15000 });
await page.addScriptTag({ content: script });
await reloaded;
assert.equal(await page.evaluate(() => sessionStorage.getItem('code')), 'AB12c');
assert.equal(await page.evaluate(() => sessionStorage.getItem('terminated')), '1');
step("King's Reward solved with the OCR code, OCR worker released, page reloaded");

assert.deepEqual(errors, []);
await browser.close();
console.log(`${n} checks passed`);
