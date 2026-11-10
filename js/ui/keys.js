// Small helpers shared by the keyboard handlers in js/ui/*.
/** True when the key event comes from a text field. */
export const isTyping = e => {
  const t = e.target;
  return !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
};
/** True while a modal (search, help, tour, location picker, gallery, Sun dashboard, lightbox...) is open. */
export function modalOpen() {
  if (document.body.classList.contains('modal-open')) return true;
  for (const m of document.querySelectorAll('[aria-modal="true"]')) if (m.getClientRects().length) return true;
  return false;
}
/** Plain key press (no Ctrl/Cmd/Alt) outside text fields and outside modals. */
export const plainKey = e => !e.defaultPrevented && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(e) && !modalOpen();
