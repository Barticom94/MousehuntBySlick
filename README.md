# MousehuntBySlick

One userscript for [MouseHunt](https://www.mousehuntgame.com), grown a module at a time, with a control panel to switch each feature on or off and tune it.

## Install

Install `dist/MHbS.js` in Tampermonkey. Raw `.js` links don't trigger an install prompt, so paste it in: open [`dist/MHbS.copy.md`](dist/MHbS.copy.md) and use the copy button on the code block (releases have the same). It pulls in Tesseract.js 4.0.2 from jsDelivr through `@require` for the King's Reward solver.

**Disable the old standalone scripts first** (Loot Log & Gift Links, Auto Horn & KR Solver, School of Sorcery Auto-Swap). Run together with this one they would sound the horn and draw their menus twice. The control panel warns if it spots them.

## What's in it

| Module | What it does | Came from |
| --- | --- | --- |
| Auto Horn & KR Solver | Sounds the horn when ready (random delay), OCR-solves King's Reward, refreshes the page periodically | Slick's fork 0.6.1 of [daniellok's script](https://github.com/daniellok/mousehunt-auto-kr) (MIT) |
| Loot Log | Journal log in IndexedDB, loot and value (Markethunt) over 24H / 3D / 7D / 30D / All | Loot Log & Gift Links 1.3.1 |
| School of Sorcery Auto-Swap | Arms your saved Arcane or Shadow setup to match the current course, including the Final Exam flip. Save setups from the panel it adds below the location HUD. Cheese swap is a setting, off by default | School of Sorcery Auto-Swap 1.0.0 (mock-only, not live-verified) |
| Gift Links | Pill with the claimable MH Improved gift links and one-click Claim all | Loot Log & Gift Links 1.3.1 |

Open the control panel with the **MH** button at the bottom right of the game. Each module has an on/off switch, a status line, its own settings and buttons. Everything saves on change and applies immediately, no reload. The old Auto Horn settings are copied over the first time the new script runs.

## Releases

On request: bump `version` in `package.json`, run `npm run build`, push to `main`, then run the **Release** workflow (Actions tab, or ask Claude). It creates tag `v<version>` with `MHbS.js` attached and the whole script in the release notes in a code block with a copy button, for one-click paste into Tampermonkey or Greasemonkey. `dist/MHbS.copy.md` is the same thing as a page, and the notes link to it once the script is too big for a release body.

## Layout

```
src/meta.txt            userscript header
src/core/               framework: settings, module registry, game helpers, control panel, boot
src/modules/            one file per feature
dist/                   built script MHbS.js and MHbS.copy.md (committed, this is what you install)
build.mjs               concatenates src/ into dist/ (no dependencies)
test/smoke.mjs          headless-browser check against a stubbed game page
```

`npm run build` writes `dist/`. `npm run check` fails if `dist/` is stale. `npm test` runs the smoke test (needs Playwright installed).

## Adding a feature

Drop a file in `src/modules/` and rebuild. Each file is its own block scope, so names can't clash.

```js
{
  MH.register({
    id: 'my-feature',
    name: 'My Feature',
    description: 'One line for the control panel.',
    settings: [{ key: 'threshold', type: 'number', label: 'Threshold', unit: 'min', min: 1, max: 60, default: 10 }],
    requires: gameRequires,            // optional: return a reason string when it can't run on this page
    init(ctx) {
      ctx.setStatus('Running');
      ctx.addStyle('...');             // removed when the module is switched off
      ctx.every(() => { /* ... */ }, 60000);                 // timers and listeners made through ctx are
      ctx.listen(document, 'click', (e) => { /* ... */ });   // cleaned up automatically on switch-off
      ctx.settings.get('threshold');   // read settings at use time so panel changes apply live
      return { actions: [{ label: 'Do it now', run: () => {} }] };  // optional panel buttons
    },
  });
}
```

Settings types are `number`, `checkbox` and `select`. Shared helpers (`lsGet`, `lsSet`, `esc`, `fmt`, `sleep`, `showGamePopup`, `gameRequires`) live in `src/core/`. In the browser, `MouseHuntSuper` exposes the registry for debugging.

## Notes

- The script runs in the page context (`@grant none`), like the Loot Log did, because it needs the game's own globals (`user`, `hg`, `eventRegistry`, `jsDialog`).
- Verification so far is against a stubbed game page only, not the live game.
