// Small helpers to build the DOM (HTML and SVG), without dependencies.

const SVG_NS = 'http://www.w3.org/2000/svg';

function apply(el, props) {
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.setAttribute('class', value);
    else if (key === 'style' && typeof value === 'object') {
      for (const [prop, v] of Object.entries(value)) el.style.setProperty(prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), v);
    }
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'text') el.textContent = value;
    else if (key === 'value' && 'value' in el) el.value = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** Creates an HTML element: h('div', { class: 'x' }, child1, child2). */
export function h(tag, props, ...children) {
  return append(apply(document.createElement(tag), props), children);
}

/** Creates an SVG element with the same signature as `h`. */
export function s(tag, props, ...children) {
  return append(apply(document.createElementNS(SVG_NS, tag), props), children);
}

/** Replaces the whole content of a container. */
export function mount(container, ...children) {
  container.replaceChildren();
  return append(container, children);
}

/** Builds an SVG fragment from a string (icons). */
export function svgFromString(markup) {
  const tpl = document.createElement('template');
  tpl.innerHTML = markup.trim();
  return tpl.content.firstElementChild;
}
