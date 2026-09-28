import { expect, test } from "bun:test";
import {
  assertConnectorAbiIdentityStable,
  defineConnectorAbi,
  fingerprintMcpToolContracts,
} from "./abi";

test("connector ABI identity is generation-based and fingerprint is order-stable", () => {
  const a = { name: "a", description: "A", inputSchema: { type: "object", properties: { x: { type: "string" } } } };
  const b = { name: "b", description: "B", inputSchema: { required: ["n"], type: "object" } };
  const first = defineConnectorAbi({ generation: 1, displayName: "ChatGPT Tela", tools: [b, a] });
  const second = defineConnectorAbi({ generation: 1, displayName: "ChatGPT Tela", tools: [a, b] });

  expect(first.displayName).toBe("ChatGPT Tela");
  expect(first.schemaFingerprint).toBe(second.schemaFingerprint);
});

test("one connector identity cannot silently change to a different public schema", () => {
  const previous = defineConnectorAbi({ generation: 1, displayName: "ChatGPT Tela", tools: [] });
  const next = defineConnectorAbi({
    generation: 1,
    displayName: "ChatGPT Tela",
    tools: [{ name: "new_tool", description: "new", inputSchema: { type: "object" } }],
  });
  expect(() => assertConnectorAbiIdentityStable(previous, next)).toThrow("cannot change its public MCP ABI in place");
});

test("development schema fingerprints are order-stable without assigning a public connector identity", () => {
  const a = { name: "a", description: "A", inputSchema: { type: "object", properties: {} } };
  const b = { name: "b", description: "B", inputSchema: { type: "object", required: [] } };
  expect(fingerprintMcpToolContracts([a, b])).toBe(fingerprintMcpToolContracts([b, a]));
});
