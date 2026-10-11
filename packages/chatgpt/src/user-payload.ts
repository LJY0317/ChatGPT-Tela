/** Adapter-local author payload, independent of visibility, truncation and action labels.
 * Unknown structures supply no proof; they never fall back to the whole bubble's display text.
 */
export function userPayload(bubble: HTMLElement): { value?: string; reason: string; rootCount: number } {
  const roots = Array.from(bubble.querySelectorAll<HTMLElement>('[data-search-result-target]'));
  if (roots.length !== 1) return { reason: roots.length ? 'ambiguous_author_root' : 'author_root_missing', rootCount: roots.length };
  const value = (roots[0]!.textContent ?? '').replace(/\r\n?/g, '\n');
  if (!value.length) return { reason: 'author_payload_empty', rootCount: 1 };
  if (value.length > 1_048_576) return { reason: 'author_payload_budget', rootCount: 1 };
  return { value, reason: 'author_payload', rootCount: 1 };
}
