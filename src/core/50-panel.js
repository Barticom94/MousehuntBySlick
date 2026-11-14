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
