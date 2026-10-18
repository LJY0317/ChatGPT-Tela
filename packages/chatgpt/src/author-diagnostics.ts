/** Renderer-local census of the latest user bubble; returns counts, never prose or DOM attributes. */
export function authorDiagnosticProbe(bubble: HTMLElement): Record<string, number | boolean> {
  const roots = Array.from(bubble.querySelectorAll<HTMLElement>('[data-search-result-target]'));
  const root = roots.length === 1 ? roots[0] : undefined;
  const nodes = Array.from(bubble.querySelectorAll('pre,code,[hidden],[aria-hidden="true"],[aria-expanded],input,textarea,[contenteditable]'));
  const sample = nodes.slice(0, 128);
  const count = (selector: string) => sample.filter(node => node.matches(selector)).length;
  const characters = (selector: string) => sample.filter(node => node.matches(selector))
    .reduce((sum, node) => sum + Math.min(1_048_576, node.textContent?.length ?? 0), 0);
  const style = root ? getComputedStyle(root) : undefined;
  return {
    author_probe_available: true,
    author_probe_truncated: nodes.length > sample.length,
    author_probe_nodes: sample.length,
    author_code_count: count('code'), author_pre_count: count('pre'),
    author_hidden_count: count('[hidden],[aria-hidden="true"]'),
    author_expanded_count: count('[aria-expanded="true"]'), author_collapsed_count: count('[aria-expanded="false"]'),
    author_editable_count: count('input,textarea,[contenteditable]:not([contenteditable="false"])'),
    author_code_characters: characters('code'), author_hidden_characters: characters('[hidden],[aria-hidden="true"]'),
    author_root_scroll_height: root?.scrollHeight ?? 0, author_root_client_height: root?.clientHeight ?? 0,
    author_root_clips: !!style && /^(hidden|clip|auto|scroll)$/.test(style.overflowY),
  };
}
