import { describe, expect, test } from "bun:test";
import { createOwnershipManifest, type OwnedResource } from "./ownership";
import { applyInstallPlan, planInstall, verifyInstall } from "./install";
import type { OwnershipObservation } from "./uninstall";

const resource: OwnedResource = {
  kind: "service-registration",
  id: "gateway-service",
  owner: "gateway",
  registrationId: "chatgpt-tela-gateway.fixture",
};

describe("product install plan/apply/verify", () => {
  test("absent desired state plans one create and verifies after exact apply", async () => {
    const manifest = createOwnershipManifest("0.0.0");
    let state: OwnershipObservation = "missing";
    const operator = {
      observe: async () => state,
      async create() { state = "owned"; return { created: true, detail: "fixture created" }; },
    };
    const plan = await planInstall({ manifest, desiredResources: [resource], observer: operator });
    expect(plan.steps[0]).toMatchObject({ action: "create", mutating: true });
    const applied = await applyInstallPlan({ manifest, desiredResources: [resource], plan, operator });
    expect(applied.steps[0]).toMatchObject({ outcome: "created" });
    expect((await verifyInstall({ manifest, desiredResources: [resource], observer: operator })).ready).toBe(true);
  });

  test("keep plan never widens into create when an owned resource disappears before apply", async () => {
    const manifest = createOwnershipManifest("0.0.0");
    let state: OwnershipObservation = "owned";
    let creates = 0;
    const operator = {
      observe: async () => state,
      async create() { creates += 1; state = "owned"; return { created: true, detail: "unexpected" }; },
    };
    const plan = await planInstall({ manifest, desiredResources: [resource], observer: operator });
    expect(plan.steps[0]?.action).toBe("keep");
    state = "missing";
    const applied = await applyInstallPlan({ manifest, desiredResources: [resource], plan, operator });
    expect(applied.steps[0]?.outcome).toBe("preserved");
    expect(creates).toBe(0);
  });

  test("create plan never overwrites a resource that appears with foreign ownership before apply", async () => {
    const manifest = createOwnershipManifest("0.0.0");
    let state: OwnershipObservation = "missing";
    let creates = 0;
    const operator = {
      observe: async () => state,
      async create() { creates += 1; state = "owned"; return { created: true, detail: "unexpected" }; },
    };
    const plan = await planInstall({ manifest, desiredResources: [resource], observer: operator });
    state = "ownership-drift";
    const applied = await applyInstallPlan({ manifest, desiredResources: [resource], plan, operator });
    expect(applied.steps[0]?.outcome).toBe("preserved");
    expect(creates).toBe(0);
  });

  test("a preserve plan remains non-mutating even if the conflict later disappears", async () => {
    const manifest = createOwnershipManifest("0.0.0");
    let state: OwnershipObservation = "ownership-drift";
    let creates = 0;
    const operator = {
      observe: async () => state,
      async create() { creates += 1; state = "owned"; return { created: true, detail: "unexpected" }; },
    };
    const plan = await planInstall({ manifest, desiredResources: [resource], observer: operator });
    expect(plan.steps[0]?.action).toBe("preserve");
    state = "missing";
    const applied = await applyInstallPlan({ manifest, desiredResources: [resource], plan, operator });
    expect(applied.steps[0]?.outcome).toBe("preserved");
    expect(creates).toBe(0);
  });

  test("desired identity conflict with the manifest is preserved before external observation", async () => {
    const manifest = Object.freeze({
      ...createOwnershipManifest("0.0.0"),
      resources: Object.freeze([{ ...resource, registrationId: "different.fixture" } as OwnedResource]),
    });
    let observations = 0;
    const plan = await planInstall({
      manifest,
      desiredResources: [resource],
      observer: { observe: async () => { observations += 1; return "missing" as const; } },
    });
    expect(plan.steps[0]?.action).toBe("preserve");
    expect(observations).toBe(0);
  });

  test("apply rejects a same-id resource whose identity changed after planning", async () => {
    const manifest = createOwnershipManifest("0.0.0");
    const observer = { observe: async () => "missing" as const };
    const plan = await planInstall({ manifest, desiredResources: [resource], observer });
    const changed: OwnedResource = { ...resource, registrationId: "changed.fixture" };
    await expect(applyInstallPlan({
      manifest,
      desiredResources: [changed],
      plan,
      operator: { ...observer, async create() { return { created: true, detail: "unexpected" }; } },
    })).rejects.toThrow("identities changed");
  });
});
