import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  applyUninstallPlan,
  FilesystemOwnershipObserver,
  createOwnershipManifest,
  planUninstall,
  resolveProductPaths,
  withOwnedResource,
  writeOwnershipMarker,
} from "./index";

describe("product lifecycle ownership", () => {
  test("uses platform-native roots while keeping service state separate", () => {
    const mac = resolveProductPaths({ platform: "darwin", home: "/Users/test", environment: {} });
    const macHome = resolve("/Users/test");
    expect(mac.binaryRoot).toBe(join(macHome, "Library", "Application Support", "ChatGPT Tela", "bin"));
    expect(mac.stateRoot).toBe(join(macHome, "Library", "Application Support", "ChatGPT Tela", "state"));
    expect(mac.cacheRoot).toBe(join(macHome, "Library", "Caches", "ChatGPT Tela"));
    expect(mac.serviceState("chat")).not.toBe(mac.serviceState("codex"));

    const linux = resolveProductPaths({ platform: "linux", home: "/home/test", environment: {} });
    const linuxHome = resolve("/home/test");
    expect(linux.binaryRoot).toBe(join(linuxHome, ".local", "share", "chatgpt-tela", "bin"));
    expect(linux.configRoot).toBe(join(linuxHome, ".config", "chatgpt-tela"));
    expect(linux.stateRoot).toBe(join(linuxHome, ".local", "state", "chatgpt-tela"));
  });

  test("uninstall removes only directories whose marker proves exact install ownership", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-ownership-"));
    try {
      const owned = join(root, "owned");
      const drifted = join(root, "drifted");
      let manifest = createOwnershipManifest("0.0.0", new Date("2026-09-27T00:00:00Z"));
      manifest = withOwnedResource(manifest, {
        kind: "directory", id: "chat-state", owner: "chat", path: owned, dataClass: "state",
      });
      manifest = withOwnedResource(manifest, {
        kind: "directory", id: "codex-state", owner: "codex", path: drifted, dataClass: "state",
      });
      writeOwnershipMarker(owned, manifest, "chat-state");
      rmSync(drifted, { recursive: true, force: true });
      const plan = await planUninstall({ manifest, observer: new FilesystemOwnershipObserver(), removeData: true });
      expect(plan.steps.find(step => step.resourceId === "chat-state")?.action).toBe("remove");
      expect(plan.steps.find(step => step.resourceId === "codex-state")?.action).toBe("already-absent");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keep-data policy preserves config/state/browser data even when owned", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-keep-data-"));
    try {
      let manifest = createOwnershipManifest("0.0.0");
      manifest = withOwnedResource(manifest, {
        kind: "directory", id: "chat-state", owner: "chat", path: root, dataClass: "state",
      });
      writeOwnershipMarker(root, manifest, "chat-state");
      const plan = await planUninstall({ manifest, observer: new FilesystemOwnershipObserver(), removeData: false });
      expect(plan.steps[0]?.action).toBe("preserve");
      expect(plan.steps[0]?.reason).toContain("preservation");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("credential data is preserved by default and removable only with --remove-data", async () => {
    let manifest = createOwnershipManifest("0.0.0");
    manifest = withOwnedResource(manifest, {
      kind: "credential",
      id: "credential:macos-keychain:agent.openai-responses.api-key",
      owner: "chat",
      credentialId: "agent.openai-responses.api-key",
      storeKind: "macos-keychain",
      storeKey: `tela.${"a".repeat(48)}`,
    });
    const observer = { observe: async () => "owned" as const };
    const keep = await planUninstall({ manifest, observer, removeData: false });
    expect(keep.steps[0]).toMatchObject({ action: "preserve", destructive: false });
    const remove = await planUninstall({ manifest, observer, removeData: true });
    expect(remove.steps[0]).toMatchObject({ action: "remove", destructive: true });
  });

  test("ownership drift is preserved instead of becoming a recursive delete", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-drift-"));
    try {
      let manifest = createOwnershipManifest("0.0.0");
      manifest = withOwnedResource(manifest, {
        kind: "directory", id: "gateway-runtime", owner: "gateway", path: root, dataClass: "runtime",
      });
      const foreign = createOwnershipManifest("9.9.9");
      const foreignWithResource = withOwnedResource(foreign, {
        kind: "directory", id: "gateway-runtime", owner: "gateway", path: root, dataClass: "runtime",
      });
      writeOwnershipMarker(root, foreignWithResource, "gateway-runtime");
      const plan = await planUninstall({ manifest, observer: new FilesystemOwnershipObserver(), removeData: true });
      expect(plan.steps[0]?.action).toBe("preserve");
      expect(plan.steps[0]?.reason).toContain("no longer matches");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("apply re-observes ownership and blocks service-owned resources whose owner did not stop", async () => {
    let observations = 0;
    let removals = 0;
    let manifest = createOwnershipManifest("0.0.0");
    manifest = withOwnedResource(manifest, {
      kind: "service-registration",
      id: "chat-service",
      owner: "chat",
      registrationId: "chat.fixture",
    });
    manifest = withOwnedResource(manifest, {
      kind: "service-registration",
      id: "codex-service",
      owner: "codex",
      registrationId: "codex.fixture",
    });
    const observer = {
      async observe() { observations += 1; return "owned" as const; },
    };
    const plan = await planUninstall({ manifest, observer, removeData: true });
    const result = await applyUninstallPlan({
      manifest,
      plan,
      blockedOwners: new Set(["chat"]),
      operator: {
        async observe() { observations += 1; return "owned" as const; },
        async remove(resource) { removals += 1; return { removed: true, detail: `${resource.id} removed` }; },
      },
    });
    expect(result.steps).toEqual([
      { resourceId: "chat-service", owner: "chat", resourceKind: "service-registration", outcome: "preserved",
        detail: "chat service did not stop cleanly; owned resource was preserved" },
      { resourceId: "codex-service", owner: "codex", resourceKind: "service-registration", outcome: "removed",
        detail: "codex-service removed" },
    ]);
    expect(removals).toBe(1);
    expect(observations).toBe(3);
  });

  test("apply preserves a resource that drifts after dry-run instead of trusting the old plan", async () => {
    let manifest = createOwnershipManifest("0.0.0");
    manifest = withOwnedResource(manifest, {
      kind: "service-registration",
      id: "gateway-service",
      owner: "gateway",
      registrationId: "gateway.fixture",
    });
    const plan = await planUninstall({ manifest, observer: { observe: async () => "owned" as const }, removeData: true });
    let removed = false;
    const result = await applyUninstallPlan({
      manifest,
      plan,
      operator: {
        observe: async () => "ownership-drift" as const,
        async remove() { removed = true; return { removed: true, detail: "unexpected" }; },
      },
    });
    expect(result.steps[0]?.outcome).toBe("preserved");
    expect(result.steps[0]?.detail).toContain("drifted");
    expect(removed).toBe(false);
  });

  test("apply never upgrades an already-absent step into destructive removal", async () => {
    let manifest = createOwnershipManifest("0.0.0");
    manifest = withOwnedResource(manifest, {
      kind: "service-registration",
      id: "late-service",
      owner: "gateway",
      registrationId: "late.fixture",
    });
    const plan = await planUninstall({
      manifest,
      observer: { observe: async () => "missing" as const },
      removeData: true,
    });
    let removed = false;
    const result = await applyUninstallPlan({
      manifest,
      plan,
      operator: {
        observe: async () => "owned" as const,
        async remove() { removed = true; return { removed: true, detail: "unexpected" }; },
      },
    });
    expect(result.steps[0]).toMatchObject({ outcome: "preserved" });
    expect(result.steps[0]?.detail).toContain("appeared after");
    expect(removed).toBe(false);
  });
});
