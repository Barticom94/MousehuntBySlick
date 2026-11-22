// ==UserScript==
// @name         MouseHunt Super Script
// @namespace    adamh-mousehunt
// @version      1.2.0
// @description  One script for MouseHunt with a control panel: Auto Horn & King's Reward solver, Loot Log, Gift Links, Map Invites. Built from modules in src/.
// @author       Adam Harley (Auto Horn & KR Solver: Slick, fork of daniellok)
// @license      MIT
// @match        https://www.mousehuntgame.com/*
// @match        https://mousehuntgame.com/*
// @match        http://www.mousehuntgame.com/*
// @match        http://mousehuntgame.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=mousehuntgame.com
// @require      https://cdn.jsdelivr.net/npm/tesseract.js@4.0.2/dist/tesseract.min.js
// @run-at       document-end
// @grant        none
// @noframes
// @downloadURL  https://raw.githubusercontent.com/Barticom94/MousehuntBySlick/main/dist/MHbS.js
// @updateURL    https://raw.githubusercontent.com/Barticom94/MousehuntBySlick/main/dist/MHbS.js
// ==/UserScript==

(function () {
'use strict';

// ---- core/10-util.js ----
// Small helpers shared by the core and every module. Core files share one scope; module files are block-scoped.

const MH_VERSION = '1.2.0'; // replaced by build.mjs from package.json

const DAY = 864e5;
const MIN = 6e4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const fmt = (n) => Math.round(n).toLocaleString();
const fmtDate = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const toText = (html) => new DOMParser().parseFromString(String(html ?? ''), 'text/html').body.textContent.trim();

const coreLog = {
  debug: (...a) => console.debug('[MH Super]', ...a),
  warn: (...a) => console.warn('[MH Super]', ...a),
};
const makeLog = (tag) => ({
  debug: (...a) => console.debug(`[${tag}]`, ...a),
  warn: (...a) => console.warn(`[${tag}]`, ...a),
});

// localStorage as JSON, never throwing (private windows, quota, blocked storage).
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { coreLog.warn('localStorage write failed', e); } };

// ---- core/20-settings.js ----
// Persisted settings: one localStorage entry, { [moduleId]: { enabled?: boolean, values?: { [key]: value } } }.
// It is re-read on every access, so several open MouseHunt tabs don't overwrite each other with stale copies.

const SETTINGS_KEY = 'mhs-settings-v1';

const Settings = (() => {
  const load = () => { const v = lsGet(SETTINGS_KEY, {}); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; };
  const update = (id, fn) => { const all = load(); const slot = (all[id] && typeof all[id] === 'object' ? all[id] : (all[id] = {})); fn(slot); lsSet(SETTINGS_KEY, all); };
  const specOf = (def, key) => (def.settings || []).find((s) => s.key === key);

  // Coerce to the field's type and clamp to its range; anything unusable falls back to the default.
  const normalize = (spec, v) => {
    if (spec.type === 'checkbox') return Boolean(v);
    if (spec.type === 'select') return spec.options.some((o) => o.value === v) ? v : spec.default;
    let n = parseInt(v, 10);
    if (Number.isNaN(n)) n = spec.default;
    return Math.max(spec.min ?? -Infinity, Math.min(spec.max ?? Infinity, n));
  };

  return {
    has: (def) => def.id in load(),
    isEnabled: (def) => { const e = load()[def.id]?.enabled; return typeof e === 'boolean' ? e : def.enabledByDefault !== false; },
    setEnabled: (def, on) => update(def.id, (s) => { s.enabled = Boolean(on); }),
    get(def, key) {
      const spec = specOf(def, key);
      const v = load()[def.id]?.values?.[key];
      return v === undefined ? spec?.default : normalize(spec, v);
    },
    set(def, key, v) {
      const spec = specOf(def, key);
      if (!spec) return undefined;
      const value = normalize(spec, v);
      update(def.id, (s) => { (s.values ||= {})[key] = value; });
      return value;
    },
    /** Seed values once (e.g. migrating a predecessor script's settings) without touching `enabled`. */
    seed(def, values) {
      for (const [k, v] of Object.entries(values || {})) if (specOf(def, k)) this.set(def, k, v);
    },
    resetValues: (def) => update(def.id, (s) => { delete s.values; }),
    resetAll: () => lsSet(SETTINGS_KEY, {}),
  };
})();

// ---- core/30-registry.js ----
// Module registry and lifecycle.
//
// A feature is a module: MH.register({ id, name, description, settings, requires, init(ctx) }).
//   - settings: [{ key, label, type: 'number'|'checkbox'|'select', default, min, max, unit, options, help }]
//   - requires(): return a reason string when the module can't run on this page, else null/undefined.
//   - init(ctx): start the feature. It may return { actions: [{ label, run }] } for buttons in the panel.
//     Everything it registers through ctx (listeners, timers, styles) is removed when the module is switched off.
// ctx: id, log, alive(), settings.get(key), setStatus(text, level), addStyle(css), every(fn, ms),
//      listen(target, type, fn, opts), onStop(fn).

const MH = (() => {
  const mods = new Map(); // id -> { def, state: 'off'|'running'|'unavailable'|'error', status, handle, ctx }
  const subs = [];
  const emit = (type, id) => subs.forEach((fn) => { try { fn(type, id); } catch (e) { coreLog.warn(e); } });

  const makeCtx = (rec) => {
    const { def } = rec;
    const disposers = [];
    let alive = true;
    let styleN = 0;
    const ctx = {
      id: def.id,
      log: makeLog(def.name),
      alive: () => alive,
      settings: { get: (key) => Settings.get(def, key) },
      setStatus(text, level = 'ok') {
        if (!alive) return;
        rec.status = { text, level };
        emit('status', def.id);
      },
      addStyle(css) {
        const el = document.createElement('style');
        el.id = `mhs-${def.id}-style-${++styleN}`;
        el.textContent = css;
        document.head.append(el);
        disposers.push(() => el.remove());
      },
      every(fn, ms) {
        const t = setInterval(() => { if (alive) fn(); }, ms);
        disposers.push(() => clearInterval(t));
      },
      listen(target, type, fn, opts) {
        target.addEventListener(type, fn, opts);
        disposers.push(() => target.removeEventListener(type, fn, opts));
      },
      onStop: (fn) => { disposers.push(fn); },
    };
    ctx.dispose = () => {
      alive = false;
      while (disposers.length) { try { disposers.pop()(); } catch (e) { coreLog.warn(e); } }
    };
    return ctx;
  };

  const start = (id) => {
    const rec = mods.get(id);
    if (!rec || rec.state === 'running') return;
    rec.status = { text: '', level: 'ok' };
    const why = rec.def.requires?.();
    if (why) { rec.state = 'unavailable'; rec.status = { text: why, level: 'warn' }; emit('state', id); return; }
    const ctx = makeCtx(rec);
    try {
      rec.handle = rec.def.init(ctx) || {};
      rec.ctx = ctx;
      rec.state = 'running';
      if (!rec.status.text) rec.status = { text: 'Running', level: 'ok' };
    } catch (e) {
      ctx.dispose();
      coreLog.warn(`${rec.def.name} failed to start`, e);
      rec.state = 'error';
      rec.status = { text: `Failed to start: ${e?.message || e}`, level: 'error' };
    }
    emit('state', id);
  };

  const stop = (id) => {
    const rec = mods.get(id);
    if (!rec || !rec.ctx) { if (rec) { rec.state = 'off'; rec.status = { text: '', level: 'ok' }; emit('state', id); } return; }
    try { rec.handle?.stop?.(); } catch (e) { coreLog.warn(e); }
    rec.ctx.dispose();
    rec.ctx = rec.handle = null;
    rec.state = 'off';
    rec.status = { text: '', level: 'ok' };
    emit('state', id);
  };

  return {
    version: MH_VERSION,
    modules: mods,
    subscribe: (fn) => subs.push(fn),
    register(def) {
      if (mods.has(def.id)) throw new Error(`Duplicate module id: ${def.id}`);
      def.settings ||= [];
      mods.set(def.id, { def, state: 'off', status: { text: '', level: 'ok' }, handle: null, ctx: null });
    },
    start,
    stop,
    setEnabled(id, on) {
      const rec = mods.get(id);
      Settings.setEnabled(rec.def, on);
      if (on) start(id); else stop(id);
    },
    /** Called once the page is ready: seed migrated settings, then start every enabled module. */
    boot() {
      for (const { def } of mods.values()) {
        if (def.migrate && !Settings.has(def)) { try { Settings.seed(def, def.migrate()); } catch (e) { coreLog.warn(e); } }
        if (Settings.isEnabled(def)) start(def.id);
      }
    },
  };
})();

// ---- core/40-game.js ----
// Game integration shared by modules: the page-context globals, the game's popup dialog and the shared "game look".

const gameRequires = () => (typeof user === 'undefined' || !user || !user.user_id || !user.unique_hash || typeof hg === 'undefined' || typeof eventRegistry === 'undefined'
  ? 'MouseHunt globals not found on this page' : null);

const showGamePopup = (title, html, cls, warn = coreLog.warn) => {
  if (typeof jsDialog === 'undefined') { warn('jsDialog missing'); return null; }
  const p = new jsDialog();
  p.setIsModal(false);
  p.setTemplate('default');
  p.addToken('{*title*}', title);
  p.addToken('{*content*}', html);
  p.setAttributes({ className: cls });
  p.show();
  // The game's dialog doesn't move focus, so a keyboard user would be left behind the popup.
  const root = document.querySelector(`.${cls}`);
  (root?.querySelector('[aria-pressed="true"]') || root?.querySelector('.mhll'))?.focus();
  return p;
};

// Look shared by the Loot Log and Gift Links popups and fallbacks: the game's own gold and wood.
const GAME_THEME_CSS = `
    /* Loot Log: the game's own gold and wood, sized to fit inside its popup. The gift pill and fallbacks share the tokens. */
    .mhll, #mhll-gift-alert, .mhll-float {
      --ink: #3b2b1a; --dim: #76695c; --rule: rgba(59, 43, 26, .16); --zebra: rgba(59, 43, 26, .045); --head: #faf4e6;
      --gold: #f3d377; --gold-edge: #b8891d; --on-gold: #3b2b1a; --gold-ink: #87590a;
      --catch: #4a7a2e; --miss: #b4532f; --fta: #b6a78a; --on-c: #fff; --on-m: #fff; --on-f: #3b2b1a; /* all >= 4.8:1 */
    }
    body.mh-dark :is(.mhll, #mhll-gift-alert, .mhll-float), .mh-dark-mode :is(.mhll, #mhll-gift-alert, .mhll-float) {
      --ink: #ecdfc6; --dim: rgba(236, 223, 198, .6); --rule: rgba(236, 223, 198, .18); --zebra: rgba(255, 255, 255, .04); --head: #2c2720;
      --gold: #7a5f1d; --gold-edge: #b18a32; --on-gold: #fbefcf; --gold-ink: #eabd52;
      --catch: #86b866; --miss: #dd7d5d; --fta: #8d8473; --on-c: #1d160c; --on-m: #1d160c; --on-f: #1d160c;
    }
    .mhll { width: 100%; box-sizing: border-box; font-size: 12px; line-height: 1.45; text-align: left; }
    .mhll p { margin: 0 0 3px; }
    .mhll button { font: inherit; color: inherit; cursor: pointer; }
    /* gold-ink: >= 3:1 against every surface a ring sits on (white, header tint, gold fills) in both themes */
    .mhll button:focus-visible { outline: 2px solid var(--gold-ink); outline-offset: 1px; }
    .mhll [aria-disabled="true"] { cursor: progress; }
    .mhll-dim { color: var(--dim); }
    .mhll-nowrap { white-space: nowrap; }
    .mhll-table { width: 100%; border-collapse: collapse; table-layout: fixed; font-variant-numeric: tabular-nums; }
    .mhll-table td, .mhll-table th { padding: 3px 6px; vertical-align: top; }
    .mhll-table td:last-child { padding-right: 12px; }
    .mhll-table tbody tr:nth-child(even) { background: var(--zebra); }
    .mhll-float { position: fixed; top: 8px; right: 8px; z-index: 99999; box-shadow: 0 2px 8px rgba(0,0,0,.35); }
    #mhll-gift-alert.mhll-float { top: 40px; } /* below the fallback Loot Log button, not on top of it */
    a.mhll-float { padding: 4px 10px; border: 1px solid var(--gold-edge); border-radius: 10px; background: var(--gold); color: var(--on-gold); }
`;

// ---- core/50-panel.js ----
// Control panel: a launcher button and a settings card per module, in a shadow root so the game's CSS can't touch it.

const Panel = (() => {
  const LEVEL_RANK = { ok: 0, warn: 1, error: 2 };

  const h = (tag, props = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (['value', 'checked', 'textContent'].includes(k)) el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    el.append(...kids.flat().filter((c) => c != null && c !== false));
    return el;
  };

  const CSS = `
    :host { all: initial; position: fixed; right: 14px; bottom: 14px; z-index: 99998; font: 13px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif; text-align: left;
      --bg: #fffaf0; --card: #fff; --ink: #3b2b1a; --dim: #6b5e50; --rule: rgba(59,43,26,.18); --gold: #f3d377; --gold-edge: #b8891d; --on-gold: #3b2b1a; --gold-ink: #87590a;
      --ok: #3f7a24; --warn: #a86a00; --err: #b4332f; --off: #8d8473; }
    :host([data-theme=dark]) { --bg: #241f19; --card: #2e2820; --ink: #ecdfc6; --dim: #b3a78f; --rule: rgba(236,223,198,.2); --gold: #7a5f1d; --gold-edge: #b18a32;
      --on-gold: #fbefcf; --gold-ink: #eabd52; --ok: #86b866; --warn: #e0a64a; --err: #e8806f; --off: #8d8473; }
    * { box-sizing: border-box; }
    button, input, select { font: inherit; color: inherit; }
    button { cursor: pointer; }
    :focus-visible { outline: 2px solid var(--gold-ink); outline-offset: 2px; }
    .launcher { position: relative; display: block; margin-left: auto; width: 42px; height: 42px; border-radius: 50%; border: 2px solid var(--gold-edge); background: var(--gold); color: var(--on-gold);
      font-size: 14px; font-weight: bold; line-height: 1; box-shadow: 0 2px 8px rgba(0,0,0,.35); }
    .launcher .dot { position: absolute; top: -2px; right: -2px; width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--bg); background: var(--ok); }
    .launcher .dot[data-level=warn] { background: var(--warn); } .launcher .dot[data-level=error] { background: var(--err); } .launcher .dot[data-level=idle] { background: var(--off); }
    .panel { width: min(380px, calc(100vw - 28px)); max-height: min(78vh, 640px); margin-bottom: 10px; display: flex; flex-direction: column; background: var(--bg); color: var(--ink);
      border: 1px solid var(--gold-edge); border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.4); overflow: hidden; }
    .panel[hidden] { display: none; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; background: var(--gold); color: var(--on-gold); }
    header h2 { margin: 0; font-size: 14px; } header small { margin-left: 6px; font-weight: normal; opacity: .8; }
    header button { width: 28px; height: 28px; border: 0; border-radius: 6px; background: transparent; font-size: 18px; line-height: 1; }
    header button:hover { background: rgba(0,0,0,.12); }
    .body { padding: 10px; overflow: auto; display: grid; gap: 8px; }
    .notice { margin: 0; padding: 7px 9px; border: 1px solid var(--warn); border-radius: 6px; color: var(--ink); background: var(--card); }
    .card { padding: 9px 10px; border: 1px solid var(--rule); border-radius: 8px; background: var(--card); }
    .top { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
    .card h3 { margin: 0; font-size: 13px; } .card p { margin: 2px 0 0; color: var(--dim); font-size: 12px; }
    .switch { flex: none; position: relative; width: 38px; height: 22px; padding: 0; border: 1px solid var(--gold-edge); border-radius: 11px; background: transparent; }
    .switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--off); }
    .switch[aria-checked=true] { background: var(--gold); } .switch[aria-checked=true]::after { transform: translateX(16px); background: var(--on-gold); }
    .status { margin: 6px 0 0; font-size: 12px; color: var(--dim); }
    .status::before { content: ''; display: inline-block; width: 8px; height: 8px; margin-right: 6px; border-radius: 50%; background: var(--ok); }
    .status[data-level=warn]::before { background: var(--warn); } .status[data-level=error]::before { background: var(--err); } .status[data-level=off]::before { background: var(--off); }
    .status[data-level=warn], .status[data-level=error] { color: var(--ink); }
    .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .btn { padding: 4px 10px; border: 1px solid var(--gold-edge); border-radius: 6px; background: transparent; font-size: 12px; }
    .btn:hover { background: var(--gold); color: var(--on-gold); }
    details { margin-top: 8px; border-top: 1px solid var(--rule); padding-top: 6px; }
    summary { cursor: pointer; font-size: 12px; color: var(--dim); user-select: none; }
    .field { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 6px 0; font-size: 12px; }
    .field input[type=number], .field select { width: 110px; padding: 3px 6px; border: 1px solid var(--rule); border-radius: 4px; background: var(--bg); text-align: right; }
    .field .unit { display: inline-block; min-width: 26px; margin-left: 4px; color: var(--dim); }
    .field-help { margin: -2px 0 6px; font-size: 11px; }
    footer { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--rule); font-size: 11px; color: var(--dim); }
  `;

  const create = () => {
    const host = h('div', { id: 'mhs-root' });
    const root = host.attachShadow({ mode: 'open' });
    const openDetails = new Set(); // module ids whose settings are expanded; survives re-renders
    const notices = [];

    const dot = h('span', { class: 'dot', 'data-level': 'idle' });
    const launcher = h('button', { class: 'launcher', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'mhs-panel', title: 'MouseHunt Super Script', 'aria-label': 'Open MouseHunt Super Script control panel' }, 'MH', dot);
    const mods = h('div', { class: 'body' });
    const panel = h('section', { class: 'panel', id: 'mhs-panel', role: 'dialog', 'aria-label': 'MouseHunt Super Script control panel', hidden: true });

    const setOpen = (open) => {
      panel.hidden = !open;
      launcher.setAttribute('aria-expanded', String(open));
      if (open) { render(); panel.querySelector('.close')?.focus(); } else launcher.focus();
    };
    launcher.addEventListener('click', () => setOpen(panel.hidden));
    // Keep game hotkeys from reacting to typing in the panel; Escape closes it.
    panel.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') setOpen(false); });

    const statusEl = (id) => mods.querySelector(`[data-status="${id}"]`);
    const paintStatus = (id) => {
      const rec = MH.modules.get(id);
      const el = statusEl(id);
      if (!el) return;
      const off = rec.state === 'off';
      el.dataset.level = off ? 'off' : rec.status.level;
      el.textContent = off ? 'Off' : rec.status.text;
    };

    const field = (rec, spec) => {
      const { def } = rec;
      const id = `f-${def.id}-${spec.key}`;
      const value = Settings.get(def, spec.key);
      let input;
      if (spec.type === 'checkbox') {
        input = h('input', { id, type: 'checkbox', checked: value, onchange: () => Settings.set(def, spec.key, input.checked) });
      } else if (spec.type === 'select') {
        input = h('select', { id, onchange: () => Settings.set(def, spec.key, input.value) }, spec.options.map((o) => h('option', { value: o.value }, o.label)));
        input.value = value;
      } else {
        input = h('input', { id, type: 'number', min: spec.min, max: spec.max, step: spec.step || 1, value });
        input.addEventListener('change', () => { input.value = Settings.set(def, spec.key, input.value); });
      }
      return [
        h('div', { class: 'field' }, h('label', { for: id }, spec.label), h('span', {}, input, spec.unit && h('span', { class: 'unit' }, spec.unit))),
        spec.help && h('p', { class: 'field-help' }, spec.help),
      ];
    };

    const card = (rec) => {
      const { def } = rec;
      const on = Settings.isEnabled(def);
      const sw = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': String(on), 'aria-label': `Enable ${def.name}`, onclick: () => MH.setEnabled(def.id, !Settings.isEnabled(def)) });
      const actions = rec.state === 'running' && rec.handle?.actions?.length
        ? h('div', { class: 'actions' }, rec.handle.actions.map((a) => h('button', { class: 'btn', type: 'button', onclick: () => { try { a.run(); } catch (e) { coreLog.warn(e); } } }, a.label)))
        : null;
      let settings = null;
      if (def.settings.length) {
        settings = h('details', { ontoggle: (e) => { if (e.target.open) openDetails.add(def.id); else openDetails.delete(def.id); } },
          h('summary', {}, 'Settings'),
          def.settings.flatMap((spec) => field(rec, spec)),
          h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => { Settings.resetValues(def); render(); } }, 'Reset to defaults')));
        if (openDetails.has(def.id)) settings.open = true;
      }
      return h('div', { class: 'card', 'data-mod': def.id },
        h('div', { class: 'top' }, h('div', {}, h('h3', {}, def.name), h('p', {}, def.description)), sw),
        h('p', { class: 'status', 'data-status': def.id, role: 'status' }),
        actions, settings);
    };

    const render = () => {
      mods.replaceChildren(
        ...notices.map((n) => h('p', { class: 'notice', role: 'alert' }, n)),
        ...[...MH.modules.values()].map(card),
      );
      for (const id of MH.modules.keys()) paintStatus(id);
    };

    const paintDot = () => {
      let worst = 'idle';
      let rank = -1;
      for (const rec of MH.modules.values()) {
        if (rec.state === 'off') continue;
        const level = rec.state === 'error' ? 'error' : rec.state === 'unavailable' ? 'warn' : rec.status.level;
        if (LEVEL_RANK[level] > rank) { rank = LEVEL_RANK[level]; worst = level; }
      }
      dot.dataset.level = worst;
    };

    MH.subscribe((type, id) => {
      if (type === 'status') paintStatus(id);
      else if (!panel.hidden) render();
      paintDot();
    });

    const resetAll = h('button', { class: 'btn', type: 'button', onclick: () => {
      if (!confirm('Reset every module to its default settings? Modules you switched off turn back on.')) return;
      Settings.resetAll();
      for (const [id, rec] of MH.modules) { if (rec.state === 'running') MH.stop(id); if (Settings.isEnabled(rec.def)) MH.start(id); }
      render();
    } }, 'Reset all');
    panel.append(
      h('header', {}, h('h2', {}, 'MouseHunt Super Script', h('small', {}, `v${MH.version}`)),
        h('button', { class: 'close', type: 'button', 'aria-label': 'Close control panel', onclick: () => setOpen(false) }, '×')),
      mods,
      h('footer', {}, h('span', {}, 'Changes save automatically.'), resetAll),
    );

    // Follow the game's dark mode.
    const syncTheme = () => { host.dataset.theme = document.querySelector('body.mh-dark, .mh-dark-mode') ? 'dark' : 'light'; };
    syncTheme();
    new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['class'], subtree: true });

    root.append(h('style', {}, CSS), panel, launcher);
    document.body.append(host);
    paintDot();
    return { addNotice: (text) => { notices.push(text); if (!panel.hidden) render(); } };
  };

  return { create };
})();

// ---- modules/auto-horn.js ----
{
// Module: Auto Horn & King's Reward Solver
// Sounds the hunter's horn when it is ready (after a random delay) and OCR-solves King's Reward puzzles.
// Ported from "Mousehunt Auto Horn & KR Solver (Slick's fork)" 0.6.1, a fork of daniellok's original
// (https://github.com/daniellok/mousehunt-auto-kr, MIT). Needs Tesseract.js (see @require in the header).
{
  const PUZZLE_ACTIVE_SELECTOR = '.puzzleView--active';
  const PUZZLE_IMAGE_SELECTOR = '.puzzleView__image > img';
  const PUZZLE_CODE_INPUT = '.puzzleView__code';
  const PUZZLE_SUBMIT_BUTTON = '.puzzleView__solveButton';
  const PUZZLE_NEW_CODE_LINK = '.puzzleView__requestNewPuzzleButton';
  const HORN_READY_SELECTOR = '.huntersHornView__horn--reveal';

  const pad = (n) => String(n).padStart(2, '0');
  const formatTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const log = (message) => console.log(`${formatTime(new Date())}: ${message}`);

  async function soundHorn() {
    const horn = document.querySelector(HORN_READY_SELECTOR);
    horn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await sleep(500);
    horn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    await sleep(2000);
    const messageText = document.querySelector('.huntersHornView__message').textContent;
    if (messageText !== '') window.location.reload();
  }

  function getSecsToNextHorn() {
    const timerText = document.querySelector('.huntersHornView__timerState--type-countdown').textContent;
    const [mins, secs] = timerText.split(':');
    return Number(mins) * 60 + Number(secs);
  }

  function loadImage(img) {
    return new Promise((resolve, reject) => {
      const newImg = new Image();
      newImg.crossorigin = 'Anonymous';
      newImg.onload = () => resolve(newImg);
      newImg.onerror = () => reject();
      newImg.src = img.src;
    });
  }

  MH.register({
    id: 'auto-horn',
    name: 'Auto Horn & KR Solver',
    description: "Sounds the horn when it's ready and solves King's Reward puzzles with OCR.",
    settings: [
      { key: 'solveKR', type: 'checkbox', label: "Solve King's Reward automatically", default: true,
        help: 'Off: the horn pauses while a puzzle is up, and resumes once you solve it yourself.' },
      { key: 'hornDelayMin', type: 'number', label: 'Horn delay min', unit: 'sec', min: 0, max: 600, default: 10 },
      { key: 'hornDelayMax', type: 'number', label: 'Horn delay max', unit: 'sec', min: 0, max: 600, default: 180 },
      { key: 'krVerifyDelay', type: 'number', label: 'KR verify delay', unit: 'ms', min: 500, max: 30000, default: 3000, help: 'Wait after submitting before checking it worked.' },
      { key: 'krNewCodeDelay', type: 'number', label: 'KR new-code wait', unit: 'ms', min: 500, max: 30000, default: 5000 },
      { key: 'krPreSubmitDelay', type: 'number', label: 'KR pre-submit pause', unit: 'ms', min: 100, max: 10000, default: 1000 },
      { key: 'krRetryLimit', type: 'number', label: 'KR retry limit', min: 1, max: 10, default: 3, help: 'OCR attempts before giving up.' },
      { key: 'refreshIntervalMin', type: 'number', label: 'Auto-refresh', unit: 'min', min: 1, max: 240, default: 30 },
    ],
    // Carry over the tuning from the standalone script's settings panel.
    migrate: () => lsGet('mh_auto_horn_cfg_v1', null),
    requires: () => (document.getElementById('mousehuntContainer') ? null : 'MouseHunt page not found'),

    init(ctx) {
      const S = (key) => ctx.settings.get(key);
      let krPending = false; // the horn is paused for a manual King's Reward

      async function solveKR() {
        if (typeof Tesseract === 'undefined') throw new Error('Tesseract.js is not loaded (check the @require line in your userscript manager)');
        const img = document.querySelector(PUZZLE_IMAGE_SELECTOR);
        const newImg = await loadImage(img);
        const canvas = document.createElement('canvas');
        canvas.width = 200;
        canvas.height = 58;
        canvas.getContext('2d').drawImage(newImg, 0, 0);
        const worker = await Tesseract.createWorker();
        let rawCode;
        try {
          await worker.loadLanguage('eng');
          await worker.initialize('eng');
          rawCode = (await worker.recognize(canvas)).data.text.trim();
        } finally {
          await worker.terminate().catch(() => {});
        }
        const code = rawCode.replaceAll(/[^A-Za-z0-9]/g, '');
        if (code.length !== 5) {
          log("OCR failed! Couldn't determine characters");
          await getNewCodeImage();
          return false;
        }
        log(`OCR success! Code: ${code}`);
        const codeInput = document.querySelector(PUZZLE_CODE_INPUT);
        codeInput.value = code;
        codeInput.dispatchEvent(new KeyboardEvent('keyup'));
        await sleep(S('krPreSubmitDelay'));
        document.querySelector(PUZZLE_SUBMIT_BUTTON).click();
        await sleep(S('krVerifyDelay'));
        return !document.querySelector('.puzzleView--active');
      }

      async function getNewCodeImage() {
        document.querySelector(PUZZLE_NEW_CODE_LINK).click();
        await sleep(S('krNewCodeDelay'));
      }

      const getRandomHornDelay = () => Math.max(Math.random() * S('hornDelayMax'), S('hornDelayMin'));

      const renderWaitingForHorn = (nextHornTime) => {
        const secs = Math.floor((nextHornTime - Date.now()) / 1e3);
        ctx.setStatus(`Waiting for next horn. Next horn at ${formatTime(new Date(nextHornTime))} (${secs} seconds)`);
      };

      async function getState() {
        if (document.querySelector(HORN_READY_SELECTOR)) {
          log('Sounding horn...');
          await soundHorn();
          log('Horn sounded!');
        }
        if (document.querySelector(PUZZLE_ACTIVE_SELECTOR)) {
          if (!S('solveKR')) {
            krPending = true;
            ctx.setStatus("King's Reward is up and auto-solve is off. Solve it yourself; the horn resumes after.", 'warn');
            return Date.now() + 5000;
          }
          log('Solving KR...');
          let success = false;
          let retryCount = 0;
          while (!success && retryCount < S('krRetryLimit')) {
            ctx.setStatus(`Solving KR (attempt ${retryCount + 1}/${S('krRetryLimit')})`);
            success = await solveKR();
            retryCount++;
            if (!success) log('Failed to solve KR, retrying...');
          }
          if (success) {
            log('KR solved!');
            window.location.reload();
          } else {
            alert(`Failed to solve KR ${S('krRetryLimit')} times. Please solve it manually and refresh the page when finished!`);
            return -1;
          }
        }
        krPending = false;
        const secsToNextHorn = getSecsToNextHorn();
        const nextHornTime = Date.now() + (secsToNextHorn + getRandomHornDelay()) * 1e3;
        renderWaitingForHorn(nextHornTime);
        log(`Next horn time: ${formatTime(new Date(nextHornTime))}`);
        return nextHornTime;
      }

      async function loop() {
        let nextHornTime = 0;
        const lastRefreshTime = Date.now();
        while (ctx.alive()) {
          if (Date.now() - lastRefreshTime > S('refreshIntervalMin') * 60000) window.location.reload();
          try {
            if (nextHornTime === -1) break;
            else if (nextHornTime > Date.now()) {
              if (nextHornTime < getSecsToNextHorn()) nextHornTime = await getState();
              if (!krPending) renderWaitingForHorn(nextHornTime);
              await sleep(1000);
            } else {
              nextHornTime = await getState();
            }
          } catch (e) {
            // The standalone script silently died here. Report it and try again shortly instead.
            ctx.log.warn(e);
            ctx.setStatus(`Error: ${e?.message || e}. Retrying...`, 'warn');
            nextHornTime = 0;
            await sleep(5000);
          }
        }
        if (nextHornTime === -1) ctx.setStatus("Stopped: couldn't solve the King's Reward. Solve it manually and refresh.", 'error');
      }

      ctx.setStatus('Starting...');
      loop();
    },
  });
}

}

// ---- modules/daily-gifting.js ----
{
// Module: Daily Gifting
// One-click daily gifting from the game's own gifts dialog (Gifts menu > View More Gifts):
//   1. shows what is waiting grouped by gift type (no senders) with a count to claim per type;
//   2. ACCEPTS those gifts (never "and Return") up to the daily claim limit, via the game's own Accept buttons;
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
      { key: 'clickGapMs', type: 'number', label: 'Pause between game clicks', unit: 'ms', min: 100, max: 5000, default: 700 },
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
        const rows = parsed.groups.map((g) => `<tr><td>${esc(g.type)}</td><td class="n">${g.count} waiting</td><td class="n"><label>Claim <input type="number" min="0" max="${g.count}" data-type="${esc(g.type)}" value="${esc(keep[g.type] ?? plan[g.type] ?? 0)}"></label></td></tr>`).join('');
        const dis = busy ? ' disabled' : '';
        panel.innerHTML = `<b>Daily gifting</b> <span class="dim">${total} waiting${Number.isFinite(parsed.claimLeft) ? `, ${parsed.claimLeft} claims left today` : ''}</span>
          <table>${rows || '<tr><td>No gifts waiting.</td></tr>'}</table>
          <button type="button" data-act="both"${dis}>Claim &amp; send gifts</button><button type="button" class="sec" data-act="claim"${dis}>Claim only</button><button type="button" class="sec" data-act="send"${dis}>Send only</button>
          <div class="st" role="status">${esc(status)}</div>`;
        host.after(panel);
      };
      const redraw = () => { const p = document.getElementById('mhgd-panel'); if (p) p.dataset.sig = ''; const r = dialog(); if (r) draw(r); };

      const wanted = () => Object.fromEntries([...document.querySelectorAll('#mhgd-panel input[data-type]')].map((i) => [i.dataset.type, Math.max(0, parseInt(i.value, 10) || 0)]));

      // Accepts through the game's own Accept button (never "and Return"), oldest of each type first.
      const claim = async (root) => {
        const parsed = parseClaimTab(root);
        const want = wanted();
        const gap = ctx.settings.get('clickGapMs');
        let left = Number.isFinite(parsed.claimLeft) ? parsed.claimLeft : Infinity;
        let done = 0;
        for (const g of parsed.groups) {
          for (const r of g.rows.slice(0, Math.min(want[g.type] ?? 0, g.count))) {
            if (left <= 0 || !ctx.alive()) break;
            const before = num(q(root, 'numClaimActionsRemaining'));
            r.accept.click();
            const ok = await waitFor(() => !root.contains(r.el) || num(q(root, 'numClaimActionsRemaining')) < before);
            if (!ok) return { done, error: `The game didn't confirm claiming ${g.type}. Stopped after ${done}.` };
            done++; left--;
            setStatus(`Claimed ${done}…`);
            await sleep(gap);
          }
        }
        return { done };
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
        const root = dialog();
        if (!root) { setStatus('Open the Free Gifts dialog first.'); return; }
        busy = true;
        draw(root);
        document.querySelectorAll('#mhgd-panel button').forEach((b) => { b.disabled = true; });
        const parts = [];
        try {
          if (mode !== 'send') { const r = await claim(root); parts.push(`Claimed ${r.done}.`); if (r.error) { parts.push(r.error); mode = 'claim'; } }
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
        if (b) { e.preventDefault(); run(b.dataset.act); }
      });
      scan();

      return { actions: [
        { label: 'Open gifts dialog', run: () => { try { hg.views.GiftSelectorView.showInbox(); } catch (e) { warn(e); } } },
        { label: 'Clear gifting history', run: () => { lsSet(HKEY, emptyHistory()); ctx.setStatus('History cleared'); } },
      ] };
    },
  });
}

}

// ---- modules/gift-links.js ----
{
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

}

// ---- modules/loot-log.js ----
{
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

}

// ---- modules/map-invites.js ----
{
// Module: Map Invites
// One click invites as many friends as the treasure map has open slots, using the game's own endpoints
// (hg.utils.User.getFriends for the friend list, hg.utils.TreasureMapUtil.getMapInfo / sendInvites for the map),
// in a single request instead of ticking names in the invite dialog.
// Mirrors the game's own invite dialog: open slots = max_hunters - num_active_hunters.
{
  const MAP_FIELDS = ['map_name', 'wanted_poster_name', 'event_map_name'];

  /**
   * Friends to invite, best first: friends on no map, then favourites among the rest, then friends already on another
   * map (the game's dialog lets you invite those too). Skips hunters on this map and ones already invited.
   * Pure, so it can be tested without the game.
   */
  const pickInvitees = (friends, map, favourites = []) => {
    const skip = new Set([...(map.invited_hunters || []), ...(map.hunters || []).map((h) => h.sn_user_id)].map(String));
    const fav = new Set((favourites || []).map(String));
    const slots = Math.max(0, (Number(map.max_hunters) || 0) - (Number(map.num_active_hunters) || 0));
    const busy = (f) => MAP_FIELDS.some((k) => f[k]);
    const rank = (f) => (busy(f) ? (fav.has(String(f.sn_user_id)) ? 1 : 2) : 0);
    const picked = friends.filter((f) => f && f.sn_user_id && !skip.has(String(f.sn_user_id)))
      .map((f, i) => ({ f, i, r: rank(f) })).sort((a, b) => a.r - b.r || a.i - b.i)
      .slice(0, slots).map(({ f }) => String(f.sn_user_id));
    return { slots, ids: picked };
  };
  window.mhMapInvites = Object.assign(window.mhMapInvites || {}, { pickInvitees });

  const call = (fn, ...args) => new Promise((ok, err) => fn(...args, ok, err));

  MH.register({
    id: 'map-invites',
    name: 'Map Invites',
    description: 'One click invites the most friends your current treasure map has room for.',
    requires: gameRequires,
    init(ctx) {
      let busy = false;
      ctx.setStatus('Ready');

      const run = async () => {
        if (busy) return;
        busy = true;
        try {
          if (typeof hg === 'undefined' || !hg.utils?.TreasureMapUtil || !hg.utils?.User) throw new Error('map tools not found on this page');
          const q = user.quests?.QuestRelicHunter;
          const mapId = q?.default_map_id;
          if (!mapId) { ctx.setStatus('You have no treasure map selected', 'warn'); return; }
          ctx.setStatus('Checking the map...');
          const info = await call(hg.utils.TreasureMapUtil.getMapInfo, mapId);
          const map = info.treasure_map;
          if (!map) throw new Error('the game returned no map');
          if (!map.is_owner && map.can_send_invites === false) { ctx.setStatus('You can\'t send invites for this map', 'warn'); return; }
          const open = (Number(map.max_hunters) || 0) - (Number(map.num_active_hunters) || 0);
          if (open <= 0) { ctx.setStatus(`${map.name} is full (${map.num_active_hunters}/${map.max_hunters} hunters)`, 'warn'); return; }
          const friends = await call(hg.utils.User.getFriends, MAP_FIELDS);
          const { slots, ids } = pickInvitees(friends, map, hg.utils.TreasureMapUtil.getFavouriteFriends());
          if (!ids.length) { ctx.setStatus(`No friends left to invite (${slots} open, all friends already on the map or invited)`, 'warn'); return; }
          ctx.setStatus(`Inviting ${ids.length}...`);
          const res = await call(hg.utils.TreasureMapUtil.sendInvites, mapId, ids);
          if (res && res.success === false) throw new Error('the game refused the invites');
          ctx.setStatus(`Invited ${ids.length} of ${slots} open slot${slots === 1 ? '' : 's'} on ${map.name}`);
        } catch (e) {
          ctx.log.warn(e);
          ctx.setStatus(`Invites failed: ${e?.message || e}`, 'warn');
        } finally { busy = false; }
      };

      return { actions: [{ label: 'Invite max friends to my map', run }] };
    },
  });
}

}

// ---- modules/sos-autoswap.js ----
{
// Module: School of Sorcery Auto-Swap
// Arms your saved Arcane or Shadow setup to match the current School of Sorcery course, including the Final Exam
// flip every 30 hunts. Ported from "MouseHunt - School of Sorcery Auto-Swap" 1.0.0 (Adam Harley).
// Mock-only so far: not verified on the live game.
//
// The game exposes the current phase at user.quests.QuestSchoolOfSorcery.current_course:
//   course_type 'arcane_101_course' | 'shadow_101_course' | 'exam_course'
//   power_type 'arcane' | 'shadow' (flips every 30 hunts in the Final Exam)
//   power_type_hunts_remaining: hunts until the next Final Exam flip
// After every horn (and whenever the phase changes) it compares your armed trap/base/charm (optionally cheese)
// with the setup you saved for that power type and arms what differs through the game's hg.utils.TrapControl.
// Manual trap changes are left alone until your next horn. Setup: at School of Sorcery arm your Arcane setup and
// click "Save current" under Arcane; do the same for Shadow.
{
  // The game's XHR is patched once per page; the patch forwards to whichever instance is running.
  let hook = null;
  let patched = false;
  const patchXhr = () => {
    if (patched) return;
    patched = true;
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (...args) {
      this.addEventListener('load', () => {
        const url = String(this.responseURL || '');
        if (hook && url.includes('/managers/ajax/')) hook(url);
      });
      return origOpen.apply(this, args);
    };
  };

  MH.register({
    id: 'sos-autoswap',
    name: 'School of Sorcery Auto-Swap',
    description: 'Arms your saved Arcane or Shadow setup to match the current course. Save setups from the panel it adds at School of Sorcery.',
    settings: [
      { key: 'swapBait', type: 'checkbox', label: 'Swap cheese too', default: false },
    ],
    // Carry over the standalone script's options.
    migrate() {
      const old = lsGet('mh-sos-autoswap', null) || {};
      if (old.enabled === false) Settings.setEnabled(MH.modules.get('sos-autoswap').def, false);
      return { swapBait: Boolean(old.swapBait) };
    },
    requires: () => (typeof window.user === 'undefined' ? 'MouseHunt globals not found on this page' : null),
    init(ctx) {

  const W = window;
  const STORE_KEY = 'mh-sos-autoswap'; // same key as the standalone script, so saved setups carry over
  const PANEL_ID = 'mh-sos-autoswap';
  const ENV = 'school_of_sorcery';
  const SLOTS = ['weapon', 'base', 'trinket', 'bait'];
  const SLOT_LABEL = { weapon: 'Trap', base: 'Base', trinket: 'Charm', bait: 'Cheese' };
  const POWER = { arcane: 'Arcane', shadow: 'Shadow' };
  const OTHER = { arcane: 'shadow', shadow: 'arcane' };
  const COURSE_NAME = { arcane_101_course: 'Arcane Arts', shadow_101_course: 'Shadow Sciences', exam_course: 'Final Exam' };

  // ---- settings

  const load = () => {
    const saved = lsGet(STORE_KEY, null) || {};
    return Object.assign({}, saved, { setups: Object.assign({ arcane: null, shadow: null }, saved.setups) });
  };

  let settings = load(); // { setups: { arcane, shadow } } plus the standalone script's old fields, kept as they were
  const persist = () => lsSet(STORE_KEY, settings);
  const swapBait = () => ctx.settings.get('swapBait');

  // ---- game state

  const getUser = () => W.user || {};

  const getCourse = (u = getUser()) => {
    if (u.environment_type !== ENV) return null;
    const quest = u.quests && u.quests.QuestSchoolOfSorcery;
    if (!quest || !quest.in_course || !quest.current_course) return null;
    return quest.current_course;
  };

  const phaseOf = (course) => (course ? `${course.course_type}:${course.power_type}` : 'none');

  // ---- swapping

  let busy = false;
  let lastPhase = null;
  const blocked = new Set(); // "slot:id" that failed to arm this phase (e.g. out of charms)

  const pendingItems = (setup, u) => SLOTS
    .filter((slot) => slot !== 'bait' || swapBait())
    .filter((slot) => setup[slot] && setup[slot].id)
    .filter((slot) => Number(setup[slot].id) !== Number(u[`${slot}_item_id`]))
    .filter((slot) => !blocked.has(`${slot}:${setup[slot].id}`))
    .map((slot) => ({ slot, id: Number(setup[slot].id), name: setup[slot].name }));

  const armItems = (items) => {
    const tc = W.hg.utils.TrapControl;
    const request = new Promise((resolve, reject) => {
      items.forEach(({ slot, id }) => tc.armItem(id, slot));
      tc.go(resolve, reject);
    });
    const timeout = new Promise((resolve, reject) => setTimeout(() => reject(new Error('timeout')), 20000));
    return Promise.race([request, timeout]);
  };

  const check = async () => {
    const u = getUser();
    const course = getCourse(u);
    const phase = phaseOf(course);
    if (phase !== lastPhase) blocked.clear();
    lastPhase = phase;

    if (!ctx.alive() || busy || !course) return;
    if (!(W.hg && W.hg.utils && W.hg.utils.TrapControl)) return;

    const power = course.power_type;
    const setup = settings.setups[power];
    if (!setup) {
      notify(`No ${POWER[power]} setup saved yet. Arm it and click "Save current" under ${POWER[power]}.`, true, `missing-${power}`);
      return;
    }

    const items = pendingItems(setup, u);
    if (!items.length) return;

    busy = true;
    try {
      await armItems(items);
      notify(`Switched to your ${POWER[power]} setup.`);
    } catch (err) {
      if (err && err.message === 'timeout') {
        notify(`Swap to ${POWER[power]} timed out. Check your trap before hunting.`, true);
        return;
      }
      // Charms and cheese run out. Retry with just trap + base so the power type still flips.
      const core = items.filter((i) => i.slot === 'weapon' || i.slot === 'base');
      const extras = items.filter((i) => !core.includes(i));
      let coreOk = false;
      if (core.length && extras.length) {
        try {
          await armItems(core);
          coreOk = true;
        } catch (e) { /* reported below */ }
      }
      const failed = coreOk ? extras : items;
      failed.forEach((i) => blocked.add(`${i.slot}:${i.id}`));
      const names = failed.map((i) => i.name).join(', ');
      notify(coreOk
        ? `Switched ${POWER[power]} trap/base, but couldn't arm ${names}. Out of stock?`
        : `Couldn't arm your ${POWER[power]} setup (${names}). Do you still have it?`, true);
    } finally {
      busy = false;
      render();
    }
  };

  const saveCurrent = (power) => {
    const u = getUser();
    const armedType = String(u.trap_power_type_name || '').toLowerCase();
    if (armedType && armedType !== power
      && !W.confirm(`Your armed trap is ${u.trap_power_type_name}, not ${POWER[power]}. Save it as your ${POWER[power]} setup anyway?`)) {
      return;
    }

    const setup = {};
    SLOTS.forEach((slot) => {
      const id = Number(u[`${slot}_item_id`]);
      setup[slot] = id ? { id, name: u[`${slot}_name`] || `#${id}` } : null;
    });
    settings.setups[power] = setup;
    persist();
    blocked.clear();
    shownOnce.delete(`missing-${power}`);
    notify(`Saved your ${POWER[power]} setup.`);
    render();
    check();
  };

  // ---- request hook

  let ajaxTimer = null;
  let sawHorn = false;

  const onAjax = (url) => {
    if (url.includes('turns/activeturn.php')) sawHorn = true;
    clearTimeout(ajaxTimer);
    // Give the game a moment to apply the response to the global user object.
    ajaxTimer = setTimeout(() => {
      const horn = sawHorn;
      sawHorn = false;
      if (horn || phaseOf(getCourse()) !== lastPhase) check();
      render();
    }, 750);
  };

  hook = onAjax;
  ctx.onStop(() => { hook = null; clearTimeout(ajaxTimer); });

  // ---- UI

  const shownOnce = new Set();
  let toastTimer = null;

  const notify = (text, isError = false, onceKey = null) => {
    if (onceKey) {
      if (shownOnce.has(onceKey)) return;
      shownOnce.add(onceKey);
    }
    let toast = document.getElementById(`${PANEL_ID}-toast`);
    if (!toast) {
      toast = document.createElement('div');
      toast.id = `${PANEL_ID}-toast`;
      document.body.append(toast);
    }
    toast.textContent = text;
    toast.className = isError ? 'is-error' : '';
    toast.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.style.display = 'none'; }, isError ? 9000 : 4000);
  };

  const describeSetup = (setup) => {
    if (!setup) return '<span class="sos-muted">Not saved</span>';
    return SLOTS
      .filter((slot) => slot !== 'bait' || swapBait())
      .map((slot) => {
        const item = setup[slot];
        const value = item ? esc(item.name) : `<span class="sos-muted">${slot === 'trinket' ? 'none (left as is)' : 'none'}</span>`;
        return `<div><b>${SLOT_LABEL[slot]}:</b> ${value}</div>`;
      })
      .join('');
  };

  const hunts = (n) => `${n} hunt${Number(n) === 1 ? '' : 's'}`;

  const statusLine = (course) => {
    if (!course) return 'Not enrolled. Nothing to swap.';
    const power = course.power_type;
    const name = course.course_name || COURSE_NAME[course.course_type] || 'Course';
    let line = `${esc(name)} &middot; <b class="sos-${power}">${POWER[power]}</b>`;
    if (course.course_type === 'exam_course' && course.power_type_hunts_remaining != null) {
      line += ` &middot; ${hunts(course.power_type_hunts_remaining)} until ${POWER[OTHER[power]]}`;
    }
    if (course.is_boss_encounter) line += ' &middot; Boss up';
    if (course.hunts_remaining != null) line += ` &middot; ${hunts(course.hunts_remaining)} left`;
    return line;
  };

  const render = () => {
    const u = getUser();
    const hud = document.querySelector('#hudLocationContent');
    let panel = document.getElementById(PANEL_ID);

    if (u.environment_type !== ENV || !hud) {
      if (panel) panel.remove();
      return;
    }
    if (!panel) {
      panel = document.createElement('div');
      panel.id = PANEL_ID;
      panel.addEventListener('click', onPanelClick);
    }
    if (panel.previousElementSibling !== hud) hud.insertAdjacentElement('afterend', panel);

    const course = getCourse(u);
    const active = course ? course.power_type : null;
    const column = (power) => `
      <div class="sos-col sos-col-${power}${active === power ? ' is-active' : ''}">
        <div class="sos-col-head">
          <span class="sos-${power}">${POWER[power]}</span>
          <button type="button" data-save="${power}">Save current</button>
        </div>
        ${describeSetup(settings.setups[power])}
      </div>`;

    panel.innerHTML = `
      <div class="sos-top"><b>School of Sorcery auto-swap</b> <span class="sos-status">${statusLine(course)}</span></div>
      <div class="sos-cols">${column('arcane')}${column('shadow')}</div>`;
  };

  function onPanelClick(e) {
    const btn = e.target.closest('[data-save]');
    if (!btn) return;
    e.preventDefault();
    saveCurrent(btn.getAttribute('data-save'));
  }

  ctx.addStyle(`
    #${PANEL_ID} { margin: 6px 0; padding: 6px 8px; font-size: 11px; line-height: 1.45; color: #3b2a16;
      background: #f6ecd2; border: 1px solid #b89a63; border-radius: 4px; }
    #${PANEL_ID} .sos-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    #${PANEL_ID} .sos-status { flex: 1; }
    #${PANEL_ID} .sos-bait { color: #6b5536; }
    #${PANEL_ID} .sos-cols { display: flex; gap: 8px; margin-top: 6px; }
    #${PANEL_ID} .sos-col { flex: 1; padding: 4px 6px; border: 1px solid #d8c59c; border-radius: 3px; background: #fbf5e6; opacity: .75; }
    #${PANEL_ID} .sos-col.is-active { opacity: 1; border-color: #8a6a34; box-shadow: inset 0 0 0 1px #8a6a34; }
    #${PANEL_ID} .sos-col-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px; font-weight: bold; }
    #${PANEL_ID} button { font-size: 10px; padding: 1px 6px; cursor: pointer; }
    #${PANEL_ID} .sos-arcane { color: #2a62b8; }
    #${PANEL_ID} .sos-shadow { color: #5b3a8a; }
    #${PANEL_ID} .sos-muted { color: #9a8866; font-style: italic; }
    #${PANEL_ID}-toast { display: none; position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 99999;
      max-width: 460px; padding: 8px 14px; font-size: 12px; color: #fff; background: #3b5b2a; border-radius: 4px;
      box-shadow: 0 2px 8px rgba(0,0,0,.35); }
    #${PANEL_ID}-toast.is-error { background: #8a2a1f; }
  `);
  // ---- boot

  ctx.onStop(() => {
    document.getElementById(PANEL_ID)?.remove();
    document.getElementById(`${PANEL_ID}-toast`)?.remove();
    clearTimeout(toastTimer);
  });
  ctx.setStatus('Watching for School of Sorcery');
  ctx.every(render, 5000); // shows or removes the panel as you travel
  setTimeout(() => { if (ctx.alive()) { render(); check(); } }, 1000);

  patchXhr();
  return {};
    },
  });
}

}

// ---- core/90-boot.js ----
// Start-up: shared styles, the control panel, then every enabled module.

if (window.__mhSuperLoaded) {
  coreLog.warn('Already loaded on this page (is the script installed twice?). Skipping.');
} else {
  window.__mhSuperLoaded = true;
  window.MouseHuntSuper = MH; // console access: MouseHuntSuper.modules, .start('id'), .stop('id')

  const theme = document.createElement('style');
  theme.id = 'mhs-game-theme';
  theme.textContent = GAME_THEME_CSS;
  document.head.append(theme);

  const panel = Panel.create();
  MH.boot();

  // The standalone scripts this one replaces would run alongside it and fight over the horn and the menus.
  setTimeout(() => {
    const old = [];
    if (document.getElementById('mh-bot-container')) old.push('Auto Horn & KR Solver');
    if (document.getElementById('mhll-styles')) old.push('Loot Log & Gift Links');
    if (old.length) panel.addNotice(`The standalone ${old.join(' and ')} script is still installed. Disable it in your userscript manager, or features will run twice.`);
  }, 2000);
}

})();
