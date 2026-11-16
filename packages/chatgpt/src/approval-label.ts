/** ChatGPT's localized consent labels. Serialized into the renderer; keep self-contained.
 * Only classifies a control inside an already scoped card, never grants authority.
 */
export function approvalControlLabel(value: string): string {
  const label = String(value || "").replace(/\s+/g, " ").trim();
  switch (label) {
    case "Allow": case "허용": return "Allow";
    case "Allow once": case "한 번만 허용": return "Allow once";
    case "Deny": case "거부": return "Deny";
    case "Always allow": case "항상 허용": return "Always allow";
    case "Allow for this conversation": case "이 대화에서 허용": case "이 대화에 대해 허용":
      return "Allow for this conversation";
    case "Approval options": case "승인 옵션": return "Approval options";
    case "See details": case "자세히 보기": return "See details";
    case "Copy details": case "세부정보 복사": return "Copy details";
    default: return /^Allow .* for this conversation$/.test(label) ? "Allow for this conversation" : "";
  }
}
