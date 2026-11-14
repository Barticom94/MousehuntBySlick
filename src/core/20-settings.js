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
