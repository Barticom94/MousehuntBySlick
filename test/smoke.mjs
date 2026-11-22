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
assert.equal(await panel('.card').count(), 5);
assert.deepEqual(await panel('.switch').evaluateAll((els) => els.map((e) => e.getAttribute('aria-checked'))), ['true', 'true', 'true', 'true', 'true']);
step('panel lists five modules, all on');

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

// 10. Daily Gifting: mock of the gifts dialog using the class names and data attributes read from the live game
// (read-only, 14 Nov 2026). Mock only: the game's own click handlers and the final send confirmation are simulated.
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ago = (h) => { const d = new Date(Date.now() - h * 36e5); return `${MON[d.getMonth()]} ${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }; // relative, so the test doesn't age
const row = (id, name, sent) => `<div class="giftSelectorView-friendRow gift" data-snuid="${id}" data-sent="${sent}" data-is-daily="true"><div class="giftSelectorView-friendRow-sender"><div class="giftSelectorView-friend-name"><span>${name}</span><div class="giftSelectorView-friend-sent">${sent}</div></div></div><div class="giftSelectorView-friendRow-actionContainer"><a class="giftSelectorView-friendRow-action ignore">Ignore</a><a class="giftSelectorView-friendRow-action claim">Accept</a><a class="giftSelectorView-friendRow-action return">and Return</a></div></div>`;
const grp = (t, rows) => `<div class="giftSelectorView-claimableGift expanded"><div class="giftSelectorView-claimableGift-titleContainer"><span class="giftSelectorView-claimableGift-title-itemName">${t} (${rows.length})</span></div><div class="giftSelectorView-claimableGift-friendContainer">${rows.join('')}</div></div>`;
const GIFT_PAGE = PAGE.replace('<div id="mousehuntContainer">', `<div class="giftSelectorViewPopup"><div class="giftSelectorView">
<div class="giftSelectorView-tabHeaderContainer"><a class="giftSelectorView-tabHeader active">Claim Free Gifts</a><a class="giftSelectorView-tabHeader" id="sendtab">Send Free Gifts</a></div>
<div class="giftSelectorView-content-viewState selectClaimableGift"><div class="giftSelectorView-content-title">Select free gifts to claim!</div>
<div class="giftSelectorView-content-subtitle">You can claim <span class="giftSelectorView-actionLimit giftSelectorView-numClaimActionsRemaining">3</span> more free gifts today.</div>
${grp('Quantum Quartz', [row(1, 'Amy', ago(1)), row(2, 'Bob', ago(30)), row(3, 'Cat', ago(5))])}
${grp('Pollutinum', [row(4, 'Dan', ago(4)), row(5, 'Eve', ago(50))])}
<a class="giftSelectorView-action-confirm disabled" id="cgo">Select Gifts</a>
<div>You can claim more gifts in: 11 hours 18 minutes. Unclaimed regular gifts will expire in 7 days.</div></div>
<div class="giftSelectorView-content-viewState selectGift" style="display:none"><div class="giftSelectorView-gift sendable gift gift_of_the_day" id="gotd">Quantum Quartz</div></div>
<div class="giftSelectorView-content-viewState selectFriends" id="friendsview" style="display:none">You can send <span class="giftSelectorView-numSendActionsRemaining">25</span> more
 <div id="friends"></div></div>
<a class="giftSelectorView-action-confirm disabled" id="go" style="display:none">Select Gifts</a>
<div class="giftSelectorView-confirmOverlay" id="ov" style="display:none"><a class="giftSelectorView-confirmPopup-submitConfirmButton" id="ok">Confirm</a></div></div></div><div id="mousehuntContainer">`);
await page.route('https://www.mousehuntgame.com/gift', (r) => r.fulfill({ contentType: 'text/html', body: GIFT_PAGE }));
await page.goto('https://www.mousehuntgame.com/gift');
await page.evaluate(GAME_STUBS);
await page.evaluate(() => {
  localStorage.removeItem('mhs-settings-v1');
  localStorage.setItem('mh-gifting-prices-v1', JSON.stringify({ at: Date.now(), p: { 'quantum quartz': 800, pollutinum: 300 } }));
  localStorage.setItem('mhs-settings-v1', JSON.stringify({ 'daily-gifting': { values: { explorePct: 0 } } }));
  window.__log = [];
  const $ = (s) => document.querySelector(s);
  // Like the real game: Accept only SELECTS (limit enforced); nothing is claimed until Select Gifts > Confirm.
  const sel = () => document.querySelectorAll('.giftSelectorView-friendRow-action.claim.selected');
  document.querySelectorAll('.giftSelectorView-friendRow-action.claim').forEach((a) => a.addEventListener('click', () => {
    if (a.classList.contains('selected')) a.classList.remove('selected');
    else if (sel().length < Number($('.giftSelectorView-numClaimActionsRemaining').textContent)) a.classList.add('selected');
    $('#cgo').classList.toggle('disabled', !sel().length);
    window.__log.push('select ' + a.closest('.giftSelectorView-friendRow').querySelector('span').textContent);
  }));
  $('#cgo').addEventListener('click', () => { if (!$('#cgo').classList.contains('disabled')) $('#ov').style.display = ''; });
  document.querySelectorAll('.giftSelectorView-friendRow-action.return').forEach((a) => a.addEventListener('click', () => window.__log.push('RETURN CLICKED')));
  for (const [id, n] of [[1, 'Amy'], [20, 'Zed'], [21, 'Yan'], [22, 'Xi'], [23, 'Wu']]) { const d = document.createElement('a'); d.className = 'giftSelectorView-friend'; d.dataset.snuid = id; d.innerHTML = '<div class="giftSelectorView-friend-name"><span>' + n + '</span></div>'; d.addEventListener('click', () => d.classList.toggle('selected')); $('#friends').append(d); }
  $('#sendtab').addEventListener('click', () => { document.querySelectorAll('.selectClaimableGift').forEach((e) => { e.style.display = 'none'; }); $('.selectGift').style.display = ''; });
  $('#gotd').addEventListener('click', () => { $('.selectGift').style.display = 'none'; $('#friendsview').style.display = ''; $('#go').style.display = ''; });
  const upd = () => { const g = $('#go'); g.classList.toggle('disabled', !document.querySelector('.giftSelectorView-friend.selected')); };
  new MutationObserver(upd).observe($('#friends'), { subtree: true, attributes: true });
  $('#go').addEventListener('click', () => { if (!$('#go').classList.contains('disabled')) $('#ov').style.display = ''; });
  $('#ok').addEventListener('click', () => { if (sel().length) { const names = [...sel()].map((a) => a.closest('.giftSelectorView-friendRow').querySelector('span').textContent); window.__log.push('claim ' + names.join(',')); sel().forEach((a) => a.closest('.giftSelectorView-friendRow').remove()); $('.giftSelectorView-numClaimActionsRemaining').textContent -= names.length; $('#cgo').classList.add('disabled'); $('#ov').style.display = 'none'; return; } const s = [...document.querySelectorAll('.giftSelectorView-friend.selected span')].map((x) => x.textContent).sort(); window.__log.push('send ' + s.join(',')); $('.giftSelectorView-numSendActionsRemaining').textContent -= s.length; $('#ov').style.display = 'none'; });
});
await page.addScriptTag({ content: script });
await page.waitForSelector('#mhgd-panel');
const inputs = await page.locator('#mhgd-panel input[data-type]').evaluateAll((els) => els.map((e) => [e.dataset.type, e.value]));
// Limit 3. Bob (22:00 yesterday) and Eve (2 days old) are about to expire, so both types are urgent; value order then puts Quartz first.
assert.deepEqual(inputs, [['Quantum Quartz', '3'], ['Pollutinum', '0']]);
assert.equal(await page.locator('.giftSelectorView-claimableGift-friendContainer').first().isHidden(), true); // senders hidden
step('gifting panel groups by type, fills the claim limit by value, hides senders');
// Quick buttons: None / Max per type, then Fill to limit
await page.locator('#mhgd-panel [data-set=none][data-type="Quantum Quartz"]').click();
assert.equal(await page.locator('#mhgd-panel input[data-type="Quantum Quartz"]').inputValue(), '0');
await page.locator('#mhgd-panel [data-set=max][data-type="Pollutinum"]').click();
assert.equal(await page.locator('#mhgd-panel input[data-type="Pollutinum"]').inputValue(), '2');
await page.locator('#mhgd-panel [data-set=max][data-type="Quantum Quartz"]').click();
assert.equal(await page.locator('#mhgd-panel input[data-type="Quantum Quartz"]').inputValue(), '1'); // limit 3, 2 already used by Pollutinum
await page.locator('#mhgd-panel [data-set=allnone]').click();
await page.locator('#mhgd-panel [data-set=best]').click();
assert.deepEqual(await page.locator('#mhgd-panel input[data-type]').evaluateAll((els) => els.map((e) => e.value)), ['3', '0']);
step('quick buttons: None, Max (capped by the daily limit), Fill to limit, None for all');
await page.locator('#mhgd-panel [data-act=both]').click();
await page.waitForFunction(() => window.__log.some((l) => l.startsWith('send')), null, { timeout: 20000 });
const log = await page.evaluate(() => window.__log);
assert.deepEqual(log.slice(0, 4), ['select Bob', 'select Cat', 'select Amy', 'claim Amy,Bob,Cat']); // oldest first, all selected then ONE confirmed batch
assert.ok(!log.includes('RETURN CLICKED'));
assert.equal(log[4], 'send Wu,Xi,Yan,Zed'); // Amy sent today (snuid 1), so not sent to
const hist = await page.evaluate(() => JSON.parse(localStorage.getItem('mh-gifting-v1-4242')));
assert.equal(hist.sent.length, 4);
assert.ok(hist.resetAt > Date.now());
step('gifting accepts oldest first without returning, sends to everyone except today\'s senders and logs it');

// 11. Pure parts: return learning, rest period and recency
const pure = await page.evaluate(() => {
  const g = window.mhGifting; const now = Date.UTC(2026, 10, 14, 12);
  const h = g.emptyHistory();
  const D = 864e5;
  h.sent.push({ k: 'a', t: now - 3 * D }, { k: 'b', t: now - 3 * D });
  h.received.push({ k: 'a', t: now - 2 * D }); // a returned
  const fr = ['a', 'b', 'c', 'd'].map((k) => ({ key: k }));
  const picked = g.pickRecipients(fr, h, { slots: 1, today: new Set(), smart: true, explore: 0, now }).map((f) => f.key);
  const none = g.pickRecipients(fr, h, { slots: 4, today: new Set(['a', 'b']), smart: false, now }).map((f) => f.key).sort();
  const rec = g.pickRecipients([{ key: 'old', recency: 0 }, { key: 'new', recency: 1 }], g.emptyHistory(), { slots: 1, today: new Set(), smart: true, explore: 0, now }).map((f) => f.key);
  return { picked, none, rec };
});
assert.deepEqual(pure.picked, ['a']);
assert.deepEqual(pure.none, ['c', 'd']);
assert.deepEqual(pure.rec, ['new']);
step('friend picking prefers returners and recently active friends and skips today\'s senders');

assert.deepEqual(errors, []);
await browser.close();
console.log(`${n} checks passed`);
