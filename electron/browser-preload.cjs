/* global window, document, Element, HTMLElement, CSS */
// This preload intentionally exposes nothing to the page. It runs only in the
// top frame's isolated world, with a single purpose: return a user-picked element.
const { ipcRenderer } = require('electron');
let stopPicking = () => {};
let activeHandlers = {};
// Register before site scripts so their capture listeners cannot activate an
// element before the picker intercepts the user's click. Inert while disarmed.
for (const name of [
  'pointermove',
  'click',
  'keydown',
  'pointerdown',
  'pointerup',
  'mousedown',
  'mouseup',
]) {
  window.addEventListener(name, (event) => activeHandlers[name]?.(event), true);
}

function selectorFor(element) {
  const parts = [];
  let node = element;
  while (node && parts.length < 12) {
    const root = node.getRootNode();
    if (node.id && root.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
      parts.unshift(`#${CSS.escape(node.id)}`);
      break;
    }
    let part = node.localName;
    if (node.parentNode?.children) {
      const siblings = [...node.parentNode.children].filter((e) => e.localName === node.localName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = node.parentElement;
  }
  const root = element.getRootNode();
  // >>> denotes an open shadow boundary, not a plain CSS combinator.
  const prefix = root.host ? `${selectorFor(root.host)} >>> ` : '';
  return (prefix + parts.join(' > ')).slice(0, 4096);
}

ipcRenderer.on('browser:set-picking', (_event, enabled) => {
  stopPicking();
  if (!enabled || !document.documentElement) return;
  const overlay = document.createElement('div');
  overlay.setAttribute('data-parallel-picker', '');
  // A shadow root shields the highlight from the inspected site's styles.
  const shadow = overlay.attachShadow({ mode: 'closed' });
  const box = document.createElement('div');
  box.style.cssText =
    'position:fixed;pointer-events:none;border:2px solid #2563eb;background:rgba(37,99,235,.12);box-sizing:border-box;display:none;';
  shadow.append(box);
  overlay.style.cssText =
    'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  document.documentElement.append(overlay);
  const elementFor = (event) =>
    event.composedPath().find((item) => item instanceof Element && item !== overlay);
  const move = (event) => {
    const element = elementFor(event);
    if (!element) return;
    const rect = element.getBoundingClientRect();
    Object.assign(box.style, {
      display: 'block',
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  };
  const suppress = (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const click = (event) => {
    if (!event.isTrusted) return;
    suppress(event);
    const element = elementFor(event);
    if (!element) return;
    // A shallow, allowlisted excerpt avoids copying form values, scripts, and
    // arbitrary data attributes. Never serialize the page's whole subtree.
    // An inert document avoids running site custom-element constructors while picking.
    const excerpt = document.implementation.createHTMLDocument().createElement(element.localName);
    for (const name of ['id', 'class', 'role', 'aria-label', 'data-testid', 'type']) {
      const value = element.getAttribute(name);
      if (value) excerpt.setAttribute(name, value.slice(0, 256));
    }
    const editable = 'input, textarea, select, [contenteditable]';
    const containsDraft =
      element.closest(editable) ||
      element.querySelector(editable) ||
      (element instanceof HTMLElement && element.isContentEditable);
    const text = containsDraft
      ? ''
      : (element instanceof HTMLElement ? element.innerText : element.textContent || '').slice(
          0,
          1000,
        );
    excerpt.textContent = text;
    const result = { selector: selectorFor(element), text, html: excerpt.outerHTML.slice(0, 4096) };
    stopPicking();
    ipcRenderer.send('browser:pick-result', result);
  };
  const key = (event) => {
    if (event.key !== 'Escape') return;
    suppress(event);
    stopPicking();
    ipcRenderer.send('browser:pick-result', null);
  };
  activeHandlers = {
    pointermove: move,
    click,
    keydown: key,
    pointerdown: suppress,
    pointerup: suppress,
    mousedown: suppress,
    mouseup: suppress,
  };
  stopPicking = () => {
    activeHandlers = {};
    overlay.remove();
    stopPicking = () => {};
  };
});
