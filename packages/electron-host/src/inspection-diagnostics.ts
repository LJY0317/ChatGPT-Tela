/** Serialized into the renderer. No labels, identifiers, URLs or keyboard values are returned. */
export function inspectionTargetProbe(hit: Element | null): Record<string, string | number | boolean>[] {
  const rows: Record<string, string | number | boolean>[] = [];
  const tags = ["html", "body", "div", "span", "button", "svg", "path", "form", "input", "textarea", "a"];
  for (let node = hit, depth = 0; node && depth < 8; node = node.parentElement, depth++) {
    const bounds = node.getBoundingClientRect(), style = getComputedStyle(node);
    const tag = node.tagName.toLowerCase();
    rows.push({
      depth, kind: tags.includes(tag) ? tag : "other",
      x: Math.round(bounds.left), y: Math.round(bounds.top), width: Math.round(bounds.width), height: Math.round(bounds.height),
      scroll_top: Math.round(node.scrollTop), scroll_height: node.scrollHeight, client_height: node.clientHeight,
      overflow_y_clips: /^(auto|scroll|hidden|clip)$/.test(style.overflowY),
      is_active_element: node === document.activeElement, in_form: !!node.closest('form'),
      in_editable: !!node.closest('input,textarea,[contenteditable]:not([contenteditable="false"])'),
      expanded_present: node.hasAttribute("aria-expanded"), expanded: node.getAttribute("aria-expanded") === "true",
      controls_present: !!node.getAttribute("aria-controls"), popup_present: node.hasAttribute("aria-haspopup"),
      aria_label_present: node.hasAttribute("aria-label"), is_button: node.matches('button,[role="button"]'),
      is_link: node.matches('a,[role="link"]'), user_select_none: style.userSelect === "none",
      document_hidden: document.visibilityState === "hidden",
    });
  }
  return rows;
}
