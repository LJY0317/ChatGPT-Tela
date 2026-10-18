import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { authorDiagnosticProbe } from "./author-diagnostics";

test("author census distinguishes expanded code and concealed text without returning prose", () => {
  const node = (kind: string, textContent: string) => ({ textContent, matches: (selector: string) => selector.split(',').includes(kind) });
  const code = node("code", "PRIVATE_EXPANDED_BODY"), hidden = node('[aria-hidden="true"]', "PRIVATE_HIDDEN_BODY");
  const expanded = node('[aria-expanded="true"]', "PRIVATE_CONTROL");
  const root = { scrollHeight: 1000, clientHeight: 300 };
  const bubble = { querySelectorAll: (selector: string) => selector === '[data-search-result-target]' ? [root] : [code, hidden, expanded] };
  const result = runInNewContext(`(${authorDiagnosticProbe.toString()})(bubble)`, {
    bubble, getComputedStyle: () => ({ overflowY: "hidden" }),
  });
  expect(result).toMatchObject({ author_probe_available: true, author_code_count: 1, author_hidden_count: 1,
    author_expanded_count: 1, author_root_clips: true, author_code_characters: 21 });
  expect(JSON.stringify(result)).not.toContain("PRIVATE_");
});
