// Dates shown as « 3 hours ago », in the language of the interface.

import { locale } from '../i18n/i18n.js';

const UNITS = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

/** `seconds`: Unix time. */
export function relativeTime(seconds, now = Date.now()) {
  const elapsed = Math.round(now / 1000 - seconds);
  const format = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  for (const [unit, size] of UNITS) {
    if (Math.abs(elapsed) >= size) return format.format(-Math.floor(elapsed / size), unit);
  }
  return format.format(0, 'minute');
}

/** Full date and time, for tooltips. */
export function fullDate(seconds) {
  return new Date(seconds * 1000).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });
}

/** Clock time, for « refreshed at 14:32 ». */
export function clock(date) {
  return date.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
}
