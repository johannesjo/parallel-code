/**
 * One sanitize policy for markup the app did not write: document files, the
 * pages they render, and everything an agent prints. `style` is not confined
 * to the element it sits in, and the form controls can navigate the window the
 * app itself runs in, so neither survives. `data-lang` is the code renderer's
 * own attribute, which DOMPurify would otherwise drop.
 */
export const SANITIZE_UNTRUSTED = {
  ADD_ATTR: ['data-lang'],
  FORBID_TAGS: ['style', 'title', 'form', 'input', 'button', 'textarea', 'select'],
};
