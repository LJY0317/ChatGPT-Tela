import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveProductPaths } from "@chatgpt-tela/product-lifecycle";
import { runDesktopAppCommand } from "./desktop-app";
import type { CodexNativeTargetAdapter } from "../../../packages/codex-service/src/native-target";

test("snapshot stores running provider identities, and open delegates profile isolation to its owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "tela-desktop-owner-"));
  const rows = [1, 2, 3].map(slot => ({ target: { slot, id: slot === 1 ? "default" : `opaque-${slot}`,
    adapterKind: slot === 1 ? "default-desktop" as const : "multi-profile" as const,
    displayName: `Profile ${slot}`, managed: slot > 1, state: slot === 3 ? "stopped" : "running" },
    session: { targetId: slot === 1 ? "default" : `opaque-${slot}`, state: slot === 3 ? "available" : "running",
      ...(slot === 3 ? {} : { desktopProcessId: slot * 123 }) } }));
  const targets: Pick<CodexNativeTargetAdapter, "profiles" | "resolve"> = {
    async profiles() { return rows; }, async resolve(slot) { return rows.find(r => r.target.slot === slot)!; },
  };
  const calls: unknown[] = [];
  const input = { paths: resolveProductPaths({ platform: "linux", home: root, environment: {} }), targets,
    client: { async launchTarget(args: { targetId: string; expectedProfileIndex?: number }) {
      calls.push(args); return { targetId: args.targetId, state: "launch-requested" }; } } };
  try {
    expect(await runDesktopAppCommand(["desktop-app", "snapshot"], input)).toEqual({ contractVersion: 1,
      profiles: [{ slot: 1, targetId: "default" }, { slot: 2, targetId: "opaque-2" }] });
    expect(await runDesktopAppCommand(["desktop-app", "open", "--slot", "2", "--target", "opaque-2"], input))
      .toMatchObject({ slot: 2, targetId: "opaque-2", state: "launch-requested" });
    expect(calls).toEqual([{ targetId: "opaque-2", expectedProfileIndex: 2 }]);
    await expect(runDesktopAppCommand(["desktop-app", "open", "--slot", "2", "--target", "replaced"], input))
      .rejects.toThrow("ownership changed");
    expect(calls).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
