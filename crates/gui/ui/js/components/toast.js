// Short notification at the bottom of the window.

let timer = null;

export function toast(message, duration = 2400) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(timer);
  timer = setTimeout(() => el.classList.remove('show'), duration);
}
