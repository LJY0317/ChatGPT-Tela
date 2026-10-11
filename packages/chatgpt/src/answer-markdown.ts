/** Serialize only an already-owned assistant body. This function runs in the renderer.
 * Presentation is carried as Markdown. Identity serialization includes author nodes hidden only
 * by presentation, so page activity cannot alter the committed body proof. Controls stay excluded.
 */
export function assistantMarkdown(root: HTMLElement, includePresentationHidden = false): string {
  const escape = (value: string) => value.replace(/\\/g, "\\\\").replace(/([`*_[\]<>])/g, "\\$1");
  const fence = (value: string) => "`".repeat(Math.max(3, ...[...value.matchAll(/`+/g)].map(item => item[0].length + 1)));
  const children = (node: Node): string => Array.from(node.childNodes).map(child => render(child)).join("");
  const render = (node: Node): string => {
    if (node.nodeType === 3) return escape(node.textContent ?? "");
    if (!(node instanceof HTMLElement)) return "";
    const tag = node.tagName.toLowerCase();
    if (["script", "style", "button", "svg", "nav"].includes(tag)
      || (!includePresentationHidden && (node.hidden || node.getAttribute("aria-hidden") === "true"))) return "";
    if (!includePresentationHidden) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return "";
    }
    if (tag === "pre") {
      const code = node.querySelector("code") ?? node;
      const value = (code.textContent ?? "").replace(/\r\n?/g, "\n");
      const language = Array.from(code.classList).map(item => /^language-([\w+-]+)$/.exec(item)?.[1]).find(Boolean) ?? "";
      const marker = fence(value);
      return `\n\n${marker}${language}\n${value.replace(/\n$/, "")}\n${marker}\n\n`;
    }
    if (tag === "code") {
      const value = node.textContent ?? "";
      const marker = "`".repeat(Math.max(1, ...[...value.matchAll(/`+/g)].map(item => item[0].length + 1)));
      const pad = value.startsWith("`") || value.endsWith("`") || /^ .* $/.test(value) ? " " : "";
      return `${marker}${pad}${value}${pad}${marker}`;
    }
    if (tag === "table") {
      const rows = Array.from(node.querySelectorAll("tr")).map(row => Array.from(row.children)
        .filter(cell => ["TH", "TD"].includes(cell.tagName))
        .map(cell => children(cell).trim().replace(/\n+/g, "<br>").replace(/\|/g, "\\|")));
      const width = Math.max(0, ...rows.map(row => row.length));
      if (!width) return "";
      const line = (row: string[]) => `| ${Array.from({ length: width }, (_, i) => row[i] ?? "").join(" | ")} |`;
      return `\n\n${line(rows[0]!)}\n${line(Array(width).fill("---"))}\n${rows.slice(1).map(line).join("\n")}\n\n`;
    }
    if (tag === "ul" || tag === "ol") {
      const start = Number(node.getAttribute("start") ?? 1);
      const items = Array.from(node.children).filter(child => child.tagName === "LI");
      return "\n\n" + items.map((item, i) => {
        const marker = tag === "ol" ? `${Number.isFinite(start) ? start + i : i + 1}. ` : "- ";
        const value = children(item).trim();
        return marker + value.replace(/\n/g, "\n" + " ".repeat(marker.length));
      }).join("\n") + "\n\n";
    }
    const value = children(node);
    if (tag === "strong" || tag === "b") return `**${value}**`;
    if (tag === "em" || tag === "i") return `*${value}*`;
    if (tag === "del" || tag === "s") return `~~${value}~~`;
    if (tag === "br") return "  \n";
    if (tag === "hr") return "\n\n---\n\n";
    if (/^h[1-6]$/.test(tag)) return `\n\n${"#".repeat(Number(tag[1]))} ${value.trim()}\n\n`;
    if (tag === "blockquote") return `\n\n${value.trim().split("\n").map(line => "> " + line).join("\n")}\n\n`;
    if (tag === "a") {
      const href = node.getAttribute("href");
      if (!href) return value;
      try {
        const url = new URL(href, document.baseURI);
        if (!["https:", "http:", "mailto:"].includes(url.protocol)) return value;
        return `[${value}](<${url.href.replace(/>/g, "%3E")}>)`;
      } catch { return value; }
    }
    if (tag === "p" || tag === "div" || tag === "section") return `\n\n${value}\n\n`;
    return value;
  };
  // Empty structural fixtures and text-only renderer bodies have no child nodes.
  if (!root.childNodes?.length) return (root.innerText || root.textContent || "").replace(/\r\n?/g, "\n").trim();
  return children(root).replace(/\r\n?/g, "\n").trim();
}
