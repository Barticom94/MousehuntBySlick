// Module: Loot Log
// Totals and market value of your hunter's journal (24H / 3D / 7D / 30D / All, by item type).
// Ported from "MouseHunt - Loot Log & Gift Links" 1.3.1 (Adam Harley). Gift links live in gift-links.js.
//
// How it works
// - The game only keeps your newest ~72 journal entries, so this module keeps its own log in
//   IndexedDB (`mh-lootlog-<user id>`), one record per journal entry id.
// - Exact times: every game response's `journal_markup` (horns, trap checks, friend hunts) is
//   captured through the game's own `ajax_response` event, with its `entry_timestamp`.
// - Estimated times: entries that happened while no tab was open come from the journal pages
//   (fetched on load and when the Loot Log opens, at most every 10 min; Sync journal skips the wait)
//   and the page's journal. They only show a time of day, so they are dated by walking back from the
//   nearest known entry, once one exact entry has shown which clock the journal uses. The popup offers a
//   one-click import of MH Improved's own journal history, so 3D/7D aren't empty on day one.
// - Loot = catch loot + extra-loot effects (charms, auras, event boosts) + Satchels of Gold / research
//   points, which also count towards Gold / Points.
// - Item types (Crafting, Potions, Special...) come from the game's own item lookup, cached per item.
//   Values use Markethunt's latest marketplace prices (api.markethunt.win, refreshed every 6 h);
//   items that can't be traded have no price and count as 0.
{
  const TOL = 60 * MIN; // trap checks are back-dated, so a newer entry id can carry an earlier time
  // [label, span, how notes name the period]
  const WINDOWS = [['24H', DAY, 'the last 24 hours'], ['3D', 3 * DAY, 'the last 3 days'], ['7D', 7 * DAY, 'the last 7 days'],
    ['30D', 30 * DAY, 'the last 30 days'], ['All', Infinity, 'your log']];

  // Journal parsing (pure)

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', bull: '•' };
  const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
    try { return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)); } catch { return m; }
  });
  const plain = (html) => decode(String(html).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
  const num = (s) => parseInt(String(s).replace(/\D/g, ''), 10) || 0;

  const LOOT_HEADING = /dropped the following (?:bonus )?(?:loot|prizes?)\s*:?|\bthat dropped\b:?/i;
  // "3 <a ...item...>Name</a>", "1,000 <a>", "an <a>". Quantity must sit right before the link.
  const ITEM_RE = /(?:(\d[\d,.]*)|\b(an?))\s+(?:(?:x|extra|additional|bonus)\s+)?<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  const TYPE_RE = /item_type=(\w+)|ItemView\.show\(\s*(?:'|&#0?39;|\\')(\w+)/;
  const MOUSE_RE = /<a\b[^>]*?(?:MouseView\.show\(\s*(?:'|&#0?39;|\\')|[?&](?:amp;)?mouse=)(\w+)[^>]*>([\s\S]*?)<\/a>/i;

  const parseItems = (html) => {
    const loot = [];
    for (const m of html.matchAll(ITEM_RE)) {
      const t = m[3].match(TYPE_RE);
      if (!t) continue; // mouse / profile links
      loot.push({ type: t[1] || t[2], name: plain(m[4]), qty: m[2] ? 1 : num(m[1]), lucky: /\bclass\s*=\s*["'][^"']*\blucky\b/.test(m[3]) });
    }
    return loot.filter((l) => l.qty > 0);
  };

  // Extra-loot effects (charms, auras, event boosts) are their own entries next to the catch. Items are read
  // from the first trigger word on, so consumed items mentioned before it are not counted.
  // ponytail: allowlist of known effect classes; add new ones as events add them.
  const PROC = new Set(['festiveSpiritLootBoost', 'relicHunter_slayer_aura_relic_bonus', 'desert_heater_base_trigger', 'lunar_new_year_bonus_loot',
    'lunar_new_year_double_loot', 'lunar_new_year_triple_loot', 'rogue_grappler_loot_doubling', 'super_rift_vacuum_trigger', 'rift-bristlewoods-lootBooster',
    'folkloreForest-lootFuelBoost', 'ceruleanSkyport-cannonballLoot', 'boiling_cauldron_potion_bonus']);
  const PROC_TRIGGER = /\b(?:dropped|conjured|found|retrieved|additional|extra|bonus loot|knocked loose)\b/i;
  // Charms that turn into an item ("*POP* Your Unstable Charm ... has turned into a X", Torch Charm "burned out and left
  // behind X"). The game links only the result; MH Improved's rewrite also links the charm, before it, so take the last item.
  const TRANSFORM = new Set(['unstable_charm_trigger', 'torch_charm_event', 'gift_wrapped_charm_trigger']);

  /**
   * @param {{css_class: string, text: string, mouse_type?: string}} entry Raw game HTML (or MHI-rewritten DOM HTML).
   */
  const parseEntry = ({ css_class = '', text = '', mouse_type = null }) => {
    const c = new Set(String(css_class).split(/\s+/).filter(Boolean)); // whole tokens: 'catchsuccess' is a substring of others
    const has = (...n) => n.some((x) => c.has(x));
    text = String(text);
    const t = plain(text);
    const out = {
      kind: 'other', mouse: null, mouseType: null, gold: 0, points: 0, goldLost: 0, pointsLost: 0, loot: [], unparsed: false,
      bonus: has('relicHunter_catch', 'relicHunter_failure', 'prizemouse', 'catchsuccessprize', 'bonuscatchsuccess', 'bonuscatchfailure'),
      origin: has('active') ? 'horn' : has('passive') ? 'trapcheck' : has('linked') ? 'friend' : null,
    };
    if (has('log_summary')) return { ...out, kind: 'summary' };
    if (has('catchsuccess', 'catchsuccessloot', 'catchsuccessprize', 'luckycatchsuccess', 'bonuscatchsuccess', 'relicHunter_catch')) out.kind = 'catch';
    else if (has('catchfailure', 'catchfailuredamage', 'bonuscatchfailure', 'relicHunter_failure')) out.kind = 'miss';
    else if (has('attractionfailure', 'attractionfailurestale')) out.kind = 'fta';
    if (out.kind === 'other') {
      if ([...c].some((x) => TRANSFORM.has(x))) {
        out.kind = 'proc';
        out.loot = parseItems(text).slice(-1);
        out.unparsed = !out.loot.length;
      } else if ([...c].some((x) => PROC.has(x)) && !/fail/i.test(css_class)) {
        const h = text.search(PROC_TRIGGER);
        out.kind = 'proc';
        out.loot = h === -1 ? [] : parseItems(text.slice(h));
        out.unparsed = !out.loot.length;
      }
      return out;
    }

    const mouse = text.match(MOUSE_RE);
    out.mouseType = (typeof mouse_type === 'string' && /^\w+$/.test(mouse_type) && mouse_type) || (mouse && mouse[1]) || null;
    out.mouse = mouse ? plain(mouse[2]) : out.mouseType;

    const gp = t.match(/worth ([\d,]+) points? and ([\d,]+) gold/i);
    if (gp) [out.points, out.gold] = [num(gp[1]), num(gp[2])];

    if (out.kind === 'miss') {
      const g = t.match(/pillaged ([\d,]+) gold/i) || t.match(/Additionally, .+? ([\d,]+) gold/i);
      const p = t.match(/setting me back ([\d,]+) points/i) || t.match(/Additionally, .+? ([\d,]+) points/i);
      if (g) out.goldLost = num(g[1]);
      if (p) out.pointsLost = num(p[1]);
    }

    if (out.kind === 'catch') {
      const h = text.search(LOOT_HEADING);
      if (h !== -1) {
        out.loot = parseItems(text.slice(h).replace(LOOT_HEADING, ''));
        out.unparsed = !out.loot.length; // heading but nothing read: format drift, shown as a warning
      }
    }
    return out;
  };

  // Time of day -> timestamp (pure)

  /** "3:45 pm - " -> minutes since midnight, or null. */
  const parseTod = (s) => {
    const m = /(\d{1,2}):(\d{2})\s*([ap])\.?\s*m/i.exec(String(s ?? ''));
    if (!m) return null;
    return ((+m[1] % 12) + (m[3].toLowerCase() === 'p' ? 12 : 0)) * 60 + +m[2];
  };

  /** Latest instant <= upper whose wall-clock time (at UTC offset `off` minutes) is `tod`. */
  const placeTod = (tod, upper, off) => {
    const wall = upper + off * MIN;
    let t = Math.floor(wall / DAY) * DAY + tod * MIN;
    if (t > wall) t -= DAY;
    return t - off * MIN;
  };

  /** UTC offset (minutes) of the clock that rendered `tod` for the exact time `ts`. Only matters mod 1 day. */
  const calcOffset = (tod, ts) => {
    let o = (((tod - (Math.floor(ts / MIN) % 1440)) % 1440) + 1440) % 1440;
    if (o > 840) o -= 1440;
    return Math.round(o / 15) * 15;
  };

  /**
   * Date entries that only have a time of day, walking newest -> oldest by entry id.
   * @param {Array} cands  [{id, tod, upper?}] entries to date
   * @param {Array} known  [{id, t}] records already dated (anchors)
   */
  const dateWalk = (cands, known, now, off) => {
    const knownIds = new Set(known.map((k) => k.id));
    const all = [...known, ...cands.filter((c) => !knownIds.has(c.id))].sort((a, b) => b.id - a.id);
    let cursor = now;
    const out = [];
    for (const r of all) {
      if (knownIds.has(r.id)) { cursor = r.t; continue; }
      const upper = Math.min(cursor + TOL, now + MIN, r.upper ?? Infinity); // +1 min: PC clock a little behind the server
      const t = r.tod == null ? Math.min(cursor, now) : placeTod(r.tod, upper, off);
      out.push({ ...r, t });
      cursor = t;
    }
    return out;
  };

  // Summaries (pure)

  const summarize = (recs, since, parse = (r) => parseEntry({ css_class: r.cls, text: r.text, mouse_type: r.m })) => {
    const s = { n: 0, est: 0, hunts: 0, catches: 0, misses: 0, ftas: 0, bonus: 0, procs: 0, horn: 0, trapcheck: 0, friend: 0, gold: 0, points: 0, goldLost: 0, pointsLost: 0, unparsed: 0, loot: {}, mice: {} };
    const addLoot = (loot) => {
      for (const l of loot) {
        const it = (s.loot[l.type] ||= { name: l.name, qty: 0, lucky: 0 });
        it.qty += l.qty;
        if (l.lucky) it.lucky += l.qty;
        if (l.qty === 1) it.name = l.name; // prefer the singular name
        // Satchels of Gold / research points are paid out on the spot (type names carry the amount).
        const g = /^gold_satchel_(\d+)_bonus_loot$/.exec(l.type);
        const pt = !g && /_(\d+)_bonus_loot$/.exec(l.type);
        if (g) s.gold += l.qty * +g[1];
        if (pt) s.points += l.qty * +pt[1];
      }
    };
    for (const r of recs) {
      if (!(r.t >= since)) continue;
      s.n++;
      if (r.est) s.est++;
      const p = parse(r);
      if (p.kind === 'proc') { s.procs++; if (p.unparsed) s.unparsed++; addLoot(p.loot); continue; }
      if (p.kind !== 'catch' && p.kind !== 'miss' && p.kind !== 'fta') continue;
      if (!p.bonus) {
        s.hunts++;
        s[{ catch: 'catches', miss: 'misses', fta: 'ftas' }[p.kind]]++;
        if (p.origin) s[p.origin]++;
      } else if (p.kind === 'catch') s.bonus++;
      s.gold += p.gold;
      s.points += p.points;
      s.goldLost += p.goldLost;
      s.pointsLost += p.pointsLost;
      if (p.kind !== 'catch') continue;
      if (p.unparsed) s.unparsed++;
      if (p.mouseType) (s.mice[p.mouseType] ||= { name: p.mouse || p.mouseType, n: 0 }).n++;
      addLoot(p.loot);
    }
    return s;
  };

  // Loot categories and market values (pure)

  // Loot tabs, by the game's item classification. Anything else (map pieces, quest items, bonus loot...) is Other.
  const CATS = [
    ['crafting', 'Crafting', ['crafting_item']], ['potions', 'Potions', ['potion']], ['special', 'Special', ['stat']],
    ['cheese', 'Cheese', ['bait']], ['charms', 'Charms', ['trinket']], ['convertibles', 'Convertibles', ['convertible', 'message_item']],
    ['collectibles', 'Collectibles', ['collectible']], ['gear', 'Traps & skins', ['weapon', 'base', 'skin']], ['other', 'Other', []],
  ];
  const catOf = (classification) => CATS.find(([, , cls]) => cls.includes(classification))?.[0] || 'other';

  /**
   * Loot table rows with category and value, most valuable first.
   * @param {Object} loot   summarize().loot: {type: {name, qty, lucky}}
   * @param {Object} info   {type: [item_id, classification]} from the game
   * @param {Object} prices {item_id: [gold, sb]} from Markethunt
   */
  const lootRows = (loot, info, prices) => Object.entries(loot).map(([type, it]) => {
    const [id, classification] = info[type] || [];
    const p = (id && prices[id]) || null;
    // Satchels of Gold / research points are already in the Gold / Points totals (see summarize).
    const paidAs = /^gold_satchel_\d+_bonus_loot$/.test(type) ? 'Gold' : /_\d+_bonus_loot$/.test(type) ? 'Points' : null;
    return { type, ...it, cat: catOf(classification), known: Boolean(info[type]), paidAs, unit: p ? p[0] : null, value: p ? p[0] * it.qty : 0, sb: p ? p[1] * it.qty : 0 };
  }).sort((a, b) => b.value - a.value || b.qty - a.qty);

  /** Sort rows by a column getter: text A-Z or Z-A, numbers low-high or high-low. Rows with no value (null) stay last. */
  const sortBy = (list, get, dir) => [...list].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    if (x == null || y == null) return (x == null) - (y == null);
    const c = typeof x === 'string' ? x.localeCompare(y, undefined, { sensitivity: 'base' }) : x - y;
    return dir === 'asc' ? c : -c;
  });

  // Exposed for the console (window.mhLootLog) and tests.
  const api = { parseEntry, parseTod, placeTod, calcOffset, dateWalk, summarize, catOf, lootRows, sortBy };
  window.mhLootLog = Object.assign(window.mhLootLog || {}, api);

  // Loot Log popup styles. The shared tokens and the .mhll base live in core/game-theme.js.
  const CSS = `
    .mhll-tabs { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 14px; }
    .mhll-seg { display: inline-flex; border: 1px solid var(--gold-edge); border-radius: 6px; overflow: hidden; }
    .mhll-seg button { padding: 4px 13px; border: 0; border-left: 1px solid var(--gold-edge); background: transparent; }
    .mhll-seg button:first-child { border-left: 0; }
    /* Selected: fill, bold and an ink underline, so it doesn't rely on the fill's colour alone. */
    .mhll-seg button[aria-pressed="true"] { background: var(--gold); color: var(--on-gold); font-weight: bold; box-shadow: inset 0 -2px 0 var(--on-gold); }
    /* Rings inside the control: .mhll-seg and the table scroller clip anything drawn outside. */
    .mhll-seg button:focus-visible, .mhll .mhll-sort:focus-visible { outline-offset: -3px; }
    .mhll-sync { padding: 5px 0; border: 0; background: none; color: var(--dim) !important; text-decoration: underline; text-underline-offset: 2px; }
    .mhll-sync:hover { color: inherit !important; }

    .mhll-head { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr); gap: 22px; padding-bottom: 14px; margin-bottom: 14px; border-bottom: 1px solid var(--rule); }
    .mhll-haul b { display: block; font: normal 34px/1 Georgia, 'Times New Roman', serif; color: var(--gold-ink); letter-spacing: -.5px; }
    .mhll-haul .mhll-lbl { margin: 3px 0 8px; color: var(--dim); }
    /* The gap shows the track between parts, so caught/missed don't rely on green vs rust (1.03:1) to be told apart. */
    .mhll-bar { display: flex; gap: 2px; height: 9px; margin: 7px 0 5px; border-radius: 5px; overflow: hidden; background: var(--rule); }
    .mhll-bar i { display: block; min-width: 0; }
    .mhll-bar .c, .mhll-key .c { background: var(--catch); color: var(--on-c); }
    .mhll-bar .m, .mhll-key .m { background: var(--miss); color: var(--on-m); }
    .mhll-bar .f, .mhll-key .f { background: var(--fta); color: var(--on-f); }
    .mhll-key { display: flex; flex-wrap: wrap; gap: 4px 14px; }
    .mhll-key b { display: inline-block; min-width: 14px; margin-right: 3px; padding: 0 4px; border-radius: 3px; text-align: center; }

    .mhll-cols { display: grid; grid-template-columns: minmax(0, 1.75fr) minmax(0, 1fr); gap: 18px; }
    .mhll h4 { margin: 0 0 6px; font-size: 13px; }
    .mhll h4 small { margin-left: 4px; color: var(--dim); font-weight: normal; }
    .mhll-cats { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
    /* Chips, buttons and sort headers are at least 24px tall (R-03's 44px overridden for this desktop in-game popup; see anti-slop audit 001). */
    .mhll-cats button { padding: 4px 10px; border: 1px solid var(--rule); border-radius: 12px; background: transparent; font-size: 11px; }
    .mhll-cats button[aria-pressed="true"] { background: var(--gold); border-color: var(--gold-edge); color: var(--on-gold); font-weight: bold; }
    .mhll-cats small { opacity: .7; }
    .mhll-cats button[aria-pressed="true"] small { opacity: .9; } /* 7.25:1 light, 4.64:1 dark on the gold fill */
    /* Reserve the scrollbar's width, and pad the last column, so a scrollbar (even one that only appears on hover) never covers numbers.
       scroll-padding keeps a focused row from scrolling under the sticky header. */
    .mhll-scroll { max-height: 290px; overflow: auto; scrollbar-gutter: stable; scrollbar-width: thin; scroll-padding-top: 30px; border-top: 1px solid var(--rule); }
    .mhll-table th { position: sticky; top: 0; z-index: 1; padding: 0; background: var(--head); font-weight: normal; text-align: left; }
    .mhll-sort { display: flex; gap: 4px; align-items: center; width: 100%; min-height: 28px; padding: 3px 6px; border: 0; background: none; color: var(--dim) !important; text-align: inherit; }
    .mhll-n .mhll-sort { justify-content: flex-end; }
    .mhll-sort:hover, [aria-sort="ascending"] .mhll-sort, [aria-sort="descending"] .mhll-sort { color: inherit !important; }
    .mhll-sort i { font-style: normal; font-size: 8px; }
    .mhll-sort i:empty { display: none; }
    .mhll-table th:last-child .mhll-sort { padding-right: 12px; }
    .mhll-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mhll-n, .mhll-table th.mhll-n { text-align: right; white-space: nowrap; }

    .mhll-notes { margin-top: 14px; color: var(--dim); font-size: 11px; }
    .mhll-notes .mhll-warn { color: var(--miss); }
    .mhll-import { margin-top: 8px !important; }
    .mhll-import button { margin-right: 6px; padding: 4px 9px; border: 1px solid var(--gold-edge); border-radius: 6px; background: var(--gold); color: var(--on-gold); font-weight: bold; }
    @media (max-width: 640px) { .mhll-head, .mhll-cols { grid-template-columns: minmax(0, 1fr); } }
  `;

  MH.register({
    id: 'loot-log',
    name: 'Loot Log',
    description: 'Adds a Loot Log menu item: loot, gold and market value from your journal over 24H / 3D / 7D / 30D / All.',
    requires: gameRequires,
    init(ctx) {
  const uid = String(user.user_id);
  const warn = ctx.log.warn;
  let active = true;
  ctx.onStop(() => { active = false; });

  // Storage

  const DB_NAME = `mh-lootlog-${uid}`;
  const STORE = 'entries';
  let dbPromise;
  const db = () => (dbPromise ||= new Promise((resolve, reject) => {
    const rq = indexedDB.open(DB_NAME, 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore(STORE, { keyPath: 'id' });
    rq.onsuccess = () => {
      const d = rq.result;
      d.onversionchange = d.onclose = () => { try { d.close(); } catch {} dbPromise = null; }; // reopen on next use
      resolve(d);
    };
    rq.onerror = () => { dbPromise = null; reject(rq.error); };
  }));
  const run = async (mode, fn) => {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, mode);
      const rq = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(rq && rq.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  };
  const getAll = (minId) => run('readonly', (s) => s.getAll(minId ? IDBKeyRange.lowerBound(minId) : undefined));
  // Merge rule: an exact time always replaces an estimate; otherwise the first record wins.
  const upsert = (recs) => (recs.length ? run('readwrite', (s) => {
    for (const r of recs) s.get(r.id).onsuccess = (e) => { const old = e.target.result; if (!old || (old.est && !r.est)) s.put(r); };
  }) : Promise.resolve());
  const newestIds = async () => {
    const d = await db();
    return new Promise((resolve) => {
      let known = 0;
      const rq = d.transaction(STORE).objectStore(STORE).openCursor(null, 'prev');
      rq.onsuccess = () => {
        const c = rq.result;
        if (!c) return resolve({ known, exact: 0 });
        known ||= c.value.id;
        if (!c.value.est) return resolve({ known, exact: c.value.id });
        c.continue();
      };
      rq.onerror = () => resolve({ known, exact: 0 });
    });
  };

  // Clock the journal's "3:45 pm" uses (account time zone, may differ from the PC). Learned from exact entries;
  // nothing is dated from a time of day until it is known, because a wrong guess shifts entries by a day.
  const TZ_KEY = `mhll-tz-${uid}`;
  const getOffset = () => lsGet(TZ_KEY, null);
  const calibrated = () => getOffset() !== null;

  // Capture

  const fromMarkup = (list) => {
    const was = calibrated();
    const recs = list.map((m) => m && m.render_data).filter((rd) => rd && Number(rd.entry_id) > 0 && Number(rd.entry_timestamp) > 0).map((rd) => {
      const ts = Number(rd.entry_timestamp);
      const t = ts < 1e11 ? ts * 1000 : ts; // the game sends seconds
      return { id: Number(rd.entry_id), t, est: 0, cls: String(rd.css_class || ''), env: String(rd.environment || ''), m: typeof rd.mouse_type === 'string' ? rd.mouse_type : null, text: String(rd.text || ''), src: 'live', tod: parseTod(rd.entry_date) };
    });
    const newest = recs.filter((r) => r.tod != null).sort((a, b) => b.t - a.t)[0];
    if (newest) lsSet(TZ_KEY, calcOffset(newest.tod, newest.t));
    if (!was && calibrated()) setTimeout(backfill, 0); // first calibration: now the time-of-day entries can be dated
    return recs.map(({ tod, ...r }) => r);
  };

  const entryFromEl = (el, src) => {
    const id = Number(el.getAttribute('data-entry-id'));
    if (!Number.isInteger(id) || id <= 0 || el.querySelector('.history-timestamp')) return null; // skip MHI synthetic/history rows
    return {
      id, tod: parseTod(el.querySelector('.journaldate')?.textContent), cls: el.className, env: el.querySelector('.journalenvironment')?.textContent.trim() || '',
      m: el.getAttribute('data-mouse-type') || null, text: el.querySelector('.journaltext')?.innerHTML || '', src,
    };
  };
  const entriesFromPage = (jp) => {
    const html = [jp.entries_string, jp.left_column_string, jp.right_column_string].filter((s) => typeof s === 'string').join('');
    const doc = new DOMParser().parseFromString(html, 'text/html'); // inert: no scripts, no image loads
    return [...doc.querySelectorAll('.entry[data-entry-id]')].map((el) => entryFromEl(el, 'srv')).filter(Boolean);
  };

  /** Date and store time-of-day entries. Resolves true if the oldest one was already logged. */
  const ingestEstimated = async (cands) => {
    const byId = new Map(cands.filter(Boolean).map((c) => [c.id, c]));
    if (!byId.size || !calibrated()) return false;
    const minId = [...byId.keys()].reduce((a, b) => Math.min(a, b));
    const known = (await getAll(minId)).map((r) => ({ id: r.id, t: r.t }));
    const dated = dateWalk([...byId.values()], known, Date.now(), getOffset());
    await upsert(dated.map(({ id, t, cls, env, m, text, src }) => ({ id, t, est: 1, cls, env, m, text, src })));
    return known.some((k) => k.id === minId);
  };

  const onAjax = (resp) => {
    if (!active) return;
    try {
      const exact = Array.isArray(resp?.journal_markup) ? fromMarkup(resp.journal_markup) : [];
      const jp = resp?.journal_page;
      const page = jp && String(jp.owner_user_id) === uid ? entriesFromPage(jp) : []; // never log a friend's journal
      if (exact.length || page.length) upsert(exact).then(() => ingestEstimated(page)).catch(warn);
    } catch (e) { warn(e); }
  };

  const post = async (path, params) => {
    const base = typeof callbackurl !== 'undefined' && callbackurl ? callbackurl : 'https://www.mousehuntgame.com/';
    const lastRead = typeof lastReadJournalEntryId !== 'undefined' && lastReadJournalEntryId ? lastReadJournalEntryId : 0;
    const res = await fetch(base + path, {
      method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ sn: 'Hitgrab', hg_is_ajax: 1, last_read_journal_entry_id: lastRead, uh: user.unique_hash, ...params }),
    });
    return res.json();
  };

  // Read the journal pages to fill gaps from hunts while no tab was open (the game keeps ~72 entries).
  // Page 1 also asks for entries newer than our newest exact one, which may come back with exact times.
  const SYNC_KEY = `mhll-sync-${uid}`;
  let syncing = null;
  let syncFailed = false;
  const syncJournal = (force) => (syncing ||= (async () => {
    if (!force && Date.now() - lsGet(SYNC_KEY, 0) < 10 * MIN) return;
    lsSet(SYNC_KEY, Date.now());
    syncFailed = false;
    const { exact } = await newestIds();
    const domMin = domSnapshot.reduce((a, e) => Math.min(a, e.id), Infinity);
    const lastRead = exact || (Number.isFinite(domMin) ? domMin - 1 : 0);
    const size = document.querySelector(`.journalContainer[data-owner="${uid}"]`)?.dataset.size || 'jlarge';
    for (let page = 1; page <= 6; page++) {
      const params = { page, size, owner: uid };
      if (lastRead && page === 1) params.last_read_journal_entry_id = lastRead;
      const resp = await post('managers/ajax/pages/journal.php', params);
      if (!resp || !resp.success) { syncFailed = true; break; }
      if (Array.isArray(resp.journal_markup)) await upsert(fromMarkup(resp.journal_markup));
      if (!calibrated()) { lsSet(SYNC_KEY, 0); break; } // retried after the first hunt calibrates the clock
      const jp = resp.journal_page;
      const ents = jp && (jp.owner_user_id == null || String(jp.owner_user_id) === uid) ? entriesFromPage(jp) : [];
      const reachedLogged = await ingestEstimated(ents);
      const pager = jp && jp.pager;
      if (!ents.length || reachedLogged || (pager && (pager.has_next === false || page >= Number(pager.total || Infinity)))) break;
      await sleep(500);
    }
  })().catch((e) => { warn(e); syncFailed = true; }).finally(() => { syncing = null; }));

  const backfill = async () => {
    await syncJournal(false);
    await ingestEstimated(domSnapshot);
  };

  // Opt-in import of MH Improved's journal history (IndexedDB `mh-improved-journal`). It is per browser, not per
  // account, and its timestamp is when MHI saw the entry, so it only serves as an upper bound for the time of day.
  const readMhiJournal = () => new Promise((resolve) => {
    let rq;
    try { rq = indexedDB.open('mh-improved-journal'); } catch { return resolve([]); }
    rq.onupgradeneeded = (e) => e.target.transaction.abort(); // doesn't exist: don't create it
    rq.onerror = rq.onblocked = () => resolve([]);
    rq.onsuccess = () => {
      const d = rq.result;
      d.onversionchange = () => d.close();
      if (!d.objectStoreNames.contains('journal')) { d.close(); return resolve([]); }
      const out = [];
      const tx = d.transaction('journal', 'readonly');
      tx.objectStore('journal').openCursor().onsuccess = (e) => { const c = e.target.result; if (c) { out.push(c.value); c.continue(); } };
      tx.oncomplete = tx.onerror = tx.onabort = () => { d.close(); resolve(out); };
    };
  });
  const MHI_FLAG = `mhll-mhi-import-${uid}`;
  let importNote = null; // [text, isWarning] after the import button is used
  const importMhi = async () => {
    if (!calibrated()) return 0;
    const rows = await readMhiJournal();
    const cands = rows.map((r) => r && r.data).filter((d) => d && Number(d.id) > 0 && d.text).map((d) => ({
      id: Number(d.id), tod: parseTod(d.date), upper: Number(d.timestamp) || undefined, cls: Array.isArray(d.type) ? d.type.join(' ') : String(d.type || ''),
      env: String(d.location || ''), m: typeof d.mouse === 'string' ? d.mouse : null, text: String(d.text), src: 'mhi',
    }));
    await ingestEstimated(cands);
    lsSet(MHI_FLAG, cands.length);
    return cands.length;
  };

  // Item details and market prices

  const VERSION = '1.3.1';
  const ITEMS_KEY = 'mhll-items-v1'; // {type: [item_id, classification]} from the game; an item's class never changes
  const PRICES_KEY = 'mhll-prices-v1'; // {at, date, p: {item_id: [gold, sb]}} from Markethunt
  const PRICE_EVERY = 6 * 60 * MIN; // Markethunt publishes daily prices
  const noInfo = new Set(); // types the game didn't return this session, so we don't ask again
  let lookupPausedUntil = 0;

  // The game's own item lookup (any item, owned or not); one request for all new types.
  const fetchItemInfo = (types) => new Promise((resolve) => {
    try {
      hg.utils.UserInventory.getItems(types, (items) => {
        const info = lsGet(ITEMS_KEY, {});
        for (const it of Array.isArray(items) ? items : []) if (it && it.type) info[it.type] = [Number(it.item_id) || 0, String(it.classification || '')];
        lsSet(ITEMS_KEY, info);
        types.forEach((t) => info[t] || noInfo.add(t));
        resolve(true);
      }, () => resolve(false));
    } catch (e) { warn(e); resolve(false); }
  });
  const ensureItemInfo = async (types) => {
    const info = lsGet(ITEMS_KEY, {});
    const missing = types.filter((t) => !info[t] && !noInfo.has(t) && !/_\d+_bonus_loot$/.test(t)); // satchels etc. need no lookup
    if (!missing.length || !hg?.utils?.UserInventory?.getItems || Date.now() < lookupPausedUntil) return false;
    if (await fetchItemInfo(missing)) return true;
    // The batch failed. If one type on its own fails too, it's most likely the connection/session: pause, retry later.
    if (!(await fetchItemInfo([missing[0]]))) { noInfo.add(missing[0]); lookupPausedUntil = Date.now() + 5 * MIN; return true; } // redraw as failed
    for (const t of missing.slice(1)) { await sleep(250); if (!(await fetchItemInfo([t]))) noInfo.add(t); } // one bad type mustn't block the rest
    return true;
  };

  const ensurePrices = async () => {
    const cur = lsGet(PRICES_KEY, null);
    if (cur && Date.now() - cur.at < PRICE_EVERY) return false;
    // A failure waits 30 min (other tabs too). With no earlier prices, date stays '' and the popup reads that as failed.
    lsSet(PRICES_KEY, { p: {}, date: '', ...cur, at: Date.now() - PRICE_EVERY + 30 * MIN });
    pricesLoading = true;
    try {
      const res = await fetch(`https://api.markethunt.win/items?plugin_ver=adamh-lootlog-${VERSION}`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`Markethunt ${res.status}`);
      const p = {};
      let date = '';
      for (const x of await res.json()) {
        const id = x?.item_info?.item_id;
        const m = x?.latest_market_data;
        if (!id || !(m?.price > 0) || x.item_info.currently_tradeable === false) continue;
        p[id] = [Math.round(m.price), Number(m.sb_price) || 0];
        if (String(m.date || '') > date) date = String(m.date);
      }
      if (!date) throw new Error('Markethunt returned no prices'); // keep the old prices and the 30-min backoff
      lsSet(PRICES_KEY, { at: Date.now(), date, p });
      return true;
    } finally {
      pricesLoading = false;
    }
  };
  let pricesLoading = false;

  // Fetch whatever the open popup is missing. A call made while a fetch is running waits for it and then
  // fetches only what is still missing for its own types (e.g. after switching to a longer window).
  let enriching = null;
  const enrich = (types) => (enriching ? enriching.then(() => enrich(types)) : (enriching = Promise.all([
    ensureItemInfo(types),
    ensurePrices().catch((e) => { warn(e); return true; }), // redraw to show the failure
  ]).then(([a, b]) => a || b).finally(() => { enriching = null; })));

  // Loot Log popup

  const WIN_KEY = 'mhll-window';
  const CAT_KEY = 'mhll-category';
  const SORT_KEY = 'mhll-sort';
  // Sortable columns: [getter, direction on first click]. Untradeable items have no value, so they sort last.
  const COLS = {
    loot: { name: [(r) => r.name, 'asc'], qty: [(r) => r.qty, 'desc'], value: [(r) => (r.unit == null ? null : r.value), 'desc'] },
    mice: { name: [(r) => r.name, 'asc'], n: [(r) => r.n, 'desc'] },
  };
  const DEFAULT_SORT = { loot: ['value', 'desc'], mice: ['n', 'desc'] };
  const getSort = (table) => {
    const s = lsGet(SORT_KEY, {})?.[table];
    return Array.isArray(s) && COLS[table][s[0]] && ['asc', 'desc'].includes(s[1]) ? s : DEFAULT_SORT[table];
  };
  const parseCache = new Map();
  const parseRec = (r) => {
    const hit = parseCache.get(r.id);
    if (hit && hit.text === r.text) return hit.p;
    const p = parseEntry({ css_class: r.cls, text: r.text, mouse_type: r.m });
    parseCache.set(r.id, { text: r.text, p });
    return p;
  };
  const date = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const time = (t) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const itemLink = (type, name) => `<a href="https://www.mousehuntgame.com/item.php?item_type=${type}" data-mhll-item="${type}" onclick="hg.views.ItemView.show('${type}'); return false;">${esc(name)}</a>`;
  const mouseLink = (type, name) => (/^\w+$/.test(type) ? `<a href="#" data-mhll-mouse="${type}" onclick="hg.views.MouseView.show('${type}'); return false;">${esc(name)}</a>` : esc(name));

  /** Popup body for a time window. Returns the html and the window's loot item types (to fetch details for). */
  const renderBody = (recs, label) => {
    if (!recs) return { html: '<div class="mhll-notes"><p class="mhll-warn">Couldn\'t read the loot log from browser storage (details in the console). Reload the page to try again.</p></div>', types: [] };
    const [, span, period] = WINDOWS.find(([l]) => l === label) ?? WINDOWS[0];
    const now = Date.now();
    const s = summarize(recs, now - span, parseRec);
    const oldest = recs.reduce((a, r) => Math.min(a, r.t), Infinity);
    const count = (n, one, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;
    const sorted = (table, list) => { const [key, dir] = getSort(table); return sortBy(sortBy(list, (r) => r.name, 'asc'), COLS[table][key][0], dir); }; // ties A-Z
    const mice = sorted('mice', Object.entries(s.mice).map(([type, m]) => ({ type, ...m })));
    const th = (table, key, label, num) => {
      const [k, d] = getSort(table);
      const on = k === key;
      return `<th class="${num ? 'mhll-n' : ''}" aria-sort="${on ? (d === 'asc' ? 'ascending' : 'descending') : 'none'}">`
        + `<button type="button" class="mhll-sort" data-mhll-sort="${table}:${key}" title="Sort by ${label.toLowerCase()}">${label}<i aria-hidden="true">${on ? (d === 'asc' ? '▲' : '▼') : ''}</i></button></th>`;
    };

    const priceData = lsGet(PRICES_KEY, null);
    const hasPrices = Boolean(priceData?.date);
    const rows = lootRows(s.loot, lsGet(ITEMS_KEY, {}), priceData?.p || {});
    const sum = (list, k) => list.reduce((a, r) => a + r[k], 0);
    const lootValue = sum(rows, 'value');
    const unknownRows = rows.filter((r) => !r.known && !r.paidAs); // item lookup pending or failed: value unknown, not 0
    const lookupDown = !hg?.utils?.UserInventory?.getItems || now < lookupPausedUntil;
    const failed = unknownRows.filter((r) => lookupDown || noInfo.has(r.type)).length;
    const pending = unknownRows.length - failed;
    const unknown = unknownRows.length;
    const unpriced = rows.filter((r) => r.known && r.unit == null && !r.paidAs).length;
    const net = s.gold - s.goldLost + lootValue;
    const present = CATS.filter(([key]) => rows.some((r) => r.cat === key));
    let cat = lsGet(CAT_KEY, 'all');
    if (!present.some(([key]) => key === cat)) cat = 'all';
    const shown = sorted('loot', cat === 'all' ? rows : rows.filter((r) => r.cat === cat));
    // '' when nothing in the list has a known value (e.g. only unidentified items), so no "worth 0+" is shown.
    const worth = (list) => {
      const v = sum(list, 'value');
      const unk = list.some((r) => !r.known && !r.paidAs);
      return !hasPrices || (!v && unk) ? '' : `${fmt(v)}${unk ? '+' : ''}`;
    };
    const catTab = (key, name, list) => `<button type="button" data-mhll-cat="${key}" aria-pressed="${key === cat}" title="${worth(list) && `Worth ${worth(list)} gold`}">${name} <small>${fmt(list.length)}</small></button>`;
    const catTabs = present.length > 1 ? catTab('all', 'All', rows) + present.map(([key, name]) => catTab(key, name, rows.filter((r) => r.cat === key))).join('') : '';
    const sbText = (n) => n.toLocaleString(undefined, { maximumFractionDigits: n < 10 ? 2 : n < 100 ? 1 : 0 });
    const plus = unknown ? '+' : '';
    const valueCell = (r) => (r.paidAs ? `<small>in ${r.paidAs}</small>`
      : !r.known ? '<span class="mhll-dim" role="img" aria-label="value not loaded yet" title="Item details not loaded from the game yet">?</span>'
        : !hasPrices ? '<span class="mhll-dim" role="img" aria-label="price not loaded" title="Waiting for Markethunt prices">…</span>'
        : r.unit == null ? '<span class="mhll-dim" role="img" aria-label="not tradeable" title="Not tradeable on the Marketplace">–</span>'
          : `<span title="${fmt(r.unit)} gold each">${fmt(r.value)}</span>`);
    const lootRow = (r) => `<tr><td class="mhll-name" title="${esc(r.name)}">${itemLink(r.type, r.name)}</td>`
      + `<td class="mhll-n">${fmt(r.qty)}</td><td class="mhll-n">${valueCell(r)}</td></tr>`;

    const notes = []; // [text, isWarning]
    if (!calibrated()) notes.push(['Your earlier journal entries show a time but no date. They appear here after your next hunt, which tells the Loot Log your journal\'s time zone.']);
    if (syncFailed) notes.push(['Couldn\'t read your journal pages from MouseHunt. Try Sync journal again in a minute.', true]);
    if (importNote) notes.push(importNote);
    if (!recs.length) notes.push(['No journal entries logged yet. Sound the horn and they will start appearing here.']);
    else {
      notes.push([`Your log goes back to ${date(oldest)} (${count(recs.length, 'entry', 'entries')}).`]);
      if (span !== Infinity && now - span < oldest) notes.push([`These totals only cover part of ${period}, because your log starts later.`]);
      if (s.est) notes.push([`${fmt(s.est)} of ${fmt(s.n)} entries here have estimated times, because they happened while no MouseHunt tab was open.`]);
      if (s.procs) notes.push([`Loot includes ${count(s.procs, 'extra-loot effect')} from charms, auras or event boosts.`]);
      if (hasPrices && rows.length) notes.push([`Values are Markethunt prices from ${new Date(`${priceData.date}T12:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}.${unpriced ? ` ${count(unpriced, 'item')} can't be traded, so ${unpriced === 1 ? 'it has' : 'they have'} no value (shown as –).` : ''}`]);
      if (s.unparsed) notes.push([`${count(s.unparsed, 'entry', 'entries')} had loot the Loot Log couldn't read, so the totals leave it out.`, true]);
      if (pending) notes.push([`Looking up ${count(pending, 'item')} in the game…`]);
      if (failed) notes.push([`${count(failed, 'item')} couldn't be looked up in the game, so ${failed === 1 ? 'it has' : 'they have'} no value or item type yet (shown as ?), and totals marked + leave ${failed === 1 ? 'it' : 'them'} out. Reopen the Loot Log later to retry.`, true]);
    }
    const offerImport = calibrated() && lsGet(MHI_FLAG, null) === null
      ? '<p class="mhll-import"><button type="button" data-mhll-import>Import older history from MH Improved</button> MH Improved keeps one history per browser, so skip this if another account hunts in this browser.</p>'
      : '';

    // The haul: gold plus what the loot would fetch on the Marketplace.
    const haul = hasPrices
      ? `<b>${fmt(net)}${plus}</b><p class="mhll-lbl">gold and loot value</p>
         <p>${fmt(s.gold - s.goldLost)} gold and ${fmt(lootValue)}${plus} in loot${lootValue ? ` <span class="mhll-dim mhll-nowrap">(about ${sbText(sum(rows, 'sb'))} SB)</span>` : ''}</p>
         ${s.hunts ? `<p>${fmt(net / s.hunts)}${plus} per hunt</p>` : ''}`
      : `<b>${fmt(s.gold - s.goldLost)}</b><p class="mhll-lbl">gold</p>
         <p class="mhll-dim">${!rows.length ? `No loot to value in ${period}.`
           : pricesLoading || !priceData || now >= priceData.at + PRICE_EVERY ? 'Loot value loading…' // a fetch is running or about to start
             : `Markethunt didn't respond, so loot isn't valued yet. Retrying after ${time(priceData.at + PRICE_EVERY)}.`}</p>`;
    const share = (n) => (s.hunts ? Math.round((n / s.hunts) * 100) : 0);
    const seg = (cls, n) => (n ? `<i class="${cls}" style="flex-grow:${n}"></i>` : ''); // only non-zero parts, so the gaps stay single
    const record = `
      <p><strong>${count(s.hunts, 'hunt')}</strong>: ${fmt(s.horn)} by horn, ${count(s.trapcheck, 'trap check')}, ${fmt(s.friend)} with friends</p>
      <div class="mhll-bar" role="img" aria-label="${fmt(s.catches)} caught, ${fmt(s.misses)} missed, ${fmt(s.ftas)} didn't attract">${seg('c', s.catches)}${seg('m', s.misses)}${seg('f', s.ftas)}</div>
      <p class="mhll-key"><span><b class="c">${fmt(s.catches)}</b> caught (${share(s.catches)}%)</span><span><b class="m">${fmt(s.misses)}</b> missed</span><span><b class="f">${fmt(s.ftas)}</b> didn't attract</span></p>
      <p>${fmt(s.points)} points${s.pointsLost ? ` <span class="mhll-dim">(${fmt(s.pointsLost)} lost)</span>` : ''}${s.goldLost ? `, ${fmt(s.goldLost)} gold pillaged` : ''}${s.bonus ? `, plus ${count(s.bonus, 'bonus catch', 'bonus catches')}` : ''}</p>`;

    const html = `
      <div class="mhll-head"><div class="mhll-haul">${haul}</div><div class="mhll-record">${record}</div></div>
      <div class="mhll-cols">
        <section>
          <h4>Loot <small>${count(shown.length, 'item')}${worth(shown) ? `, worth ${worth(shown)} gold` : ''}</small></h4>
          ${catTabs ? `<div class="mhll-cats" role="group" aria-label="Item type">${catTabs}</div>` : ''}
          <div class="mhll-scroll"><table class="mhll-table">
            <colgroup><col><col style="width:calc(8ch + 12px)"><col style="width:calc(12ch + 18px)"></colgroup>
            <thead><tr>${th('loot', 'name', 'Item')}${th('loot', 'qty', 'Qty', true)}${th('loot', 'value', 'Value', true)}</tr></thead>
            <tbody>${shown.map(lootRow).join('') || `<tr><td colspan="3" class="mhll-dim">No loot in ${period}.</td></tr>`}</tbody>
          </table></div>
        </section>
        <section>
          <h4>Mice caught <small>${count(mice.length, 'kind')}</small></h4>
          <div class="mhll-scroll"><table class="mhll-table">
            <colgroup><col><col style="width:68px"></colgroup>
            <thead><tr>${th('mice', 'name', 'Mouse')}${th('mice', 'n', 'Caught', true)}</tr></thead>
            <tbody>${mice.map((m) => `<tr><td class="mhll-name" title="${esc(m.name)}">${mouseLink(m.type, m.name)}</td><td class="mhll-n">${fmt(m.n)}</td></tr>`).join('') || `<tr><td colspan="2" class="mhll-dim">No catches in ${period}.</td></tr>`}</tbody>
          </table></div>
        </section>
      </div>
      <div class="mhll-notes">${notes.map(([t, w]) => `<p${w ? ' class="mhll-warn"' : ''}>${esc(t)}</p>`).join('')}${offerImport}</div>`;
    return { html, types: rows.map((r) => r.type) };
  };

  const renderTabs = (label) => `<div class="mhll-seg" role="group" aria-label="Time window">${WINDOWS.map(([l]) => `<button type="button" data-mhll-win="${l}" aria-pressed="${l === label}">${l}</button>`).join('')}</div>`
    + '<button type="button" data-mhll-sync class="mhll-sync" title="Re-read your journal pages now">Sync journal</button>';

  // Fill in categories/prices the window's loot is missing, then redraw once.
  const enrichPopup = (types) => { if (types.length) enrich(types).then((changed) => changed && refreshPopup(false)).catch(warn); };

  const refreshPopup = async (enrichAfter = true) => {
    const label = lsGet(WIN_KEY, '24H');
    const recs = await getAll().catch((e) => { warn(e); return null; });
    const box = document.querySelector('.mhll-tabs')?.closest('.mhll'); // not a Gift links popup, which has no tabs
    if (!box) return;
    // Re-rendering replaces the controls, so put keyboard focus back on the same one, or on the time window if it's gone.
    const active = box.contains(document.activeElement) ? document.activeElement : null;
    const attr = active && ['data-mhll-sort', 'data-mhll-win', 'data-mhll-cat', 'data-mhll-sync', 'data-mhll-import', 'data-mhll-item', 'data-mhll-mouse']
      .find((a) => active.hasAttribute(a));
    const { html, types } = renderBody(recs, label);
    box.querySelector('.mhll-tabs').innerHTML = renderTabs(label);
    box.querySelector('.mhll-body').innerHTML = html;
    if (active) (attr && box.querySelector(`[${attr}="${CSS.escape(active.getAttribute(attr))}"]`) || box.querySelector('[data-mhll-win][aria-pressed="true"]'))?.focus();
    if (enrichAfter) enrichPopup(types);
  };


  const showPopup = (title, html, cls) => showGamePopup(title, html, cls, warn);

  const openLootLog = async () => {
    const label = lsGet(WIN_KEY, '24H');
    const recs = await getAll().catch((e) => { warn(e); return null; });
    importNote = null;
    const { html, types } = renderBody(recs, label);
    showPopup('Loot Log', `<div class="mhll" tabindex="-1"><div class="mhll-tabs">${renderTabs(label)}</div><div class="mhll-body">${html}</div></div>`, 'mhll-popup');
    enrichPopup(types);
    syncJournal(false).then(() => refreshPopup()).catch(warn);
  };

  ctx.listen(document, 'click', (e) => {
    const win = e.target.closest?.('[data-mhll-win]');
    if (win) { lsSet(WIN_KEY, win.dataset.mhllWin); refreshPopup().catch(warn); return; }
    const cat = e.target.closest?.('[data-mhll-cat]');
    if (cat) { lsSet(CAT_KEY, cat.dataset.mhllCat); refreshPopup().catch(warn); return; }
    const sort = e.target.closest?.('[data-mhll-sort]');
    if (sort) {
      const [table, key] = sort.dataset.mhllSort.split(':');
      if (!COLS[table]?.[key]) return;
      const [k, d] = getSort(table);
      lsSet(SORT_KEY, { ...lsGet(SORT_KEY, {}), [table]: [key, k === key ? (d === 'asc' ? 'desc' : 'asc') : COLS[table][key][1]] }); // same column flips
      refreshPopup().catch(warn);
      return;
    }
    // Busy buttons use aria-disabled, not disabled: disabling the focused button would drop keyboard focus.
    const sync = e.target.closest?.('[data-mhll-sync]');
    if (sync) {
      if (sync.getAttribute('aria-disabled') === 'true') return;
      sync.setAttribute('aria-disabled', 'true');
      sync.textContent = 'Syncing…';
      syncJournal(true).finally(() => refreshPopup()).catch(warn);
      return;
    }
    const imp = e.target.closest?.('[data-mhll-import]');
    if (imp) {
      if (imp.getAttribute('aria-disabled') === 'true') return;
      imp.setAttribute('aria-disabled', 'true');
      imp.textContent = 'Importing…';
      importMhi()
        .then((n) => { importNote = [n ? `Read ${fmt(n)} journal ${n === 1 ? 'entry' : 'entries'} from MH Improved.` : 'MH Improved has no journal history in this browser, so there was nothing to import.']; })
        .catch((err) => { warn(err); importNote = ['Couldn\'t import from MH Improved. Try again.', true]; })
        .finally(() => refreshPopup().catch(warn));
      return;
    }
  });

  const addMenu = () => {
    if (document.getElementById('mhll-menu')) return;
    const a = document.createElement('a');
    a.id = 'mhll-menu';
    a.className = 'menuItem mhll-menu';
    a.href = '#';
    a.title = 'Loot Log';
    a.textContent = 'Loot Log';
    // Lets MH Improved's Custom Menu move, hide or iconify it.
    Object.assign(a.dataset, { mhMenuId: 'mhll-menu', mhMenuName: 'Loot Log', mhMenuPosition: 'prepend', mhMenuIcon: 'https://i.mouse.rip/icons/chart.png' });
    a.addEventListener('click', (e) => { e.preventDefault(); openLootLog(); });
    const bar = document.querySelector('.mousehuntHeaderView-gameTabs .mousehuntHeaderView-dropdownContainer');
    if (bar) bar.prepend(a);
    else { a.classList.add('mhll-float'); document.body.append(a); }
  };

  const domSnapshot = [...document.querySelectorAll(`.journalContainer[data-owner="${uid}"] .entry[data-entry-id]`)].map((el) => entryFromEl(el, 'dom')).filter(Boolean); // before MHI rewrites the text
  ctx.addStyle(CSS);
  // Fixed id: the registry keys listeners by a random 0-10000 id when none is given, so a clash would overwrite one.
  // (There is no way to remove it again, so onAjax checks `active` instead.)
  eventRegistry.addEventListener('ajax_response', onAjax, null, false, undefined, 'mhll-loot-log-ajax');
  addMenu();
  ctx.every(addMenu, MIN);
  ctx.onStop(() => document.getElementById('mhll-menu')?.remove());
  const showCount = () => getAll().then((r) => ctx.setStatus(`${fmt(r.length)} journal ${r.length === 1 ? 'entry' : 'entries'} logged`)).catch(warn);
  ctx.setStatus('Logging journal entries');
  backfill().catch(warn).finally(showCount);
  ctx.every(showCount, MIN);

  return { actions: [{ label: 'Open Loot Log', run: openLootLog }] };
    },
  });
}
