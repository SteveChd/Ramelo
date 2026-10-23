'use strict';
// Loaded in <head>, before anything is drawn: the splash screen immediately takes the theme and the
// language of the preferences, to avoid a light flash at launch in dark mode.
(function () {
  let theme = null;
  let lang = null;
  try {
    theme = localStorage.getItem('gitcontroller.theme');
    lang = localStorage.getItem('gitcontroller.language');
  } catch {
    /* storage unavailable: defaults */
  }
  const dark = theme ? theme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.lang = lang === 'fr' ? 'fr' : 'en';
  window.SPLASH_T0 = performance.now();
})();
