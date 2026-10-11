import { runInNewContext } from "node:vm";
import { describe, expect, test } from "bun:test";
import { assistantMarkdown } from "./answer-markdown";

class Text {
  readonly nodeType = 3;
  constructor(readonly textContent: string) {}
}
class Element {
  readonly nodeType = 1;
  readonly tagName: string;
  hidden = false;
  readonly classList: string[] = [];
  constructor(tag: string, readonly childNodes: Array<Element | Text> = [], readonly attributes: Record<string, string> = {}) {
    this.tagName = tag.toUpperCase();
  }
  get children() { return this.childNodes.filter((node): node is Element => node instanceof Element); }
  get textContent(): string { return this.childNodes.map(node => node.textContent).join(""); }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  querySelectorAll(tag: string): Element[] {
    return this.children.flatMap(child => [...(child.tagName.toLowerCase() === tag ? [child] : []), ...child.querySelectorAll(tag)]);
  }
  querySelector(tag: string) { return this.querySelectorAll(tag)[0] ?? null; }
}
const text = (value: string) => new Text(value);
const node = (tag: string, ...children: Array<Element | Text>) => new Element(tag, children);
function markdown(root: Element): string {
  return runInNewContext(`(${assistantMarkdown.toString()})(root)`, {
    root, HTMLElement: Element, URL, document: { baseURI: "https://example.com/" },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
  });
}
describe("owned assistant Markdown", () => {
  test("preserves inline styles and escapes literal syntax without exporting controls", () => {
    const hidden = node("p", text("secret UI")); hidden.hidden = true;
    const root = node("div", node("h2", text("Result")), node("p", node("strong", text("bold")), text(" "),
      node("em", text("italic")), text(" literal * and _ "), node("code", text("a*b"))), node("button", text("Copy")), hidden);
    const result = markdown(root);
    expect(result).toContain("## Result");
    expect(result).toContain("**bold** *italic* literal \\* and \\_ `a*b`");
    expect(result).not.toMatch(/Copy|secret UI/);
  });
  test("preserves ordered and nested lists, table cells, and fenced code contents", () => {
    const code = node("code", text("a\n\n```\nb")); code.classList.push("language-js");
    const root = node("div", new Element("ol", [node("li", text("first")), node("li", text("second"), node("ul", node("li", text("nested"))))], { start: "3" }),
      node("pre", code), node("table", node("tr", node("th", text("A")), node("th", text("B"))),
        node("tr", node("td", text("x|y")), node("td", text("z")))));
    const result = markdown(root);
    expect(result).toContain("3. first\n4. second");
    expect(result).toContain("   - nested");
    expect(result).toContain("````js\na\n\n```\nb\n````");
    expect(result).toContain("| A | B |\n| --- | --- |\n| x\\|y | z |");
  });
  test("keeps safe links and excludes executable destinations", () => {
    const result = markdown(node("div", new Element("a", [text("relative")], { href: "/path" }),
      new Element("a", [text("unsafe")], { href: "javascript:alert(1)" })));
    expect(result).toContain("[relative](<https://example.com/path>)");
    expect(result).toContain("unsafe");
    expect(result).not.toContain("javascript:");
  });
});
