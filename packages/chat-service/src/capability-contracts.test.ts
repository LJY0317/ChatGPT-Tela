import { describe, expect, test } from "bun:test";
import { parseChatCapabilityContract } from "@chatgpt-tela/service-protocol";
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
    expect(base.map(item => item.capability)).not.toContain("start_agent");
    expect(base.map(item => item.capability)).not.toContain("list_agent_targets");
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

  test("available descriptors survive protocol parsing without claiming account parity", () => {
    for (const item of chatCapabilityCatalog(TELA_CHAT_CAPABILITIES)) {
      const parsed = parseChatCapabilityContract(JSON.parse(JSON.stringify(item)));
      expect(parsed.semantics).toEqual(item.semantics);
      expect(parsed.semantics?.maturity).toBe("implemented");
      expect(parsed.semantics?.authority).toBe("chat_service");
      expect(Object.isFrozen(parsed.semantics)).toBe(true);
    }
  });

  test("mutating and arbitrary capabilities never advertise safe blind replay", () => {
    const catalog = chatCapabilityCatalog(TELA_CHAT_CAPABILITIES);
    for (const item of catalog) {
      if (item.semantics?.effect !== "read") expect(item.semantics?.replay).not.toBe("observe_again");
    }
    const semantics = (name: string) => catalog.find(item => item.capability === name)?.semantics;
    expect(semantics("exec_command")).toMatchObject({ effect: "arbitrary_execution", replay: "same_operation_id", verification: "process_status" });
    expect(semantics("inspect_native_work")).toMatchObject({ effect: "read", scope: "service",
      replay: "observe_again", verification: "bounded_result" });
    expect(semantics("inspect_native_evidence")).toMatchObject({ effect: "read", scope: "service",
      replay: "observe_again", verification: "bounded_result" });
    expect(semantics("write_stdin")).toMatchObject({ effect: "arbitrary_execution", replay: "inspect_before_repeat" });
    expect(semantics("show_changes")).toMatchObject({ effect: "service_state", replay: "inspect_before_repeat" });
    expect(semantics("start_agent")).toMatchObject({ effect: "arbitrary_execution", replay: "inspect_before_repeat" });
  });

  test("legacy discovery remains valid; invalid semantics cannot create authority", () => {
    const legacy = { capability: "future_tool", description: "Future", inputSchema: { type: "object" } };
    expect(parseChatCapabilityContract(legacy).semantics).toBeUndefined();
    const semantics = chatCapabilityCatalog(["read"])[0]!.semantics!;
    for (const invalid of [null, [], { ...semantics, version: 2 }, { ...semantics, authority: "native_turn" },
      { ...semantics, effect: "read_or_write" }, { ...semantics, maturity: "verified_parity" }]) {
      expect(() => parseChatCapabilityContract({ ...legacy, semantics: invalid })).toThrow("Invalid Chat capability semantics");
    }
    const parsed = parseChatCapabilityContract({ ...legacy, semantics: { ...semantics, credential: "discard-me" } });
    expect(JSON.stringify(parsed)).not.toContain("discard-me");
  });
});

// Discovery metadata is model-visible when requested. Keep its cost bounded and queryable.
test("semantic discovery stays within the reviewed inventory budget", () => {
  const full = chatCapabilityCatalog(TELA_CHAT_CAPABILITIES);
  const oldShape = full.map(({ semantics, ...contract }) => contract);
  expect(Buffer.byteLength(JSON.stringify(full)) - Buffer.byteLength(JSON.stringify(oldShape))).toBeLessThanOrEqual(7 * 1024);
  const requested = chatCapabilityCatalog(TELA_CHAT_CAPABILITIES, "exec_command");
  expect(requested).toHaveLength(1);
  expect(Buffer.byteLength(JSON.stringify(requested))).toBeLessThanOrEqual(1024);
});
