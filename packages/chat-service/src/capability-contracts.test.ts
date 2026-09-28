import { describe, expect, test } from "bun:test";
import {
  TELA_CHAT_CAPABILITIES,
  TELA_CHAT_BASE_CAPABILITIES,
  TELA_CHAT_MANAGED_WORKTREE_CAPABILITIES,
  TELA_CHAT_AGENT_CAPABILITIES,
} from "./tools";
import {
  TELA_CHAT_CAPABILITY_CONTRACTS,
  chatCapabilityCatalog,
} from "./capability-contracts";

describe("Tela Chat capability contracts", () => {
  test("every runtime capability has exactly one inventory contract", () => {
    const names = TELA_CHAT_CAPABILITY_CONTRACTS.map(contract => contract.capability);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual([...TELA_CHAT_CAPABILITIES].sort());
  });

  test("catalog filters by actual runtime availability before query matching", () => {
    const base = chatCapabilityCatalog(TELA_CHAT_BASE_CAPABILITIES, "agent");
    expect(base).toEqual([]);
    const full = chatCapabilityCatalog([
      ...TELA_CHAT_BASE_CAPABILITIES,
      ...TELA_CHAT_MANAGED_WORKTREE_CAPABILITIES,
      ...TELA_CHAT_AGENT_CAPABILITIES,
    ], "agent");
    expect(full.map(item => item.capability)).toContain("start_agent");
    expect(full.map(item => item.capability)).toContain("list_agent_targets");
  });

  test("every contract is a closed object schema", () => {
    for (const contract of TELA_CHAT_CAPABILITY_CONTRACTS) {
      expect(contract.inputSchema.type).toBe("object");
      expect(contract.inputSchema.additionalProperties).toBe(false);
    }
  });
});
