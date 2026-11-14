// Module: Gift Links
// Warns about unclaimed MH Improved gift links and claims them all in one click.
// Ported from "MouseHunt - Loot Log & Gift Links" 1.3.1 (Adam Harley).
//
// Reads MH Improved's gift-link cache/state from localStorage, refreshes it from api.mouse.rip on MHI's own
// 15-minute schedule, and claims with the game's own hg.utils.SocialGift.claimGift. Claimed links are written
// back to MHI's state, so MHI's inbox tab shows them as claimed.
{
  // Gift links (pure parts; normalize/safeUrl copied from MH Improved gifts-in-inbox)

  const safeUrl = (url) => { try { return new URL(url).protocol === 'https:' ? url : ''; } catch { return ''; } };
  const giftCreds = (url) => { try { const u = new URL(url); return { giftId: u.searchParams.get('gift_id'), giftHash: u.searchParams.get('gift_hash') }; } catch { return { giftId: null, giftHash: null }; } };
  const normalizeLink = (link) => {
    const parsed = link.parsed || {};
    const gift = link.gift || {};
    const expandedUrl = safeUrl(gift.url || gift.expandedUrl || link.expandedUrl);
    const fromUrl = giftCreds(expandedUrl);
    return {
      code: parsed.code || link.code, url: safeUrl(parsed.url || link.url), reward: parsed.reward || link.reward,
      finder: parsed.finder || link.finder, finderName: parsed.finderName || link.finderName, giftName: gift.name || link.giftName,
      giftImage: safeUrl(gift.image || link.giftImage), quantity: gift.quantity ?? link.quantity, expiresAt: gift.expiresAt ?? link.expiresAt,
      expandedUrl, expired: link.expired, timestamp: link.timestamp,
      giftId: gift.id || link.giftId || fromUrl.giftId, giftHash: gift.hash || link.giftHash || fromUrl.giftHash,
    };
  };

  /** Links that can be claimed in one click right now. */
  const claimableGifts = (links, state, failed, now) => links.filter((l) => l && l.code && l.url && !l.expired
    && !(l.expiresAt && l.expiresAt <= now)
    && !state.hidden?.[l.code] && !state.claimed?.[l.code] && !failed?.[l.code]
    && l.giftId && l.giftHash);

  // Also on window.mhLootLog for the console and tests.
  window.mhLootLog = Object.assign(window.mhLootLog || {}, { normalizeLink, claimableGifts });

  const CSS = `
    #mhll-gift-alert { display: inline-block; margin: 0 6px; padding: 1px 9px; border: 1px solid var(--gold-edge); border-radius: 10px; background: var(--gold); color: var(--on-gold); font-weight: bold; white-space: nowrap; }
    /* Padding grows the click area to 24px+; the negative margins keep the pill's height. */
    #mhll-gift-alert a { display: inline-block; margin: -5px -6px -5px 0; padding: 5px 6px; color: inherit; text-decoration: underline; }
  `;

  MH.register({
    id: 'gift-links',
    name: 'Gift Links',
    description: 'Shows a pill with the number of claimable MH Improved gift links, with a one-click "Claim all".',
    requires: gameRequires,
    init(ctx) {
  const uid = String(user.user_id);
  const warn = ctx.log.warn;
  const showPopup = (title, html, cls) => showGamePopup(title, html, cls, warn);
  const date = fmtDate;

  const GIFT_CACHE = 'mh-improved-gift-links-cache-v1'; // MHI's keys: shared on purpose
  const GIFT_STATE = 'mh-improved-gift-links-in-inbox-state-v1';
  const GIFT_FAILED = `mhll-gift-failed-${uid}`; // ours: links that errored, so they stop nagging
  const GIFT_EVERY = 15 * MIN; // MHI's own minimum between API requests

  const giftState = () => { const s = lsGet(GIFT_STATE, {}) || {}; return { claimed: s.claimed || {}, hidden: s.hidden || {}, seen: s.seen || {} }; };
  const giftLinks = () => { const c = lsGet(GIFT_CACHE, {}) || {}; return Array.isArray(c.links) ? c.links.filter((l) => l && typeof l === 'object').map(normalizeLink) : []; };
  const availableGifts = () => claimableGifts(giftLinks(), giftState(), lsGet(GIFT_FAILED, {}), Date.now());
  const markClaimed = (code) => { const s = giftState(); s.claimed[code] = new Date().toISOString(); lsSet(GIFT_STATE, s); }; // same format as MHI's markState
  const markFailed = (code, error) => {
    const live = new Set(giftLinks().map((l) => l.code));
    const f = Object.fromEntries(Object.entries(lsGet(GIFT_FAILED, {})).filter(([c]) => live.has(c)));
    f[code] = { error, at: Date.now() };
    lsSet(GIFT_FAILED, f);
  };

  // Same protocol as MHI: record the attempt first so neither MHI nor other tabs double-hit the API.
  const maybeFetchGifts = async () => {
    const cache = lsGet(GIFT_CACHE, {}) || {};
    if (Date.now() - (Number(cache.attemptedAt) || 0) < GIFT_EVERY) return;
    const attemptedAt = Date.now();
    lsSet(GIFT_CACHE, { ...cache, attemptedAt });
    try {
      const res = await fetch('https://api.mouse.rip/gift-links', { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`gift-links API ${res.status}`);
      const data = await res.json();
      lsSet(GIFT_CACHE, { links: Array.isArray(data.links) ? data.links.map(normalizeLink) : [], attemptedAt });
    } catch (e) { warn(e); }
  };

  let claiming = false;
  const renderGiftAlert = (progress) => {
    const gifts = availableGifts();
    let el = document.getElementById('mhll-gift-alert');
    if (!gifts.length && !progress) { el?.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'mhll-gift-alert';
      el.setAttribute('role', 'status');
      const bar = document.querySelector('.mousehuntHud-gameInfo');
      if (bar) bar.prepend(el);
      else { el.classList.add('mhll-float'); document.body.append(el); }
    }
    el.parentElement?.classList.remove('mhui-menu-info-empty'); // MHI Custom Menu hides an info bar it thinks is empty
    const html = progress ? esc(progress) : `<b>${gifts.length}</b> gift link${gifts.length === 1 ? '' : 's'}: <a href="#" data-mhll-claim>Claim all</a>`;
    const title = gifts.map((g) => `${g.giftName || 'Gift'}${g.expiresAt ? ` (expires ${date(g.expiresAt)})` : ''}`).join('\n');
    // The pill is a live region and this runs every minute: rewriting unchanged text would make screen readers repeat it.
    if (el.dataset.html !== html) { el.dataset.html = html; el.innerHTML = html; }
    if (el.title !== title) el.title = title;
  };

  // One claim through the game's own helper. Resolves {ok} / {ok:false, network} / {ok:false, error}.
  const claimOne = (link) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, network: true }), 30000); // the game's $.ajax has no timeout
    const done = (r) => { clearTimeout(timer); resolve(r); };
    try {
      hg.utils.SocialGift.claimGift(link.giftId, link.giftHash,
        () => { markClaimed(link.code); done({ ok: true }); }, // record it even if it lands after the timeout
        (data) => {
          // jQuery transport failures pass a jqXHR; server refusals pass the JSON body.
          if (!data || typeof data.readyState === 'number') return done({ ok: false, network: true });
          done({ ok: false, error: toText(data?.gift?.claim_error) || 'Not claimed: the game gave no reason.' });
        });
    } catch (e) { warn(e); done({ ok: false, network: true }); }
  });

  const claimAll = async () => {
    if (claiming) return;
    if (!hg?.utils?.SocialGift?.claimGift) { showPopup('Gift links', '<div class="mhll" tabindex="-1">Gift links can\'t be claimed from this page. Use the Gift Links tab in your inbox.</div>', 'mhll-popup'); return; }
    claiming = true;
    const queue = availableGifts().sort((a, b) => (a.expiresAt || Infinity) - (b.expiresAt || Infinity)); // soonest-expiring first
    const results = [];
    // The Claim all link is replaced by progress text, so keep keyboard focus on the pill itself.
    const keepFocus = Boolean(document.activeElement?.closest?.('#mhll-gift-alert'));
    try {
      for (const [i, link] of queue.entries()) {
        if (!ctx.alive()) break; // module switched off mid-claim
        if (giftState().claimed[link.code]) continue; // claimed meanwhile in MHI or another tab
        renderGiftAlert(`Claiming ${i + 1} of ${queue.length}…`);
        const pill = document.getElementById('mhll-gift-alert');
        if (keepFocus && pill && document.activeElement !== pill) { pill.tabIndex = -1; pill.focus(); }
        const r = await claimOne(link);
        if (r.ok) results.push({ link, status: 'Claimed' });
        else if (r.network) { results.push({ link, status: 'Network error, stopped here', manual: true }); break; } // mark nothing
        else {
          if (/already/i.test(r.error)) markClaimed(link.code);
          else markFailed(link.code, r.error);
          results.push({ link, status: r.error, manual: !/already/i.test(r.error) });
        }
        if (i < queue.length - 1) await sleep(1000); // ponytail: 1 claim/s is a guess, no published limit
      }
    } finally {
      claiming = false;
      renderGiftAlert();
    }
    const rows = results.map(({ link, status, manual }) => `<tr><td>${esc(link.giftName || link.code)}</td><td>${esc(status)}${manual && (link.expandedUrl || link.url) ? `<br><a href="${esc(link.expandedUrl || link.url)}" target="_blank" rel="noopener">Claim it manually</a>` : ''}</td></tr>`).join('');
    showPopup('Gift links', `<div class="mhll" tabindex="-1"><table class="mhll-table">${rows || '<tr><td>Nothing left to claim.</td></tr>'}</table></div>`, 'mhll-popup');
  };

  const giftTick = () => maybeFetchGifts().catch(warn).finally(() => { if (!claiming) renderGiftAlert(); });

  ctx.addStyle(CSS);
  ctx.setStatus('Watching for gift links');
  giftTick();
  ctx.every(giftTick, MIN);
  ctx.listen(document, 'click', (e) => {
    const claim = e.target.closest?.('[data-mhll-claim]');
    if (claim) { e.preventDefault(); claimAll(); }
  });
  ctx.listen(window, 'storage', (e) => { if ([GIFT_CACHE, GIFT_STATE].includes(e.key) && !claiming) renderGiftAlert(); });
  ctx.listen(document, 'mh-improved-loaded', () => { if (!claiming) renderGiftAlert(); });
  ctx.onStop(() => document.getElementById('mhll-gift-alert')?.remove());

  return { actions: [{ label: 'Claim all now', run: claimAll }] };
    },
  });
}
