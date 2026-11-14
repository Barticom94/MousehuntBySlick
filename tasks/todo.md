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
