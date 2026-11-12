import { existsSync } from "node:fs";
import { join } from "node:path";
import { readProductConfig } from "@chatgpt-tela/product-config";
import { resolveProductPaths, type ProductPaths } from "@chatgpt-tela/product-lifecycle";
import { MultiProfileControlClient } from "@chatgpt-tela/setup";
import { emitDiagnosticEvent } from "@chatgpt-tela/core";
import { CompositeNativeTargetAdapter, MultiProfileNativeTargetAdapter, type CodexNativeTargetAdapter } from "../../../packages/codex-service/src/native-target";

/** Desktop identity belongs to its provider, not to a derived app's bundle URL. */
export async function runDesktopAppCommand(args: readonly string[], input: {
  paths?: ProductPaths;
  targets?: Pick<CodexNativeTargetAdapter, "profiles" | "resolve">;
  client?: Pick<MultiProfileControlClient, "launchTarget">;
} = {}) {
  const paths = input.paths ?? resolveProductPaths();
  const configPath = join(paths.configRoot, "product-v1.json");
  const config = existsSync(configPath) ? readProductConfig(configPath) : undefined;
  const targets = input.targets ?? new CompositeNativeTargetAdapter({
    ...(config?.multiProfile ? { multiProfile: new MultiProfileNativeTargetAdapter(config.multiProfile) } : {}),
  });
  if (args.length === 2 && args[1] === "snapshot") {
    const profiles = (await targets.profiles()).filter(({ session }) => session.desktopProcessId !== undefined)
      .map(({ target }) => ({ slot: target.slot, targetId: target.id }));
    emitDiagnosticEvent("chatgpt_tela_update", "desktop_restore_snapshot", { count: profiles.length, optional_provider: config?.multiProfile !== undefined });
    return { contractVersion: 1, profiles };
  }
  if (args.length !== 6 || args[1] !== "open" || args[2] !== "--slot" || args[4] !== "--target") {
    throw Error("usage: desktop-app snapshot | desktop-app open --slot N --target ID");
  }
  const slot = Number(args[3]);
  if (!Number.isSafeInteger(slot) || slot < 2 || slot > 99) throw Error("managed Desktop slot must be from 2 to 99");
  const { target } = await targets.resolve(slot);
  if (!target.managed || target.adapterKind !== "multi-profile" || target.id !== args[5]) throw Error("Desktop profile ownership changed");
  const client = input.client ?? (config?.multiProfile ? new MultiProfileControlClient({ command: [config.multiProfile.launcherCli] }) : undefined);
  if (!client) throw Error("Desktop profile provider is unavailable");
  emitDiagnosticEvent("chatgpt_tela_update", "desktop_owner_open_started", { slot, target_kind: target.adapterKind });
  const result = await client.launchTarget({ targetId: target.id, expectedProfileIndex: slot });
  emitDiagnosticEvent("chatgpt_tela_update", "desktop_owner_open_accepted", { slot, state: result.state });
  return { contractVersion: 1, slot, ...result };
}
