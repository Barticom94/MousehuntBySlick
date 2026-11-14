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
