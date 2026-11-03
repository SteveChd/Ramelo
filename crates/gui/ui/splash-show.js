'use strict';
// Loaded right after the splash screen in the page, before the modules of the interface: the
// window, created hidden, shows as soon as the splash screen is drawn, while the rest loads and the
// repositories are read behind it.
(function () {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) return;
  let shown = false;
  const show = () => {
    if (shown) return;
    shown = true;
    invoke('show_window').catch(() => {});
  };
  requestAnimationFrame(() => requestAnimationFrame(show));
  setTimeout(show, 100);
})();
