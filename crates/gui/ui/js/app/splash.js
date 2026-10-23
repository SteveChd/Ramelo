// Splash screen: progress of the steps, minimum display time, keyboard blocked while it is visible,
// then a fade. The window, created hidden, is only shown once the screen is drawn.

import * as backend from '../api/backend.js';

/** Minimum display time, so that the logo animation has time to play. */
const SPLASH_MIN_MS = 1600;

const $ = (selector) => document.querySelector(selector);

function blockKeys(event) {
  event.stopImmediatePropagation();
  event.preventDefault();
}
window.addEventListener('keydown', blockKeys, true);

// The window is shown as soon as the first frame of the splash screen is ready (no white flash).
let shown = false;
function showWindow() {
  if (shown) return;
  shown = true;
  backend.showWindow().catch(() => {});
}
requestAnimationFrame(() => requestAnimationFrame(showWindow));
setTimeout(showWindow, 120);

/** Shows the current step and moves the bar forward (`progress` between 0 and 1). */
export function splashStep(text, progress) {
  const fill = $('#splash-fill');
  if (fill) fill.style.width = `${Math.round(progress * 100)}%`;
  const status = $('#splash-status');
  if (status) status.textContent = text;
}

export async function hideSplash(readyText) {
  splashStep(readyText, 1);
  const left = SPLASH_MIN_MS - (performance.now() - (window.SPLASH_T0 || 0));
  if (left > 0) await new Promise((resolve) => setTimeout(resolve, left));
  window.removeEventListener('keydown', blockKeys, true);
  const el = $('#splash');
  if (!el) return;
  el.classList.add('done');
  setTimeout(() => el.remove(), 450);
}
