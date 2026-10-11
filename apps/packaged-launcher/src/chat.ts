import { readServiceRuntimeDescriptor } from "@chatgpt-tela/service-protocol";
import { ChatServiceClient, descriptorForService } from "@chatgpt-tela/service-protocol/client";
import { join } from "node:path";
import { manageChatApprovedRoots, chatApprovedRootsFingerprint } from "@chatgpt-tela/chat-service";
import { prepareOwnedDirectory, type ProductPathOptions } from "@chatgpt-tela/product-lifecycle";
import { verifyInstalledPackage } from "./runtime";

export async function runPackagedChatCommand(args: readonly string[], input: {
  readonly payloadRoot: string;
  readonly launcherExecutablePath?: string;
  readonly pathOptions?: ProductPathOptions;
}) {
  const action = args[1];
  if (args[0] !== "chat" || !(action === "roots" || action === "allow-root" || action === "disallow-root")
    || (action === "roots" ? args.length !== 2 : args.length !== 4 || args[2] !== "--path")) {
    throw new Error("usage: chat roots | chat <allow-root|disallow-root> --path <folder>");
  }
  const { paths, ownership } = verifyInstalledPackage(input);
  if (action !== "roots") await prepareOwnedDirectory({manifestPath:paths.installManifest,
    installId:ownership.installId,productVersion:ownership.productVersion,
    resource:{kind:"directory",id:"product-config",owner:"product",path:paths.configRoot,dataClass:"config"}});
  const config = manageChatApprovedRoots(join(paths.configRoot,"chat","approved-roots-v1.json"),action,args[3]);
  let applied = false;
  try {
    const descriptor = readServiceRuntimeDescriptor(join(paths.serviceRuntime("chat"),"descriptor.json"));
    if (descriptor?.installId === ownership.installId && descriptor.service === "chat") {
      const client = new ChatServiceClient(descriptorForService(descriptor,"chat"));
      try { const signal = AbortSignal.timeout(3_000); await client.status(signal);
        applied = (await client.workspacePolicyFingerprint(signal)) === chatApprovedRootsFingerprint(config);
      } finally { await client.close(); }
    }
  } catch { /* A stopped or older Chat service cannot prove the new policy. */ }
  return { roots: config.roots, applied, requiresChatRestart: !applied };
}
