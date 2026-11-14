// Small helpers shared by the core and every module. Core files share one scope; module files are block-scoped.

const MH_VERSION = '__VERSION__'; // replaced by build.mjs from package.json

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
