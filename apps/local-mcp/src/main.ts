import { readdirSync } from "node:fs";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DynamicChatBackend, createPublicMcpServer } from "@chatgpt-tela/gateway";
import { prepareOwnedDirectory, readOwnershipManifest, registerLocalMarketplace, resolveProductPaths,
  withPackagedTransitionOwner, type ProductPaths } from "@chatgpt-tela/product-lifecycle";
import { readServiceRuntimeDescriptor } from "@chatgpt-tela/service-protocol";
import { normalizeOwnedLocalChatPlugin, prepareLocalChatPlugin } from "./plugin-package";

/** The installed service's local runtime descriptor is the only backend selector. */
export function createDeviceLocalChatMcpServer(paths: ProductPaths = resolveProductPaths()) {
  const install = readOwnershipManifest(paths.installManifest);
  if (!install) throw new Error("Tela is not installed on this computer");
  const chat = new DynamicChatBackend(() => {
    // An existing stdio session must not retain access after local removal or
    // attach itself to a replacement installation with a different owner.
    if (readOwnershipManifest(paths.installManifest)?.installId !== install.installId) return undefined;
    const descriptor = readServiceRuntimeDescriptor(join(paths.serviceRuntime("chat"), "descriptor.json"));
    return descriptor?.service === "chat" && descriptor.installId === install.installId ? descriptor : undefined;
  });
  // Reuse the public Chat tool/asset registration; omit the Native tool bridge entirely.
  return createPublicMcpServer({ chat });
}

export async function serveDeviceLocalChatStdio(paths?: ProductPaths): Promise<void> {
  const server = createDeviceLocalChatMcpServer(paths);
  await server.connect(new StdioServerTransport());
}

export async function registerDeviceLocalChatPlugin(input: { paths: ProductPaths; launcherExecutablePath: string; marketplacePath: string }) {
  const manifest = readOwnershipManifest(input.paths.installManifest);
  if (!manifest) throw new Error("local marketplace requires an installed Tela product");
  const root = join(input.paths.stateRoot, "install", "local-chat-plugin");
  const resource = { kind: "directory" as const, id: "local-chat-plugin-source", owner: "product" as const, path: root, dataClass: "binary" as const };
  return withPackagedTransitionOwner({ paths: input.paths, installId: manifest.installId }, async () => {
    const prepared = await prepareOwnedDirectory({ manifestPath: input.paths.installManifest, installId: manifest.installId, productVersion: manifest.productVersion, resource });
    if (prepared.state === "external-existing") throw Error("local plugin source belongs to another owner");
    const contents = readdirSync(root).filter(name => name !== ".chatgpt-tela-owner.json");
    if (contents.length === 0) prepareLocalChatPlugin(root, input.launcherExecutablePath);
    else normalizeOwnedLocalChatPlugin(root, input.launcherExecutablePath);
    return registerLocalMarketplace({ manifestPath: input.paths.installManifest, marketplacePath: input.marketplacePath, pluginPath: join(root, "plugins", "tela-local-chat") });
  });
}

if (import.meta.main) {
  void serveDeviceLocalChatStdio().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
