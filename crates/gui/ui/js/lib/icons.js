// Line icons (24×24), drawn in `currentColor` to follow the theme.

import { svgFromString } from './dom.js';

const PATHS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.6-4.5L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.6 4.5L20 16"/><path d="M20 20v-4h-4"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9c0 5-6 4-11 8.5"/>',
  arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  commit: '<circle cx="12" cy="12" r="3.5"/><path d="M3 12h5.5M15.5 12H21"/>',
  stash: '<path d="M4 8h16v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M2 4h20v4H2zM10 12h4"/>',
  warning: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.8"/>',
  remove: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  minus: '<path d="M5 12h14"/>',
  pull: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  push: '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>',
  fetch: '<path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4 4 0 0 1-.5 9.5"/><path d="M12 11v8M9 16l3 3 3-3"/>',
  tag: '<path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  cloud: '<path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4 4 0 0 1-.5 9.5z"/>',
  swap: '<path d="M4 8h13M13 4l4 4-4 4M20 16H7M11 12l-4 4 4 4"/>',
  newBranch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10M6 13c0-3 3-5 7-5"/><path d="M17 5v6M14 8h6"/>',
  maximize: '<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/>',
  restore: '<path d="M4 14h6v6M20 10h-6V4M10 14l-7 7M14 10l7-7"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  unified: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 9h8M8 12h8M8 15h5"/>',
  split: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16M6 9h3M6 12h3M15 9h3M15 12h3"/>',
  remote: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"/>',
};

/** Returns an <svg> element for the requested icon. */
export function icon(name, size = 18, strokeWidth = 1.8) {
  return svgFromString(
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`,
  );
}

/** Logo of GitController: a branch leaving a main line, three commits, on a rounded background. */
export function logo(className = 'logo') {
  return svgFromString(
    `<svg class="${className}" viewBox="0 0 28 28" fill="none" aria-hidden="true">
      <rect x="1" y="1" width="26" height="26" rx="7" style="fill:var(--logo-bg)"/>
      <path d="M10 7.5V20.5M10 16L18.5 10.8" style="stroke:var(--logo-ink)" stroke-width="1.9" stroke-linecap="round"/>
      <circle cx="10" cy="7.5" r="2.6" fill="#3B6BF0"/>
      <circle cx="18.5" cy="10.8" r="2.6" fill="#1FB59A"/>
      <circle cx="10" cy="20.5" r="2.6" fill="#F0A04B"/>
    </svg>`,
  );
}

const AVATAR_COLORS = ['--c-blue', '--c-teal', '--c-amber', '--c-red', '--c-violet', '--c-slate'];

/** Colour of a repository: the one the user chose, otherwise one derived from its name. */
export function repoColor(repo) {
  return repo.color ?? avatarColor(repo.name);
}

/** Colour of a repository's avatar: always the same for the same name. */
export function avatarColor(name) {
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.codePointAt(0)) >>> 0;
  return `var(${AVATAR_COLORS[hash % AVATAR_COLORS.length]})`;
}
