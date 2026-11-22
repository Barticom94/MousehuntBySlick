// Module: Daily Gifting
// One-click daily gifting from the game's own gifts dialog (Gifts menu > View More Gifts):
//   1. shows what is waiting grouped by gift type (no senders) with a count to claim per type;
//   2. ACCEPTS those gifts (never "and Return") up to the daily claim limit, by selecting them with the game's own Accept buttons and confirming once (one batch request);
//   3. sends the gift of the day to friends who have NOT already sent you a gift today (they can't return one), favouring
//      friends who have returned gifts, send regularly, and were active recently.
//
// DOM facts below were read from the live dialog (Chrome, 14 Nov 2026), read-only: the Claim tab, the tile layout of the
// Send tab and the selector classes. NOT verified live: the click-through of the final confirm step of a send, and the
// "last active" ordering (that sort comes from MH Improved, not the game).
{
  const DAY_MS = 864e5;
  const HISTORY_DAYS = 30;
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const nameKey = (s) => norm(s).toLowerCase();
  const V = 'giftSelectorView'; // the game's class prefix

  // ---- Reading the dialog (pure DOM, no game globals) ----------------------------------------------------------

  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  /** "Nov 14 09:51" -> ms. The game shows no year: take the latest date that isn't in the future. Read as browser-local time. */
  const parseGiftTime = (text, now = Date.now()) => {
    const m = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* (\d{1,2}),? (\d{1,2}):(\d{2})/.exec(text || '');
    if (!m) return 0;
    const mo = MONTHS.indexOf(m[1].toLowerCase());
    const y = new Date(now).getFullYear();
    const at = (yr) => new Date(yr, mo, Number(m[2]), Number(m[3]), Number(m[4])).getTime();
    return at(y) > now + DAY_MS ? at(y - 1) : at(y);
  };

  /** "11 hours 18 minutes" / "1 day 2 hours" -> ms, or 0. */
  const parseDuration = (text) => {
    let ms = 0;
    for (const [, n, unit] of String(text || '').matchAll(/(\d+(?:\.\d+)?)\s*(day|hour|hr|minute|min)/gi)) ms += Number(n) * ({ d: DAY_MS, h: 36e5, m: 6e4 }[unit[0].toLowerCase()]);
    return ms;
  };

  const q = (el, sel) => el.querySelector(`.${V}-${sel}`);
  const num = (el) => { const n = parseInt(el?.textContent, 10); return Number.isNaN(n) ? NaN : n; };

  /**
   * The Claim tab: { claimLeft, sendLeft, nextClaimMs, groups: [{ type, count, urgent, rows }] } with
   * row = { key, name, t, daily, accept (the game's own Accept button), el }, rows oldest first.
   * A gift is "urgent" when it is within a day of expiring: Gifts of the Day last 1.5 days, regular gifts 7.
   */
  const parseClaimTab = (root, now = Date.now()) => {
    const groups = [...root.querySelectorAll(`.${V}-claimableGift`)].map((g) => {
      const type = norm(q(g, 'claimableGift-title-itemName')?.textContent).replace(/\s*\(\d+\)$/, '');
      const rows = [...g.querySelectorAll(`.${V}-friendRow.gift`)].map((el) => {
        const t = parseGiftTime(el.dataset.sent || q(el, 'friend-sent')?.textContent, now);
        const snuid = el.dataset.snuid;
        const name = norm(q(el, 'friend-name span')?.textContent);
        return { el, key: snuid ? `id:${snuid}` : `n:${nameKey(name)}`, name, t, daily: el.dataset.isDaily === 'true', accept: el.querySelector(`.${V}-friendRow-action.claim`) };
      }).filter((r) => r.accept).sort((a, b) => a.t - b.t);
      const urgent = rows.filter((r) => now - r.t >= (r.daily ? 0.5 : 6) * DAY_MS).length;
      return { type, count: rows.length, urgent, rows };
    }).filter((g) => g.count);
    return {
      claimLeft: num(q(root, 'numClaimActionsRemaining')),
      sendLeft: num(q(root, 'numSendActionsRemaining')),
      nextClaimMs: parseDuration(/claim more gifts in:?\s*([^.]*)/i.exec(norm(root.textContent))?.[1]),
      groups,
    };
  };

  // ---- "Today" ---------------------------------------------------------------------------------------------------

  /** Start of the game's current daily window. resetAt is any reset moment we have seen; resets repeat every 24 h. */
  const windowStart = (now, resetAt) => {
    if (resetAt) return resetAt + Math.floor((now - resetAt) / DAY_MS) * DAY_MS;
    const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); // fallback: local midnight
  };

  // ---- History: who sent to us, who we sent to ------------------------------------------------------------------

  const emptyHistory = () => ({ received: [], sent: [], resetAt: 0 });
  const prune = (h, now) => {
    const min = now - HISTORY_DAYS * DAY_MS;
    return { ...h, received: h.received.filter((e) => e.t >= min), sent: h.sent.filter((e) => e.t >= min) };
  };
  const addReceived = (h, entries) => {
    const seen = new Set(h.received.map((e) => `${e.k}|${e.t}`));
    for (const e of entries) if (e.k && e.t && !seen.has(`${e.k}|${e.t}`)) { h.received.push({ k: e.k, n: e.n, t: e.t }); seen.add(`${e.k}|${e.t}`); }
    return h;
  };
  const sentToday = (h, start) => new Set(h.received.filter((e) => e.t >= start).map((e) => e.k));

  /** Per friend: sends, how many were followed by a gift from them within 48 h, distinct days they sent in the last 7. */
  const friendStats = (h, key, now) => {
    const sends = h.sent.filter((e) => e.k === key).sort((a, b) => a.t - b.t);
    const got = h.received.filter((e) => e.k === key).map((e) => e.t).sort((a, b) => a - b);
    const used = new Set();
    let returns = 0;
    for (const s of sends) {
      const i = got.findIndex((t, j) => !used.has(j) && t > s.t && t - s.t <= 2 * DAY_MS);
      if (i >= 0) { used.add(i); returns++; }
    }
    const days = new Set(got.filter((t) => t >= now - 7 * DAY_MS).map((t) => Math.floor(t / DAY_MS)));
    return { sends: sends.length, returns, days: days.size, lastSend: sends.length ? sends[sends.length - 1].t : 0 };
  };
  /** 0..1. Recency (0 = least recently active, 1 = most) counts for a third when known; a friend who never returns is rested a week. */
  const score = (s, now, recency) => {
    const rate = (s.returns + 0.6) / (s.sends + 2); // prior ~30% return rate, learns as evidence arrives
    const habit = s.days / 7;
    const rest = s.sends >= 5 && s.returns === 0 && now - s.lastSend < 7 * DAY_MS;
    const base = recency == null ? 0.6 * rate + 0.4 * habit : 0.4 * rate + 0.25 * habit + 0.35 * recency;
    return base * (rest ? 0.1 : 1);
  };

  /** Pick up to `slots` of `friends` ({key, name, recency?}). Smart mode: best scores plus a random share for exploration. */
  const pickRecipients = (friends, h, { slots, today, smart, explore = 0.2, now = Date.now(), rand = Math.random }) => {
    const pool = friends.filter((f) => f.key && !today.has(f.key));
    const shuffled = pool.map((f) => [rand(), f]).sort((a, b) => a[0] - b[0]).map((x) => x[1]); // random tie-break
    if (!smart || slots >= shuffled.length) return shuffled.slice(0, slots);
    const nRandom = Math.min(Math.round(slots * explore), shuffled.length);
    const ranked = shuffled.map((f) => ({ f, s: score(friendStats(h, f.key, now), now, f.recency) })).sort((a, b) => b.s - a.s);
    const best = ranked.slice(0, slots - nRandom).map((x) => x.f);
    return [...best, ...shuffled.filter((f) => !best.includes(f)).slice(0, nRandom)];
  };

  // ---- Claim plan --------------------------------------------------------------------------------------------------

  /** Counts to claim per type until the daily limit is used: types with gifts about to expire first, then by `order`. */
  const planClaim = (groups, limit, order, values = {}) => {
    const rank = { value: (a, b) => (values[nameKey(b.type)] || 0) - (values[nameKey(a.type)] || 0) || b.count - a.count,
      plenty: (a, b) => b.count - a.count, oldest: (a, b) => (a.rows[0]?.t || 0) - (b.rows[0]?.t || 0) }[order] || (() => 0);
    let left = Number.isFinite(limit) ? limit : Infinity;
    const plan = {};
    for (const g of [...groups].sort((a, b) => (b.urgent > 0) - (a.urgent > 0) || rank(a, b))) { const n = Math.min(g.count, left); plan[g.type] = n; left -= n; }
    return plan;
  };

  window.mhGifting = { parseGiftTime, parseDuration, parseClaimTab, windowStart, emptyHistory, addReceived, sentToday, friendStats, score, pickRecipients, planClaim, prune };

  // ---- The module ----------------------------------------------------------------------------------------------------

  const CSS = `
    #mhgd-panel { margin: 6px 0 10px; padding: 8px 10px; border: 1px solid var(--gd-edge, #b8891d); border-radius: 4px; background: var(--gd-bg, #faf4e6); color: var(--gd-ink, #3b2b1a); font-size: 12px; line-height: 1.45; text-align: left; }
    body.mh-dark #mhgd-panel, .mh-dark-mode #mhgd-panel { --gd-bg: #2c2720; --gd-ink: #ecdfc6; --gd-edge: #b18a32; }
    #mhgd-panel table { width: 100%; border-collapse: collapse; margin: 4px 0 6px; font-variant-numeric: tabular-nums; }
    #mhgd-panel td { padding: 2px 4px; }
    #mhgd-panel td.n { text-align: right; white-space: nowrap; }
    #mhgd-panel input[type=number] { width: 52px; font: inherit; }
    #mhgd-panel button { font: inherit; font-weight: bold; min-height: 24px; padding: 2px 10px; margin-right: 6px; border: 1px solid #b8891d; border-radius: 3px; background: #f3d377; color: #3b2b1a; cursor: pointer; }
    #mhgd-panel button.sec { background: transparent; color: inherit; font-weight: normal; }
    #mhgd-panel button[disabled] { opacity: .55; cursor: progress; }
    #mhgd-panel button:focus-visible { outline: 2px solid #87590a; outline-offset: 1px; }
    #mhgd-panel .st { margin-top: 6px; min-height: 1.4em; }
    #mhgd-panel .dim { opacity: .7; }
  `;

  MH.register({
    id: 'daily-gifting',
    name: 'Daily Gifting',
    description: 'In the Claim Free Gifts tab: waiting gifts by type, accepts (never returns) up to your daily limit, then sends the gift of the day to friends who haven\'t sent today.',
    requires: gameRequires,
    settings: [
      { key: 'hideSenders', type: 'checkbox', label: 'Hide the sender list on the Claim tab', default: true },
      { key: 'fillOrder', type: 'select', label: 'When the claim limit is short, claim first', default: 'value', options: [{ value: 'value', label: 'Most valuable type (Markethunt)' }, { value: 'plenty', label: 'Type with the most gifts' }, { value: 'oldest', label: 'Type with the oldest gift' }] },
      { key: 'sendAfterClaim', type: 'checkbox', label: 'Send gifts straight after claiming', default: true },
      { key: 'smartPick', type: 'checkbox', label: 'Choose friends by past returns and activity, not just at random', default: true },
      { key: 'explorePct', type: 'number', label: 'Share of sends that stay random', unit: '%', min: 0, max: 100, default: 20 },
    ],
    init(ctx) {
      const uid = String(user.user_id);
      const warn = ctx.log.warn;
      const HKEY = `mh-gifting-v1-${uid}`;
      const PKEY = 'mh-gifting-prices-v1';
      const loadH = () => { const h = lsGet(HKEY, null); return h && Array.isArray(h.received) && Array.isArray(h.sent) ? h : emptyHistory(); };
      const saveH = (h) => lsSet(HKEY, prune(h, Date.now()));

      let busy = false;
      let status = '';
      const setStatus = (t) => { status = t; const el = document.querySelector('#mhgd-panel .st'); if (el) el.textContent = t; };

      // Markethunt values by item name, only used to order the claim. A failure just leaves values empty.
      const values = () => lsGet(PKEY, { p: {} }).p || {};
      const ensurePrices = async () => {
        const cur = lsGet(PKEY, null);
        if (cur && Date.now() - cur.at < 6 * 60 * MIN) return;
        lsSet(PKEY, { p: {}, ...cur, at: Date.now() - 6 * 60 * MIN + 30 * MIN });
        try {
          const res = await fetch('https://api.markethunt.win/items?plugin_ver=adamh-gifting', { signal: AbortSignal.timeout(15000) });
          if (!res.ok) throw new Error(`Markethunt ${res.status}`);
          const p = {};
          for (const x of await res.json()) { const nm = x?.item_info?.name; const pr = x?.latest_market_data?.price; if (nm && pr > 0) p[nameKey(nm)] = Math.round(pr); }
          lsSet(PKEY, { at: Date.now(), p });
        } catch (e) { warn(e); }
      };

      const dialog = () => document.querySelector(`.${V}Popup`);
      const visible = (el) => Boolean(el && el.offsetParent);
      const waitFor = async (fn, ms = 8000, step = 150) => { const end = Date.now() + ms; while (Date.now() < end && ctx.alive()) { const v = fn(); if (v) return v; await sleep(step); } return null; };

      const record = (parsed) => {
        const h = loadH();
        addReceived(h, parsed.groups.flatMap((g) => g.rows.map((r) => ({ k: r.key, n: r.name, t: r.t }))));
        if (parsed.nextClaimMs) h.resetAt = Date.now() + parsed.nextClaimMs;
        saveH(h);
      };

      // ---- Panel in the Claim tab ----
      const draw = (root) => {
        const parsed = parseClaimTab(root);
        record(parsed);
        if (ctx.settings.get('hideSenders')) root.querySelectorAll(`.${V}-claimableGift-friendContainer`).forEach((el) => { el.style.display = 'none'; });
        let panel = document.getElementById('mhgd-panel');
        const sig = JSON.stringify([parsed.groups.map((g) => [g.type, g.count]), parsed.claimLeft, busy]);
        const host = root.querySelector(`.${V}-content-viewState.selectClaimableGift .${V}-content-subtitle`);
        if (!host) return;
        if (panel && panel.dataset.sig === sig && root.contains(panel)) return;
        const keep = panel ? Object.fromEntries([...panel.querySelectorAll('input[data-type]')].map((i) => [i.dataset.type, i.value])) : {};
        panel?.remove();
        const plan = planClaim(parsed.groups, parsed.claimLeft, ctx.settings.get('fillOrder'), values());
        panel = document.createElement('div');
        panel.id = 'mhgd-panel';
        panel.dataset.sig = sig;
        const total = parsed.groups.reduce((n, g) => n + g.count, 0);
        const dis = busy ? ' disabled' : '';
        const rows = parsed.groups.map((g) => `<tr><td>${esc(g.type)}</td><td class="n">${g.count} waiting</td><td class="n"><label>Claim <input type="number" min="0" max="${g.count}" data-type="${esc(g.type)}" value="${esc(keep[g.type] ?? plan[g.type] ?? 0)}"></label> <button type="button" class="sec" data-set="max" data-type="${esc(g.type)}"${dis}>Max</button><button type="button" class="sec" data-set="none" data-type="${esc(g.type)}"${dis}>None</button></td></tr>`).join('');
        panel.innerHTML = `<b>Daily gifting</b> <span class="dim">${total} waiting${Number.isFinite(parsed.claimLeft) ? `, ${parsed.claimLeft} claims left today` : ''}</span>
          <table>${rows || '<tr><td>No gifts waiting.</td></tr>'}</table>
          <button type="button" data-act="both"${dis}>Claim &amp; send gifts</button><button type="button" class="sec" data-act="claim"${dis}>Claim only</button><button type="button" class="sec" data-act="send"${dis}>Send only</button>
          <div class="dim">Set all: <button type="button" class="sec" data-set="best"${dis}>Fill to limit</button><button type="button" class="sec" data-set="allnone"${dis}>None</button></div>
          <div class="st" role="status">${esc(status)}</div>`;
        host.after(panel);
      };
      const redraw = () => { const p = document.getElementById('mhgd-panel'); if (p) p.dataset.sig = ''; const r = dialog(); if (r) draw(r); };

      const wanted = () => Object.fromEntries([...document.querySelectorAll('#mhgd-panel input[data-type]')].map((i) => [i.dataset.type, Math.max(0, parseInt(i.value, 10) || 0)]));

      // Claiming is two steps in the game: each Accept only SELECTS the gift (it is queued in the dialog), and nothing is claimed
      // until the confirm button ("Select Gifts" > Confirm) sends the whole batch in one request (read from the game's
      // submitConfirm/submitGiftActions, 22 Nov 2026). So: select everything wanted at once (oldest of each type first, never
      // "and Return"), confirm once, then check the game really dropped those gifts from the list.
      const confirmBtn = (root) => [...root.querySelectorAll(`.${V}-action-confirm`)].find((b) => visible(b) && !/disabled/.test(b.className));
      const claim = async (root) => {
        const parsed = parseClaimTab(root);
        const want = wanted();
        let left = Number.isFinite(parsed.claimLeft) ? parsed.claimLeft : Infinity;
        const picked = [];
        for (const g of parsed.groups) for (const r of g.rows.slice(0, Math.min(want[g.type] ?? 0, g.count))) if (left > 0) { picked.push(r); left--; }
        if (!picked.length) return { done: 0 };
        picked.forEach((r) => { if (!r.accept.classList.contains('selected')) r.accept.click(); });
        const chosen = picked.filter((r) => r.accept.classList.contains('selected'));
        if (!chosen.length) return { done: 0, error: 'The game wouldn\'t select any gifts (claim limit reached?). Nothing was claimed.' };
        const btn = await waitFor(() => confirmBtn(root), 4000);
        if (!btn) return { done: 0, error: 'Gifts were selected but the confirm button never enabled. Nothing was claimed.' };
        setStatus(`Claiming ${chosen.length} gifts…`);
        btn.click();
        const overlay = root.querySelector(`.${V}-confirmOverlay`);
        if (await waitFor(() => visible(overlay), 2500)) { await sleep(200); overlay.querySelector(`.${V}-confirmPopup-submitConfirmButton`)?.click(); }
        // Success = the game removed the claimed gifts from the list (it redraws from the server's reply).
        const gone = await waitFor(() => chosen.every((r) => !r.el.isConnected), 20000);
        if (!gone) return { done: 0, error: 'The game didn\'t confirm the claim, so nothing is counted as claimed. Check the dialog.' };
        return { done: chosen.length, short: picked.length - chosen.length };
      };

      // ---- Sending: Send tab > Gift of the Day tile > friend tiles > Select Gifts (> Confirm) ----
      const tiles = (root) => [...root.querySelectorAll(`a.${V}-friend`)].map((el) => ({ el, name: norm(el.querySelector(`.${V}-friend-name`)?.textContent), key: el.dataset.snuid ? `id:${el.dataset.snuid}` : '' })).filter((t) => t.key);
      const send = async (root) => {
        const tab = [...root.querySelectorAll(`.${V}-tabHeader`)][1];
        if (!tab) return { sent: 0, error: 'No Send Free Gifts tab found.' };
        tab.click();
        const gotd = await waitFor(() => root.querySelector(`.${V}-gift.gift_of_the_day`));
        if (!gotd) return { sent: 0, error: 'No Gift of the Day found on the Send tab, so nothing was sent.' };
        gotd.click();
        const all = await waitFor(() => { const t = tiles(root); return t.length && visible(t[0].el) ? t : null; }, 10000);
        if (!all) return { sent: 0, error: 'The friend list didn\'t appear after choosing the gift.' };
        // MH Improved adds a "last active" sort. If it's there, the order tells us who is active; if not, activity is just not used.
        const sortLink = [...root.querySelectorAll('a, span')].find((e) => /^last active$/i.test(norm(e.textContent)) && !e.closest('#mhgd-panel'));
        let ranked = all;
        if (sortLink) { sortLink.click(); await sleep(500); ranked = tiles(root); }
        const recency = new Map(ranked.map((t, i) => [t.key, sortLink ? 1 - i / Math.max(1, ranked.length - 1) : null]));
        const sendLeft = num(q(root, 'numSendActionsRemaining'));
        const h = loadH();
        const today = sentToday(h, windowStart(Date.now(), h.resetAt));
        const picks = pickRecipients(ranked.map((t) => ({ ...t, recency: recency.get(t.key) })), h, { slots: Number.isFinite(sendLeft) ? sendLeft : 25, today, smart: ctx.settings.get('smartPick'), explore: ctx.settings.get('explorePct') / 100 });
        const info = { pool: all.length, skipped: today.size };
        if (!picks.length) return { sent: 0, ...info };
        for (const p of picks) { if (!p.el.classList.contains('selected')) p.el.click(); await sleep(40); }
        const confirm = () => [...root.querySelectorAll(`.${V}-action-confirm`)].find((b) => visible(b) && !/disabled/.test(b.className));
        const btn = await waitFor(confirm, 3000);
        if (!btn) return { sent: 0, ...info, error: 'Friends were selected but the confirm button never enabled. Nothing was sent.' };
        const before = sendLeft;
        btn.click();
        const overlay = root.querySelector(`.${V}-confirmOverlay`);
        if (await waitFor(() => visible(overlay), 3000)) { await sleep(300); overlay.querySelector(`.${V}-confirmPopup-submitConfirmButton`)?.click(); }
        const done = await waitFor(() => num(q(root, 'numSendActionsRemaining')) < before, 15000);
        if (!done) return { sent: 0, ...info, error: 'The game didn\'t confirm the send, so nothing was recorded as sent. Check the dialog.' };
        const now = Date.now();
        picks.forEach((p) => h.sent.push({ k: p.key, n: p.name, t: now }));
        saveH(h);
        return { sent: picks.length, ...info };
      };

      const run = async (mode) => {
        if (busy) return;
        let root = dialog();
        if (!root) { setStatus('Open the Free Gifts dialog first.'); return; }
        busy = true;
        draw(root);
        document.querySelectorAll('#mhgd-panel button').forEach((b) => { b.disabled = true; });
        const parts = [];
        try {
          if (mode !== 'send') { const r = await claim(root); parts.push(`Claimed ${r.done}.`); root = dialog() || root; if (r.error) { parts.push(r.error); mode = 'claim'; } }
          if (mode !== 'claim' && (mode === 'send' || ctx.settings.get('sendAfterClaim'))) {
            const r = await send(root);
            parts.push(r.error ? r.error : `Sent to ${r.sent} of ${r.pool} friends (${r.skipped} skipped as they sent you a gift today).`);
          }
        } catch (e) { warn(e); parts.push(`Stopped: ${e.message}`); }
        busy = false;
        status = parts.join(' ');
        // Back to the Claim tab so the result is next to the panel.
        [...(dialog()?.querySelectorAll(`.${V}-tabHeader`) || [])][0]?.click();
        await sleep(300);
        redraw();
      };

      ctx.addStyle(CSS);
      ctx.setStatus('Waiting for the Free Gifts dialog');
      ensurePrices();
      const scan = () => { const root = dialog(); if (root && !busy) { try { draw(root); } catch (e) { warn(e); } } };
      let timer = 0;
      const mo = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(scan, 250); });
      mo.observe(document.body, { childList: true, subtree: true });
      ctx.onStop(() => { mo.disconnect(); clearTimeout(timer); document.getElementById('mhgd-panel')?.remove(); document.querySelectorAll(`.${V}-claimableGift-friendContainer`).forEach((el) => { el.style.display = ''; }); });
      ctx.listen(document, 'click', (e) => {
        const b = e.target.closest?.('#mhgd-panel [data-act]');
        if (b) { e.preventDefault(); run(b.dataset.act); return; }
        const s = e.target.closest?.('#mhgd-panel [data-set]');
        if (!s || busy) return;
        e.preventDefault();
        const parsed = parseClaimTab(dialog());
        const best = planClaim(parsed.groups, parsed.claimLeft, ctx.settings.get('fillOrder'), values());
        const left = (skip) => (Number.isFinite(parsed.claimLeft) ? parsed.claimLeft : Infinity) - Object.entries(wanted()).reduce((n, [t, v]) => n + (t === skip ? 0 : v), 0);
        document.querySelectorAll('#mhgd-panel input[data-type]').forEach((i) => {
          const g = parsed.groups.find((x) => x.type === i.dataset.type);
          if (s.dataset.set === 'best') i.value = best[i.dataset.type] ?? 0;
          else if (s.dataset.set === 'allnone') i.value = 0;
          else if (i.dataset.type === s.dataset.type) i.value = s.dataset.set === 'none' ? 0 : Math.max(0, Math.min(g?.count ?? 0, left(i.dataset.type)));
        });
      });
      scan();

      return { actions: [
        { label: 'Open gifts dialog', run: () => { try { hg.views.GiftSelectorView.showInbox(); } catch (e) { warn(e); } } },
        { label: 'Clear gifting history', run: () => { lsSet(HKEY, emptyHistory()); ctx.setStatus('History cleared'); } },
      ] };
    },
  });
}
