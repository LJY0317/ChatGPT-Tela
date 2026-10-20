import { runInNewContext } from "node:vm";
import { describe, expect, test } from "bun:test";
import { assistantMarkdown, assistantSemanticBody } from "./answer-markdown";

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
function identity(root: Element): string {
  return runInNewContext(`(${assistantSemanticBody.toString()})(root)`, {
    root, HTMLElement: Element, URL, document: { baseURI: "https://example.com/" },
  });
}
describe("owned assistant Markdown", () => {
  test("retained identity survives Markdown reflow but distinguishes prose, code, and destinations", () => {
    const original = node("div", node("p", text("Same retained sentence.")),
      node("pre", node("code", text("const answer = `ok`;\n"))),
      new Element("a", [text("Source")], { href: "/original" }));
    const reflow = node("section", node("div", text("Same retained\n sentence.")),
      node("pre", node("code", text("const answer = `ok`;\n"))),
      new Element("a", [text("Source")], { href: "https://example.com/original" }));
    expect(identity(reflow)).toBe(identity(original));
    reflow.childNodes[1] = node("pre", node("code", text("const answer = `changed`;\n")));
    expect(identity(reflow)).not.toBe(identity(original));
    reflow.childNodes[1] = node("pre", node("code", text("const answer = `ok`;\n")));
    (reflow.childNodes[2] as Element).attributes.href = "/different";
    expect(identity(reflow)).not.toBe(identity(original));
    (reflow.childNodes[2] as Element).attributes.href = "/original";
    reflow.childNodes[0] = node("p", text("Different retained sentence."));
    expect(identity(reflow)).not.toBe(identity(original));
  });
  test("retained identity ignores newly rendered inline-code ticks and presentation breaks", () => {
    const original = node("div", node("p", text("Use one, two, three, four.")),
      node("p", text("Next line.")));
    const codeWords = ["one", "two", "three", "four"].map(word => node("code", text(word)));
    const restyled = node("section", node("p", text("Use "), codeWords[0]!, text(", "),
      codeWords[1]!, text(", "), codeWords[2]!, text(", "), codeWords[3]!, text(".")),
      node("br"), node("div", text("Next\nline.")));
    expect((markdown(restyled).match(/`/g) ?? []).length - (markdown(original).match(/`/g) ?? []).length).toBe(8);
    expect(identity(restyled)).toBe(identity(original));
    codeWords[1]!.childNodes[0] = text("changed");
    expect(identity(restyled)).not.toBe(identity(original));
  });
  test("retained identity survives 48 presentation newlines and eight inline-code ticks", () => {
    const words = Array.from({ length: 49 }, (_, index) => `token${index}`);
    const original = node("div", node("p", text(words.join(" "))),
      node("p", text("Run alpha, beta, gamma, delta.")));
    const restyled = node("div", node("p", text(words.join(" \n"))),
      node("p", text("Run "), node("code", text("alpha")), text(", "),
        node("code", text("beta")), text(", "), node("code", text("gamma")),
        text(", "), node("code", text("delta")), text(".")));
    const before = markdown(original);
    const after = markdown(restyled);
    expect(after.length - before.length).toBe(56);
    expect((after.match(/\n/g) ?? []).length - (before.match(/\n/g) ?? []).length).toBe(48);
    expect((after.match(/`/g) ?? []).length - (before.match(/`/g) ?? []).length).toBe(8);
    expect(identity(restyled)).toBe(identity(original));
    (restyled.childNodes[0] as Element).childNodes[0] = text(words.join(" \n").replace("token24", "changed"));
    expect(identity(restyled)).not.toBe(identity(original));
  });
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
