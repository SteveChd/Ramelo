// What a file is, from its extension: an image to show, or a document that has a formatted preview.

const IMAGES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif', svg: 'image/svg+xml',
};

const extension = (path) => /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';

/** 'image', 'svg' (an image that is also text), 'markdown', 'html', or null. */
export function fileKind(path) {
  const ext = extension(path);
  if (ext === 'svg') return 'svg';
  if (IMAGES[ext]) return 'image';
  if (['md', 'markdown', 'mdown', 'mkd'].includes(ext)) return 'markdown';
  if (['html', 'htm', 'xhtml'].includes(ext)) return 'html';
  return null;
}

export function imageType(path) {
  return IMAGES[extension(path)] ?? 'application/octet-stream';
}

/** Images open on their picture; documents on their diff, with the preview one click away. */
export function defaultMode(path) {
  return ['image', 'svg'].includes(fileKind(path)) ? 'preview' : 'diff';
}

/** « 840 B », « 12.4 KB », « 3.1 MB »; French writes « o », « Ko », « Mo ». */
export function formatSize(bytes, locale) {
  const units = locale === 'fr' ? ['o', 'Ko', 'Mo'] : ['B', 'KB', 'MB'];
  const [unit, value] = bytes < 1024 ? [units[0], bytes] : bytes < 1024 * 1024 ? [units[1], bytes / 1024] : [units[2], bytes / (1024 * 1024)];
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: value < 10 && unit !== units[0] ? 1 : 0 }).format(value);
  return `${number} ${unit}`;
}
