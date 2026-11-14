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
