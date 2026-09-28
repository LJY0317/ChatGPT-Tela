import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureOwnershipManifest,
  readOwnershipManifest,
  registerOwnedResource,
  unregisterOwnedResource,
} from "./index";

describe("ownership manifest store", () => {
  test("concurrent install identity creation converges on one manifest", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-manifest-create-"));
    const path = join(root, "ownership-v1.json");
    try {
      const manifests = await Promise.all(Array.from({ length: 4 }, () => ensureOwnershipManifest({
        path,
        productVersion: "0.0.0",
      })));
      expect(new Set(manifests.map(manifest => manifest.installId)).size).toBe(1);
      expect(readOwnershipManifest(path)?.installId).toBe(manifests[0]!.installId);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("serializes concurrent dynamic registrations without dropping either resource", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-manifest-lock-"));
    const path = join(root, "ownership-v1.json");
    try {
      await Promise.all([
        registerOwnedResource({ path, installId: "install-lock-test", productVersion: "0.0.0",
          resource: { kind: "managed-worktree", id: "worktree-a", owner: "chat", path: join(root, "a"),
            repositoryIdentity: "repo-a" } }),
        registerOwnedResource({ path, installId: "install-lock-test", productVersion: "0.0.0",
          resource: { kind: "managed-worktree", id: "worktree-b", owner: "chat", path: join(root, "b"),
            repositoryIdentity: "repo-b" } }),
      ]);
      expect(readOwnershipManifest(path)?.resources.map(resource => resource.id).sort())
        .toEqual(["worktree-a", "worktree-b"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("registration is idempotent but install/resource identity drift fails closed", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-manifest-id-"));
    const path = join(root, "ownership-v1.json");
    const resource = { kind: "managed-worktree" as const, id: "worktree-a", owner: "chat" as const,
      path: join(root, "a"), repositoryIdentity: "repo-a" };
    try {
      await registerOwnedResource({ path, installId: "install-a", productVersion: "0.0.0", resource });
      await registerOwnedResource({ path, installId: "install-a", productVersion: "0.0.0", resource });
      await expect(registerOwnedResource({ path, installId: "install-a", productVersion: "0.0.0",
        resource: { ...resource, repositoryIdentity: "repo-b" } })).rejects.toThrow("different identity");
      await expect(registerOwnedResource({ path, installId: "install-b", productVersion: "0.0.0", resource }))
        .rejects.toThrow("different Tela install");
      await unregisterOwnedResource({ path, installId: "install-a", productVersion: "0.0.0", resourceId: resource.id });
      expect(readOwnershipManifest(path)?.resources).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
