import { expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startCodexService } from "../controller";
import type { CodexNativeTargetAdapter } from "../native-target";

const dir = mkdtempSync(join(tmpdir(), "tela-unexpected-exit-test-"));
try {
  const child = join(dir, "child.ts");
  const serverModule = resolve(import.meta.dir, "../../../mcp/src/http-server.ts");
  const supervisionModule = resolve(import.meta.dir, "../../../../apps/profile-runtime/src/supervision.ts");
  writeFileSync(child, `import {startCodexBridgeMcpHttpServer} from ${JSON.stringify(serverModule)};
import {createProfileSupervisorLifecycle} from ${JSON.stringify(supervisionModule)};
const lifecycle=await createProfileSupervisorLifecycle();
const server=await startCodexBridgeMcpHttpServer({bridge:{inventory(){return []},async invoke(){throw new Error('unused')}},authentication:{kind:'bearer',token:process.env.CHATGPT_TELA_PRODUCT_INTERNAL_MCP_TOKEN}});
await lifecycle.publishReady({stage:'product-profile-ready',runtimeProcessId:process.pid,slot:1,routeId:process.env.CHATGPT_TELA_PRODUCT_ROUTE_ID,targetId:'fixture',nativeTargetKind:'multi-profile',nativeReady:true,webState:'preparing',profileId:'fixture',internalMcpUrl:server.endpointUrl.href,bridgePreviewUrl:'http://127.0.0.1:1',responsesUrl:'http://127.0.0.1:1',responsesRouteFingerprint:'a'.repeat(64)});
await lifecycle.shutdownRequested;await server.stop();lifecycle.dispose();
`);
  const childBundled = join(dir, "child.mjs");
  await Bun.build({ entrypoints: [child], target: "node", outdir: dir, naming: "child.mjs" });

  let started = false;
  let quits = 0;
  const changes: unknown[] = [];
  const target = { slot: 1, adapterKind: "multi-profile" as const, id: "fixture", displayName: "Fixture", state: "stopped", managed: true };
  const session = () => ({ targetId: "fixture", state: started ? "ready" : "available", ...(started ? { responsesRouteFingerprint: "a".repeat(64) } : {}) });
  const adapter: CodexNativeTargetAdapter = {
    kind: "multi-profile",
    async profiles() { return [{ target, session: session() }]; },
    async resolve() { return { target, session: session() }; },
    async session() { return session(); },
    async quit() { quits += 1; started = false; return session(); },
    profileRuntimeEnvironment() { started = true; return {}; },
  };
  const service = await startCodexService({
    config: {},
    profileRuntimeCommand: [process.execPath, childBundled],
    nativeTargetAdapter: adapter,
    onProfileConnectionChanged: (...args) => { changes.push(args); },
  });
  try {
    const profile = await service.startProfile(1);
    expect(profile.controlState).toBe("running");
    expect(profile.childProcessId).toBeNumber();
    process.kill(profile.childProcessId!, "SIGKILL");
    const deadline = Date.now() + 4_000;
    while (service.activeProfileCount !== 0 && Date.now() < deadline) await Bun.sleep(25);
    expect(service.activeProfileCount).toBe(0);
    expect(quits).toBe(1);
    expect(started).toBe(false);
    expect(changes).toEqual([["fixture", true]]);
  } finally {
    await service.close();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(JSON.stringify({ unexpectedChildExitCleanup: true }));
