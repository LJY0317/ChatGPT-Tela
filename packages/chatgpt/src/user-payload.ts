/** Adapter-local author payload, independent of visibility, truncation and action labels.
 * Unknown structures supply no proof; they never fall back to the whole bubble's display text.
 */
export function userPayload(bubble: HTMLElement): { value?: string; reason: string; rootCount: number; nestedRoots?: boolean; equivalentRoots?: boolean } {
  const roots = Array.from(bubble.querySelectorAll<HTMLElement>('[data-search-result-target]'));
  const structure: { rootCount: number; nestedRoots?: boolean; equivalentRoots?: boolean } = {
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
  if (value.length > 1_048_576) return { reason: 'author_payload_budget', ...structure };
  if (outer !== inner) {
    // For a DOM containment chain, equal endpoints prove that no intermediate
    // wrapper adds author text. Read only two payloads, never one per wrapper.
    structure.equivalentRoots = value === (inner.textContent ?? '').replace(/\r\n?/g, '\n');
    if (!structure.equivalentRoots) return { reason: 'ambiguous_author_root', ...structure };
  }
  if (!value.length) return { reason: 'author_payload_empty', ...structure };
  return { value, reason: 'author_payload', ...structure };
}
