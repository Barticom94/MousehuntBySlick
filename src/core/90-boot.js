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
