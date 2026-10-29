// Markdown written on a hosting service (a pull request's description, its comments), shown in the
// page itself: the HTML that `marked` makes is kept only in the tags and attributes listed below, so
// that a comment can neither run a script nor load anything. Links open in the system browser.

import { marked } from '../../vendor/marked/marked.esm.js';
import * as backend from '../api/backend.js';

const TAGS = new Set([
  'a', 'b', 'blockquote', 'br', 'code', 'del', 'details', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i',
  'input', 'kbd', 'li', 'ol', 'p', 'pre', 's', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td',
  'th', 'thead', 'tr', 'ul',
]);
/** Tags dropped with their content; any other unknown tag is replaced by its content. */
const DROPPED = new Set(['script', 'style', 'iframe', 'object', 'embed', 'form', 'textarea', 'select', 'button', 'svg', 'math', 'template']);
const ATTRIBUTES = new Set(['href', 'title', 'alt', 'align', 'colspan', 'rowspan', 'open', 'type', 'checked']);

function safeLink(href) {
  try {
    const url = new URL(href, 'https://invalid.example/');
    return url.host !== 'invalid.example' && ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function clean(node) {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === Node.TEXT_NODE) continue;
    if (child.nodeType !== Node.ELEMENT_NODE) {
      child.remove();
      continue;
    }
    const tag = child.tagName.toLowerCase();
    if (DROPPED.has(tag)) {
      child.remove();
      continue;
    }
    if (!TAGS.has(tag)) {
      // An image is shown as its description: the page loads nothing from outside.
      if (tag === 'img') child.replaceWith(child.getAttribute('alt') ?? '');
      else {
        clean(child);
        child.replaceWith(...child.childNodes);
      }
      continue;
    }
    for (const attribute of [...child.attributes]) {
      if (!ATTRIBUTES.has(attribute.name)) child.removeAttribute(attribute.name);
    }
    if (tag === 'a') {
      const href = safeLink(child.getAttribute('href') ?? '');
      if (href) child.setAttribute('href', href);
      else child.removeAttribute('href');
    }
    if (tag === 'input') {
      if (child.getAttribute('type') !== 'checkbox') {
        child.remove();
        continue;
      }
      child.setAttribute('disabled', '');
    }
    clean(child);
  }
}

/** A `div.markdown` with `text` formatted. */
export function markdown(text) {
  const doc = new DOMParser().parseFromString(`<body>${marked.parse(text ?? '', { gfm: true, breaks: true })}</body>`, 'text/html');
  clean(doc.body);
  const box = document.createElement('div');
  box.className = 'markdown';
  box.append(...doc.body.childNodes);
  box.addEventListener('click', (event) => {
    const link = event.target.closest('a[href]');
    if (!link) return;
    event.preventDefault();
    backend.openUrl(link.getAttribute('href')).catch(() => {});
  });
  return box;
}
