import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  assertNoActivePackagedTransition, createPackagedInstallBlueprint, FilesystemOwnershipObserver,
  macApplicationUpdatePath, mutateOwnershipManifest, packagedInstallSpecFromPayload, packagedPayloadFingerprint,
  PackagedPlatformServiceController, PackagedServiceShutdownNotStartedError, readMacApplicationUpdate,
  readOwnershipManifest, recordInstalledApplicationPayload, resolveProductPaths, ServiceRegistrationInstaller,
  withPackagedTransitionOwner, type MacApplicationUpdate, type TelaServiceId,
} from "@chatgpt-tela/product-lifecycle";
import { interruptOwnedWork, ownedServiceShutdown } from "./service-shutdown";
import type { PackagedLifecycleOptions } from "./lifecycle";
import { verifyInstalledPackage } from "./runtime";
import { emitDiagnosticEvent } from "@chatgpt-tela/core";

const stopOrder: readonly TelaServiceId[] = ["gateway", "codex", "chat"];
const startOrder: readonly TelaServiceId[] = ["chat", "codex", "gateway"];

/** Sparkle replaces the app. This command only settles existing Tela service ownership. */
export async function runApplicationUpdate(action: "wait" | "prepare" | "finish" | "cancel", input: {
  payloadRoot: string; targetBuild?: string; interruptWork?: boolean; options?: PackagedLifecycleOptions;
  verifySignature?: (path: string) => void;
  readBuild?: (path: string) => string;
  waitForShutdownService?: (service: TelaServiceId) => Promise<void>;
}) {
  const options = input.options ?? {}, paths = resolveProductPaths(options);
  const step = async <T>(phase: string, run: () => T | Promise<T>, service?: TelaServiceId): Promise<T> => {
    const started = performance.now();
    const fields = { action, phase, ...(service ? { service } : {}) };
    emitDiagnosticEvent("chatgpt_tela_update", "application_update_phase_started", fields);
    let completed = false;
    try {
      const result = await run();
      completed = true;
      return result;
    } finally {
      emitDiagnosticEvent("chatgpt_tela_update", completed ? "application_update_phase_finished" : "application_update_phase_failed",
        { ...fields, outcome: completed ? "completed" : "failed", duration_ms: Math.round(performance.now() - started) });
    }
  };
  const root = realpathSync(input.payloadRoot), spec = packagedInstallSpecFromPayload(root);
  const blueprint = createPackagedInstallBlueprint({ spec, ...options });
  if (blueprint.platform !== "darwin" || !blueprint.payload.resource.metadataRoot
    || realpathSync(blueprint.payload.resource.path) !== root) throw Error("application update requires the installed complete macOS app");
  const owner = readOwnershipManifest(paths.installManifest);
  if (!owner || new FilesystemOwnershipObserver().observe(blueprint.payload.resource, owner) !== "owned"
    || JSON.stringify(owner.resources.find(item => item.id === "product-binaries")) !== JSON.stringify(blueprint.payload.resource)) {
    throw Error("application update ownership does not match this installed app");
  }
  const shutdown = ownedServiceShutdown(owner.installId, paths);
  const prepare = options.prepareShutdownService ?? (options.shutdownService ? undefined : shutdown.prepare);
  const controller = new PackagedPlatformServiceController({ blueprint,
    shutdownService: options.shutdownService ?? shutdown,
    prepareShutdownService: prepare ? service => step("service_prepare", () => prepare(service), service) : undefined,
    waitUntilReady: options.waitUntilReady ?? (options.shutdownService ? undefined : shutdown.ready),
    ...(options.runner ? { runner: options.runner } : {}), ...(options.userId === undefined ? {} : { userId: options.userId }),
  });
  // Observation precedes the mutation lock and creates no transition journal.
  // Native completion precedes detached Chat work it may have launched.
  if (action === "wait") {
    for (const service of ["codex", "chat", "gateway"] as const) {
      if (await step("service_inspect", () => controller.inspect(service), service) !== "running") continue;
      await step("work_completion", () => (input.waitForShutdownService ?? shutdown.wait)(service), service);
    }
    return { ready: true };
  }
  const verifySignature = input.verifySignature ?? (path => {
    execFileSync("/usr/bin/codesign", ["--verify", "--strict", "--deep", path], { stdio: "pipe" });
  });
  const readBuild = input.readBuild ?? (path => execFileSync("/usr/bin/plutil", ["-extract", "CFBundleVersion", "raw", "-o", "-", join(path, "Contents/Info.plist")], { encoding: "utf8" }).trim());
  const path = macApplicationUpdatePath(paths);
  const save = (state: MacApplicationUpdate) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path + ".pending", JSON.stringify(state) + "\n", { mode: 0o600 });
    renameSync(path + ".pending", path);
    return state;
  };
  return step("transition", () => withPackagedTransitionOwner({ paths, installId: owner.installId }, async () => {
    const previous = readMacApplicationUpdate(paths);
    if (previous && previous.installId !== owner.installId) throw Error("application update belongs to another installation");
    if (action === "cancel" && !previous) return { ready: true, productVersion: spec.productVersion };
    await step("signature", () => verifySignature(root));
    const build = readBuild(root);
    // A prepared replacement has the old receipt until finish records its new bytes.
    // Otherwise reuse the fingerprint already proven by ordinary installed verification.
    const fingerprint = await step("payload_verification", () => previous ? packagedPayloadFingerprint(root)
      : verifyInstalledPackage({ payloadRoot: root, pathOptions: options, menuBar: action === "finish" }).receipt.payloadFingerprint);
    const installer = new ServiceRegistrationInstaller({ platform: "darwin", ...(options.runner ? { runner: options.runner } : {}) });
    const finish = async (state: MacApplicationUpdate) => {
      if (state.installId !== owner.installId || state.applicationPath !== root
        || (build !== state.targetBuild && fingerprint !== state.sourceFingerprint)
        || (state.pendingStop && fingerprint !== state.sourceFingerprint)) throw Error("installed app does not match the prepared update or its source");
      if (state.phase === "resuming" && (state.resumeVersion !== spec.productVersion || state.resumeFingerprint !== fingerprint)) {
        throw Error("application changed during service restoration");
      }
      const current = readOwnershipManifest(paths.installManifest);
      if (!current || current.installId !== state.installId
        || ![state.sourceVersion, state.resumeVersion].includes(current.productVersion)) throw Error("application update ledger changed");
      state = save({ ...state, phase: "resuming", resumeVersion: spec.productVersion, resumeFingerprint: fingerprint });
      await step("payload_record", () => recordInstalledApplicationPayload(blueprint.payload.resource, current, spec.productVersion, fingerprint));
      const manifest = await step("ownership_record", () => mutateOwnershipManifest({ path: paths.installManifest, installId: current.installId,
        productVersion: spec.productVersion, mutate(value) { return { ...value, productVersion: spec.productVersion, updatedAt: new Date().toISOString() }; } }));
      // Unknown stop settlement never authorizes replacing a service owner. Restore only acknowledged peers.
      const admitted = state.pendingStop ? state.stoppedServices : startOrder;
      for (const service of admitted) {
        const entry = blueprint.services.find(entry => entry.service === service)!;
        await step("registration_install", () => installer.install({ manifestPath: paths.installManifest, manifest, resource: entry.resource, definition: entry.definition }), service);
      }
      for (const service of startOrder) {
        if (!state.runningServices.includes(service) || state.resumedServices.includes(service)
          || state.pendingStop && !state.stoppedServices.includes(service)) continue;
        await step("service_resume", () => controller.resume(service), service);
        state = save({ ...state, resumedServices: [...state.resumedServices, service] });
      }
      if (state.pendingStop) throw Error(`application update is postponed: ${state.pendingStop} shutdown has not been settled; acknowledged peers were restored`);
      rmSync(path);
      return { ready: true, restored: true, productVersion: spec.productVersion, buildVersion: build };
    };
    if (action === "cancel" && previous) {
      if (fingerprint !== previous.sourceFingerprint) throw Error("a replaced application cannot be cancelled back to source");
      return finish(previous);
    }
    if (action === "finish") {
      if (previous?.phase === "ready" && fingerprint === previous.sourceFingerprint) {
        // Source bytes alone do not prove Sparkle aborted. Leave its prepared handoff intact.
        return { ready: false, prepared: true, targetBuild: previous.targetBuild };
      }
      if (previous) return finish(previous);
      return { ready: true, productVersion: spec.productVersion, buildVersion: build };
    }
    if (previous?.phase === "ready" && previous.targetBuild === input.targetBuild && previous.sourceFingerprint === fingerprint) {
      return { prepared: true, targetBuild: previous.targetBuild };
    }
    assertNoActivePackagedTransition(paths, "application update");
    if (!input.targetBuild || !/^\d+(\.\d+){0,2}$/.test(input.targetBuild) || input.targetBuild === build) throw Error("a different numeric target build is required");
    const running: TelaServiceId[] = [];
    for (const service of stopOrder) if (await step("service_inspect", () => controller.inspect(service), service) === "running") running.push(service);
    if (input.interruptWork) await step("work_interruption", () => interruptOwnedWork(owner.installId, paths, running));
    await step("services_prepare", () => controller.prepare(stopOrder));
    let state = save({ version: 1, installId: owner.installId, sourceVersion: owner.productVersion, sourceBuild: build,
      targetBuild: input.targetBuild, applicationPath: root, sourceFingerprint: fingerprint, phase: "quiescing",
      runningServices: running, stoppedServices: [], resumedServices: [] });
    try {
      for (const service of running) {
        state = save({ ...state, pendingStop: service });
        try { await step("service_stop", () => controller.quiesce(service), service); }
        catch (error) {
          if (error instanceof PackagedServiceShutdownNotStartedError) state = save({ ...state, pendingStop: undefined });
          throw error;
        }
        state = save({ ...state, pendingStop: undefined, stoppedServices: [...state.stoppedServices, service] });
      }
      // Unload registered jobs before Sparkle changes signed executable bytes; no cached launchd code identity survives.
      for (const entry of blueprint.services) await step("registration_unload", () => installer.unloadForPayloadReplacement({ manifestPath: paths.installManifest, manifest: owner, resource: entry.resource, definition: entry.definition }), entry.service);
      state = save({ ...state, phase: "ready" });
      return { prepared: true, targetBuild: state.targetBuild };
    } catch (error) {
      if (state.pendingStop && await step("shutdown_settlement", () => controller.settleQuiescence())) {
        state = save({ ...state, stoppedServices: [...state.stoppedServices, state.pendingStop], pendingStop: undefined });
      }
      try { await finish(state); }
      catch (recovery) { throw new AggregateError([error, recovery], "application update was postponed and needs service settlement"); }
      throw error;
    }
  }));
}
