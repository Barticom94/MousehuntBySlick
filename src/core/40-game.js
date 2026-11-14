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
