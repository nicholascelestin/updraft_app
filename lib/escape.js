/**
 * Shared HTML escaping utility.
 * Use in any morph() template that interpolates dynamic text.
 */
export function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
