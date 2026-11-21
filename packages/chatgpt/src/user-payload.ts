/** Adapter-local author payload, independent of visibility, truncation and action labels.
 * Unknown structures supply no proof; they never fall back to the whole bubble's display text.
 */
export function userPayload(bubble: HTMLElement): { value?: string; leadingHeader?: string; candidates?: string[]; reason: string; rootCount: number; nestedRoots?: boolean; equivalentRoots?: boolean; outerLength?: number; innerLength?: number } {
  const roots = Array.from(bubble.querySelectorAll<HTMLElement>('[data-search-result-target]'));
  const structure: { rootCount: number; nestedRoots?: boolean; equivalentRoots?: boolean; outerLength?: number; innerLength?: number } = {
    rootCount: Math.min(roots.length, 65),
  };
  if (!roots.length) return { reason: 'author_root_missing', ...structure, nestedRoots: false };
  if (roots.length > 64) return { reason: 'ambiguous_author_root', ...structure };
  let outer = roots[0]!, inner = outer;
  if (roots.length > 1) {
    structure.nestedRoots = roots.some(root => roots.some(other => other !== root && other.contains(root)));
    const outermost = roots.filter(root => !roots.some(other => other !== root && other.contains(root)));
    const innermost = roots.filter(root => !roots.some(other => other !== root && root.contains(other)));
    // One containment chain only. Separate or branching candidates remain ambiguous,
    // even when their displayed text happens to match.
    if (outermost.length !== 1 || innermost.length !== 1) return { reason: 'ambiguous_author_root', ...structure };
    outer = outermost[0]!; inner = innermost[0]!;
  }
  const value = (outer.textContent ?? '').replace(/\r\n?/g, '\n');
  structure.outerLength = value.length;
  if (value.length > 1_048_576) return { reason: 'author_payload_budget', ...structure };
  if (outer !== inner) {
    // For a DOM containment chain, equal endpoints prove that no intermediate
    // wrapper adds author text. Read only two payloads, never one per wrapper.
    const innerValue = (inner.textContent ?? '').replace(/\r\n?/g, '\n');
    structure.innerLength = innerValue.length;
    if (innerValue.length > 1_048_576) return { reason: 'author_payload_budget', ...structure };
    structure.equivalentRoots = value === innerValue;
    if (!structure.equivalentRoots) return { reason: 'ambiguous_author_root', ...structure,
      outerLength: value.length, innerLength: innerValue.length,
      // Alternatives, not author proof. Only an exact expected payload plus causal
      // logical identity may resolve these downstream; never pick an endpoint here.
      candidates: [value, innerValue] };
  }
  if (!value.length) return { reason: 'author_payload_empty', ...structure };
  // Renderer textContent flattens paragraph and BR boundaries. Read a leading
  // receipt from its own paragraph, omitting only the leading connector control.
  const paragraph = outer.querySelector('p');
  const paragraphText = paragraph?.textContent ?? '';
  const control = paragraph?.firstElementChild;
  // The live connector is a navigation anchor; diagnostic HTML strips its href.
  const connectorText = control?.matches('a[data-discover]') ? control.textContent ?? '' : '';
  const paragraphAuthor = paragraphText && value.startsWith(paragraphText) && paragraphText.startsWith(connectorText)
    ? paragraphText.slice(connectorText.length).trimStart() : '';
  const leadingHeader = paragraphAuthor.match(/^\[Tela request [A-Za-z0-9_-]{43}\](?=\s*(?:$|<chatgpt_tela_transport_contract>))/)?.[0];
  return { value, ...(leadingHeader ? { leadingHeader } : {}), reason: 'author_payload', ...structure };
}
