# Merge Loot Log + Auto Horn into one script with a control panel

- [x] Read both scripts (Loot Log & Gift Links 1.3.1, Auto Horn & KR Solver fork 0.6.1)
- [x] Core: settings store, module registry with lifecycle, game helpers, control panel, boot
- [x] Modules: auto-horn, loot-log, gift-links (code ported verbatim where possible)
- [x] Build script (src/ -> dist/), no dependencies
- [x] Mock-page smoke test: panel, settings migration, horn, loot capture + popup, gift claim, toggles, persistence, KR flow
- [ ] Live verification by Adam in Firefox + Tampermonkey (not done: mock-only so far)

## Review

Behaviour changes versus the standalone scripts, all small:
- Auto Horn: the status box injected at the top of the game page and the inline settings gear are replaced by the control panel.
- Auto Horn: errors inside the loop are reported and retried after 5 s (the old loop died silently); the Tesseract worker is released after each attempt; the "attempt n/3" text and the failure alert use the configured retry limit.
- Auto Horn: new "Solve King's Reward automatically" switch (default on). Off pauses the horn while a puzzle is up.
- Tesseract.js comes from `@require` (4.0.2, the same version the old script bundled) instead of being inlined.
- School of Sorcery Auto-Swap added as a module (v1.0.0 source, saved setups and options carried over; the in-page enable/cheese checkboxes moved to the control panel). Its XHR hook is patched once and forwards to the running instance.
- Loot Log and Gift Links are separate modules; the Loot Log API on `window.mhLootLog` is unchanged.


# Daily Gifting module

- [x] Module `src/modules/daily-gifting.js`: aggregate claim list, accept-only, send Gift of the Day to non-senders, history-based friend picking
- [x] Selectors taken from the live dialog via read-only inspection (Chrome, 14 Nov 2026); parser run against the real dialog: counts, snuids, timer, limits all read correctly
- [x] Mock test for the claim and send flow, and for the pure friend-picking logic
- [ ] Live: the final send confirm (Select Gifts > Confirm) and the first real Claim & send run, by Adam
- [ ] Friend last-active: the game's tiles carry no activity data; only used if MH Improved's "last active" sort link is present


# Daily Gifting 1.1.1: claim fix
- Root cause: Accept in the game's dialog only SELECTS a gift; the claim happens when "Claim N Gifts" > Confirm sends one batch. The old code clicked Accept per gift (waiting for the counter, which drops on select) and never confirmed, so nothing was claimed. The old mock removed the row on Accept, which hid this.
- Fix: select all wanted gifts at once, confirm once, succeed only when the game removes those rows. Mock now behaves like the game. Quick Max / None / Fill to limit buttons added.
- Live-checked read-only (22 Nov): Accept selects, row stays, confirm turns "Claim 1 Gifts". A real claim was not run.
