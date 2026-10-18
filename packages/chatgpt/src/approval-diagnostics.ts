export interface ApprovalDiagnosticProbe {
  readonly controls: Record<string, number | boolean>;
  readonly buttons: readonly Record<string, string | number | boolean>[];
  readonly nodes: readonly Record<string, string | number | boolean>[];
}

/** Serialized into the renderer. Labels and DOM identifiers never leave this function. */
export function approvalDiagnosticProbe(
  card: HTMLElement | undefined,
  target: HTMLElement | null,
  hit: Element | null,
): ApprovalDiagnosticProbe {
  const visible = (node: Element) => {
    const style = getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden"
      && style.opacity !== "0" && node.getClientRects().length > 0;
  };
  const label = (node: Element) => String(node.getAttribute("aria-label") || node.textContent || "")
    .replace(/\s+/g, " ").trim();
  const buttons = Array.from(card?.querySelectorAll('button,[role="button"]') ?? []).slice(0, 64);
  const menus = Array.from(document.querySelectorAll('[role="menu"]')).filter(visible).slice(0, 16);
  const disclosures = buttons.filter(node => node.getAttribute("aria-haspopup") === "menu");
  const linked = (button: Element, menu: Element) => !!(
    menu.id && button.getAttribute("aria-controls") === menu.id
    || button.id && menu.getAttribute("aria-labelledby") === button.id);
  const controls = {
    button_count: buttons.length,
    button_scan_truncated: (card?.querySelectorAll('button,[role="button"]').length ?? 0) > buttons.length,
    visible_button_count: buttons.filter(visible).length,
    popup_menu_count: disclosures.length,
    options_label_count: buttons.filter(node => label(node) === "Approval options").length,
    popup_with_controls_count: disclosures.filter(node => !!node.getAttribute("aria-controls")).length,
    popup_with_id_count: disclosures.filter(node => !!node.id).length,
    popup_expanded_count: disclosures.filter(node => node.getAttribute("aria-expanded") === "true").length,
    popup_collapsed_count: disclosures.filter(node => node.getAttribute("aria-expanded") === "false").length,
    popup_disabled_count: disclosures.filter(node => node.matches(':disabled,[aria-disabled="true"],[inert]')).length,
    visible_menu_count: menus.length,
    linked_menu_count: menus.filter(menu => disclosures.some(button => linked(button, menu))).length,
    menu_choice_count: menus.reduce((count, menu) => count + menu.querySelectorAll('[role="menuitem"],button,[role="button"]').length, 0),
    document_hidden: document.visibilityState === "hidden",
    document_focused: document.hasFocus(),
    viewport_width: Math.round(innerWidth), viewport_height: Math.round(innerHeight),
    hit_in_card: !!hit && !!card?.contains(hit),
    hit_is_target_ancestor: !!hit && !!target && hit !== target && hit.contains(target),
  };
  const nodes: Record<string, string | number | boolean>[] = [];
  const targetBounds = target?.getBoundingClientRect();
  const targetX = targetBounds ? targetBounds.left + targetBounds.width / 2 : 0;
  const targetY = targetBounds ? targetBounds.top + targetBounds.height / 2 : 0;
  // Fixed vocabulary only: arbitrary tag/role/class/id/label strings are never exported.
  const tags = ["html", "body", "div", "span", "button", "svg", "path", "form", "dialog", "main", "section", "article"];
  for (const [phase, start] of [["card", card], ["target", target], ["hit", hit]] as const) {
    let node: Element | null | undefined = start;
    for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
      const style = getComputedStyle(node), rect = node.getBoundingClientRect();
      const tag = node.tagName.toLowerCase();
      const row: Record<string, string | number | boolean> = {
        phase, depth, kind: tags.includes(tag) ? tag : "other",
        x: Math.round(rect.left), y: Math.round(rect.top),
        width: Math.round(rect.width), height: Math.round(rect.height),
        client_width: node.clientWidth, client_height: node.clientHeight,
        client_left: node.clientLeft, client_top: node.clientTop,
        z_index_auto: style.zIndex === "auto", z_index: Number.isSafeInteger(Number(style.zIndex)) ? Number(style.zIndex) : 0,
        scroll_top: Math.round(node.scrollTop), scroll_left: Math.round(node.scrollLeft),
        scroll_width: node.scrollWidth, scroll_height: node.scrollHeight,
        overflow_x_clips: /^(hidden|clip|auto|scroll)$/.test(style.overflowX),
        overflow_y_clips: /^(hidden|clip|auto|scroll)$/.test(style.overflowY),
        position_fixed: style.position === "fixed", position_sticky: style.position === "sticky",
        pointer_events_none: style.pointerEvents === "none",
        visibility_hidden: style.visibility === "hidden", display_none: style.display === "none",
        opacity_zero: style.opacity === "0", transform_active: !!style.transform && style.transform !== "none",
        clip_active: !!style.clipPath && style.clipPath !== "none",
        contain_paint: /(?:paint|strict|content)/.test(style.contain), inert: node.hasAttribute("inert"),
        is_menu: node.getAttribute("role") === "menu", is_dialog: node.matches('dialog,[role="dialog"],[aria-modal="true"]'),
        is_target: node === target, is_hit: node === hit, is_card: node === card,
        contains_target: !!target && node.contains(target), contains_card: !!card && node.contains(card),
        editable_descendant_count: Math.min(64, node.querySelectorAll('textarea,[contenteditable="true"]').length),
      };
      if (targetBounds) {
        row.target_center_outside_x = targetX < rect.left || targetX >= rect.left + rect.width;
        row.target_center_outside_y = targetY < rect.top || targetY >= rect.top + rect.height;
      }
      nodes.push(row);
    }
  }
  const decisions = (value: string) => value === "Approval options" ? "options"
    : value === "Allow once" ? "allow_once" : /^Allow(?: .* for this conversation| for this conversation)$/.test(value)
      ? "conversation" : value === "Allow" ? "allow" : value === "Deny" ? "deny" : "other";
  const controlEvidence = (node: Element, index: number, menu?: Element, menuIndex = -1) => ({
    index, menu_index: menuIndex, kind: decisions(label(node)), visible: visible(node), in_menu: !!menu,
    menu_linked: !!menu && disclosures.some(button => linked(button, menu)),
    aria_label_present: node.hasAttribute("aria-label"), popup_menu: node.getAttribute("aria-haspopup") === "menu",
    expanded: node.getAttribute("aria-expanded") === "true", collapsed: node.getAttribute("aria-expanded") === "false",
    controls_present: !!node.getAttribute("aria-controls"), id_present: !!node.id,
    disabled: node.matches(':disabled,[aria-disabled="true"]'), inert: !!node.closest('[inert]'),
    linked_menu_count: menus.filter(menu => linked(node, menu)).length,
  });
  const buttonEvidence = buttons.slice(0, 16).map((node, index) => controlEvidence(node, index));
  const menuEvidence = menus.flatMap((menu, menuIndex) => Array.from(menu.querySelectorAll('[role="menuitem"],button,[role="button"]'))
    .slice(0, 16).map((node, index) => controlEvidence(node, index, menu, menuIndex))).slice(0, 16);
  return { controls, buttons: [...buttonEvidence, ...menuEvidence], nodes };
}
