import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DynamicChatBackend, createPublicMcpServer } from "@chatgpt-tela/gateway";
import { readOwnershipManifest, resolveProductPaths, type ProductPaths } from "@chatgpt-tela/product-lifecycle";
import { readServiceRuntimeDescriptor } from "@chatgpt-tela/service-protocol";

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

if (import.meta.main) {
  void serveDeviceLocalChatStdio().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
