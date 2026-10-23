// Preview of the open file instead of its diff: images before and after, side by side; Markdown
// formatted; HTML rendered. Documents are shown in a sandboxed frame: their scripts never run and
// they cannot reach the application.

import { language, t } from '../../i18n/i18n.js';
import { h } from '../../lib/dom.js';
import { fileKind, formatSize as format, imageType } from '../../lib/file-kinds.js';
import { marked } from '../../../vendor/marked/marked.esm.js';

/** Side shown for a document, per file: 'after' by default. */
const sides = new Map();

const formatSize = (bytes) => format(bytes, language());
const note = (text) => h('div', { class: 'diff-note' }, text);

function decode(base64) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// ---------- Images ----------

function imageFrame(label, version, type, cls) {
  if (!version) return null;
  const caption = h('span', { class: 'dims' }, formatSize(version.size));
  const body = version.data
    ? h('img', {
      src: `data:${type};base64,${version.data}`,
      alt: label,
      onload: (event) => { caption.textContent = `${event.target.naturalWidth} × ${event.target.naturalHeight} · ${formatSize(version.size)}`; },
      onerror: () => body.replaceWith(note(t('preview.unreadable'))),
    })
    : note(t('preview.tooLarge', { size: formatSize(version.size) }));
  return h('figure', { class: `img-frame ${cls}` },
    h('figcaption', {}, h('span', { class: 'side' }, label), caption),
    h('div', { class: 'checker' }, body));
}

/** The side where the file does not exist: kept empty, so that the other side reads at once. */
function emptyFrame(label, text, cls) {
  return h('figure', { class: `img-frame ${cls} missing` },
    h('figcaption', {}, h('span', { class: 'side' }, label)),
    h('div', { class: 'checker none' }, h('span', {}, text)));
}

function imagePreview(diff) {
  const { before, after } = diff.versions;
  const type = imageType(diff.file);
  if (!before && !after) return note(t('preview.none'));
  // Moved or copied without any change: one picture is enough.
  if (before && after && before.data && before.data === after.data) {
    return h('div', { class: 'img-compare single' }, imageFrame(t('preview.unchanged'), after, type, 'same'));
  }
  return h('div', { class: 'img-compare' },
    before ? imageFrame(t('preview.before'), before, type, 'before') : emptyFrame(t('preview.before'), t('preview.noBefore'), 'before'),
    after ? imageFrame(t('preview.after'), after, type, 'after') : emptyFrame(t('preview.after'), t('preview.noAfter'), 'after'));
}

// ---------- Documents ----------

/** Colours of the application, so that a Markdown preview matches the theme. */
function themeCss() {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  return `
    :root { color-scheme: ${document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'}; }
    body { margin: 0; padding: 18px 26px 40px; font: 14px/1.6 ${v('--font') || 'system-ui, sans-serif'}; color: ${v('--ink')}; background: ${v('--panel')}; }
    h1, h2, h3, h4 { line-height: 1.25; margin: 1.3em 0 .5em; } h1:first-child, h2:first-child { margin-top: 0; }
    h1 { font-size: 1.8em; border-bottom: 1px solid ${v('--border')}; padding-bottom: .3em; }
    h2 { font-size: 1.4em; border-bottom: 1px solid ${v('--border')}; padding-bottom: .25em; }
    a { color: ${v('--accent')}; }
    code { font-family: ${v('--mono') || 'monospace'}; font-size: .9em; padding: .15em .35em; border-radius: 4px; background: ${v('--hover')}; }
    pre { padding: 12px 14px; border-radius: 8px; background: ${v('--bg')}; border: 1px solid ${v('--border')}; overflow: auto; }
    pre code { padding: 0; background: none; }
    blockquote { margin: 0; padding: 2px 16px; color: ${v('--muted')}; border-left: 4px solid ${v('--border')}; }
    table { border-collapse: collapse; } th, td { border: 1px solid ${v('--border')}; padding: 6px 12px; } th { background: ${v('--bg')}; }
    img { max-width: 100%; } hr { border: 0; border-top: 1px solid ${v('--border')}; }
  `;
}

function documentHtml(kind, text) {
  if (kind === 'html') return text;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${themeCss()}</style></head><body>${marked.parse(text)}</body></html>`;
}

function documentPreview(diff, kind, rerender) {
  const { before, after } = diff.versions;
  const key = `${diff.kind}:${diff.oid ?? ''}:${diff.staged ?? ''}:${diff.file}`;
  const side = (sides.get(key) === 'before' && before) || !after ? 'before' : 'after';
  const version = side === 'before' ? before : after;
  if (!version) return note(t('preview.none'));
  const switcher = before && after && h('div', { class: 'seg preview-side', role: 'group' },
    ['before', 'after'].map((s) => h('button', {
      type: 'button',
      'aria-pressed': String(side === s),
      onclick: () => { sides.set(key, s); rerender(); },
    }, t(`preview.${s}`))));
  const body = version.data
    ? h('iframe', { class: `doc-frame ${kind}`, sandbox: '', referrerpolicy: 'no-referrer', title: diff.file, srcdoc: documentHtml(kind, decode(version.data)) })
    : note(t('preview.tooLarge', { size: formatSize(version.size) }));
  return h('div', { class: 'doc-preview' }, switcher, body);
}

/** The preview of the open diff; `rerender` draws the diff panel again. */
export function renderPreview(diff, rerender) {
  if (!diff.versions) return note(t('repo.loading'));
  if (diff.versions.failed) return note(t('preview.unreadable'));
  const kind = fileKind(diff.file);
  return kind === 'image' || kind === 'svg' ? imagePreview(diff) : documentPreview(diff, kind, rerender);
}
