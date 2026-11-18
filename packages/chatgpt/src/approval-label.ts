/** ChatGPT's localized consent labels. Serialized into the renderer; keep self-contained.
 * Only classifies a control inside an already scoped card, never grants authority.
 */
export function approvalControlLabel(value: string): string {
  // A visible keyboard hint is presentation, not part of the consent choice.
  // Match only complete labels after removing a known trailing shortcut.
  const label = String(value || "").normalize("NFKC")
    .replace(/[\u200b-\u200d\ufeff]/g, "").replace(/\s+/g, " ").trim()
    .replace(/\s*(?:[([（]\s*)?(?:esc(?:ape)?|enter|return|⏎|↵|⌤)(?:\s*[)\]）])?\s*$/i, "")
    .trim().toLowerCase();
  switch (label) {
    case "allow": case "허용": return "Allow";
    case "allow once": case "한 번만 허용": case "한번만 허용": return "Allow once";
    case "deny": case "거부": return "Deny";
    case "always allow": case "항상 허용": return "Always allow";
    case "allow for this conversation": case "이 대화에서 허용": case "이 대화에 대해 허용":
      return "Allow for this conversation";
    case "approval options": case "승인 옵션": return "Approval options";
    case "see details": case "자세히 보기": return "See details";
    case "copy details": case "세부정보 복사": return "Copy details";
    default: return /^allow .+ for this conversation$/.test(label) ? "Allow for this conversation" : "";
  }
}

/** Shared by observation, clicks and diagnostics; shortcut decoration is not consent text. */
export function approvalControlText(node: Node): string {
  if (node instanceof HTMLElement && (node.getAttribute("aria-hidden") === "true" || node.tagName?.toLowerCase() === "kbd")) return "";
  if (!node.childNodes?.length) return node.textContent || (node as HTMLElement).innerText || "";
  return Array.from(node.childNodes).map(approvalControlText).join("");
}
