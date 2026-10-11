/** Renderer-local author structure. No selectors, page text or presentation Markdown enter this proof. */
export function assistantBody(root: HTMLElement): { version: 1; value?: string; reason?: string } {
  type Part = { kind: string; value?: string; meta?: unknown; children?: Part[] };
  let nodes = 0, characters = 0;
  const block = new Set(['paragraph', 'heading', 'list', 'table', 'codeBlock', 'quote', 'rule']);
  const merge = (parts: Part[]) => {
    const result: Part[] = [];
    for (const part of parts) {
      const last = result[result.length - 1];
      if (part.kind === 'text' && last?.kind === 'text') last.value = (last.value ?? '') + (part.value ?? '');
      else result.push(part);
    }
    return result;
  };
  const flow = (parts: Part[]) => {
    const result: Part[] = [], inline: Part[] = [];
    const flush = () => { if (inline.length) result.push({ kind: 'paragraph', children: merge(inline.splice(0)) }); };
    for (const part of parts) { if (block.has(part.kind)) { flush(); result.push(part); } else inline.push(part); }
    flush(); return result;
  };
  const children = (node: Node): Part[] => merge(Array.from(node.childNodes).flatMap(read));
  const literal = (node: Node): string => {
    const value = (node.textContent ?? '').replace(/\r\n?/g, '\n');
    characters += value.length;
    if (characters > 1_048_576) throw new Error('body_budget');
    return value;
  };
  const read = (node: Node): Part[] => {
    if (++nodes > 65_536) throw new Error('body_budget');
    if (node.nodeType === 3) { const value = literal(node); return value ? [{ kind: 'text', value }] : []; }
    if (node.nodeType === 8) return [];
    if (!(node instanceof HTMLElement)) throw new Error('unsupported_node');
    const tag = node.tagName.toLowerCase();
    if (['button', 'script', 'style', 'nav'].includes(tag)) return [];
    if (tag === 'pre') {
      const code = node.querySelector('code') ?? node;
      const language = Array.from(code.classList).map(item => /^language-([\w+-]+)$/.exec(item)?.[1]).find(Boolean) ?? '';
      return [{ kind: 'codeBlock', value: literal(code), meta: language }];
    }
    if (tag === 'code') return [{ kind: 'code', value: literal(node) }];
    if (tag === 'br') return [{ kind: 'break' }];
    if (tag === 'hr') return [{ kind: 'rule' }];
    if (tag === 'a') {
      const href = node.getAttribute('href');
      if (href === null) return children(node);
      let target: string;
      try { target = new URL(href, document.baseURI).href; } catch { throw new Error('unsupported_link'); }
      return [{ kind: 'link', meta: target, children: children(node) }];
    }
    if (tag === 'ul' || tag === 'ol') {
      const items = Array.from(node.children);
      if (items.some(item => item.tagName !== 'LI')) throw new Error('unsupported_list');
      const start = tag === 'ol' ? Number(node.getAttribute('start') ?? 1) : null;
      if (start !== null && !Number.isSafeInteger(start)) throw new Error('unsupported_list');
      return [{ kind: 'list', meta: [tag, start], children: items.map(item => ({kind: 'item', children: flow(children(item))})) }];
    }
    if (tag === 'table') {
      const rows = Array.from(node.querySelectorAll('tr'));
      return [{ kind: 'table', children: rows.map(row => ({kind: 'row', children: Array.from(row.children).map(cell => {
        if (!['TH', 'TD'].includes(cell.tagName)) throw new Error('unsupported_table');
        return {kind: 'cell', meta: [cell.tagName, cell.getAttribute('rowspan') ?? '1', cell.getAttribute('colspan') ?? '1'], children: flow(children(cell))};
      })})) }];
    }
    const content = children(node);
    if (tag === 'div' || tag === 'section') return flow(content);
    if (tag === 'span') return content;
    if (tag === 'p') return [{kind: 'paragraph', children: content}];
    if (/^h[1-6]$/.test(tag)) return [{kind: 'heading', meta: Number(tag[1]), children: content}];
    if (tag === 'blockquote') return [{kind: 'quote', children: flow(content)}];
    const mark = tag === 'b' || tag === 'strong' ? 'strong' : tag === 'em' || tag === 'i' ? 'emphasis' : tag === 'del' || tag === 's' ? 'deleted' : null;
    if (mark) return [{kind: mark, children: content}];
    throw new Error('unsupported_node');
  };
  try { const parts = flow(children(root)); return parts.length
    ? { version: 1, value: JSON.stringify(parts) } : { version: 1, reason: "body_empty" }; }
  catch (error) { return { version: 1, reason: error instanceof Error ? error.message : 'body_unavailable' }; }
}
