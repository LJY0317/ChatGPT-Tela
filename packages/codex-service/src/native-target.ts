import { existsSync, lstatSync } from "node:fs";
import {
  MultiProfileControlClient,
  type MultiProfileTarget,
  type MultiProfileTargetSession,
} from "@chatgpt-tela/setup";
import {
  defaultDesktopProcessIds,
  requestDefaultDesktopNormalQuit,
  resolveDefaultDesktopInstallation,
  type DefaultDesktopInstallation,
} from "@chatgpt-tela/default-desktop-target";

export interface CodexNativeTarget {
  readonly slot: number;
  readonly adapterKind: "default-desktop" | "multi-profile";
  readonly id: string;
  readonly displayName: string;
  readonly state: string;
  readonly managed: boolean;
}

export interface CodexNativeTargetSession {
  readonly targetId: string;
  readonly state: string;
  readonly responsesRouteFingerprint?: string;
  readonly desktopProcessId?: number;
}

export interface CodexNativeTargetAdapter {
  readonly kind: "default-desktop" | "multi-profile" | "composite";
  profiles(signal?: AbortSignal): Promise<readonly {
    readonly target: CodexNativeTarget;
    readonly session: CodexNativeTargetSession;
  }[]>;
  resolve(slot: number, signal?: AbortSignal): Promise<{
    readonly target: CodexNativeTarget;
    readonly session: CodexNativeTargetSession;
  }>;
  session(targetId: string, signal?: AbortSignal): Promise<CodexNativeTargetSession>;
  quit(targetId: string, signal?: AbortSignal): Promise<CodexNativeTargetSession>;
  profileRuntimeEnvironment(target: CodexNativeTarget): Readonly<Record<string, string>>;
}

interface MultiProfileControlContract {
  targets(signal?: AbortSignal): Promise<readonly MultiProfileTarget[]>;
  targetSession(targetId: string, signal?: AbortSignal): Promise<MultiProfileTargetSession>;
  quitTarget(targetId: string, signal?: AbortSignal): Promise<MultiProfileTargetSession>;
}

function slot(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 99) {
    throw new Error("profile slot must be an integer from 1 to 99");
  }
  return value;
}

function mappedTarget(target: MultiProfileTarget): CodexNativeTarget | undefined {
  const targetSlot = target.role === "default" && target.managed === false
    ? 1
    : target.managed && target.profileIndex
      ? target.profileIndex
      : undefined;
  if (!targetSlot) return undefined;
  if (!target.sharedAppServerSupported || !target.responsesRouteSupported) {
    throw new Error(`native target does not support the required Tela Codex route: ${target.displayName}`);
  }
  return Object.freeze({
    slot: targetSlot,
    adapterKind: "multi-profile" as const,
    id: target.id,
    displayName: target.displayName,
    state: target.state,
    managed: target.managed,
  });
}

const DEFAULT_TARGET_ID = "default";

export class DefaultDesktopNativeTargetAdapter implements CodexNativeTargetAdapter {
  readonly kind = "default-desktop" as const;
  readonly #configuredInstallation: DefaultDesktopInstallation | undefined;
  readonly #environment: Readonly<Record<string, string | undefined>> | undefined;
  readonly #processIds: (installation: DefaultDesktopInstallation) => Promise<readonly number[]>;
  readonly #normalQuit: (installation: DefaultDesktopInstallation, pid: number) => Promise<void>;
  #resolvedInstallation: DefaultDesktopInstallation | undefined;

  constructor(input: {
    readonly installation?: DefaultDesktopInstallation;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly processIds?: (installation: DefaultDesktopInstallation) => Promise<readonly number[]>;
    readonly normalQuit?: (installation: DefaultDesktopInstallation, pid: number) => Promise<void>;
  } = {}) {
    this.#configuredInstallation = input.installation;
    this.#environment = input.environment;
    this.#processIds = input.processIds ?? defaultDesktopProcessIds;
    this.#normalQuit = input.normalQuit ?? requestDefaultDesktopNormalQuit;
  }

  #installation(): DefaultDesktopInstallation {
    if (this.#configuredInstallation) return this.#configuredInstallation;
    this.#resolvedInstallation ??= resolveDefaultDesktopInstallation(
      this.#environment ? { environment: this.#environment } : {},
    );
    return this.#resolvedInstallation;
  }

  async #snapshot(): Promise<{
    readonly target: CodexNativeTarget;
    readonly session: CodexNativeTargetSession;
  }> {
    const installation = this.#installation();
    const pids = await this.#processIds(installation);
    if (pids.length > 1) {
      throw new Error("official ChatGPT Desktop process identity is ambiguous; refusing to attach the default Tela target");
    }
    const pid = pids[0];
    return Object.freeze({
      target: Object.freeze({
        slot: 1,
        adapterKind: "default-desktop" as const,
        id: DEFAULT_TARGET_ID,
        displayName: "ChatGPT",
        state: pid ? "running" : "stopped",
        managed: false,
      }),
      session: Object.freeze({
        targetId: DEFAULT_TARGET_ID,
        state: pid ? "restart-required" : "available",
        ...(pid ? { desktopProcessId: pid } : {}),
      }),
    });
  }

  async profiles() {
    return Object.freeze([await this.#snapshot()]);
  }

  async resolve(slotValue: number) {
    if (slot(slotValue) !== 1) {
      throw new Error("built-in default Desktop adapter serves only canonical profile slot 1; configure Multi-Profile for additional accounts");
    }
    return this.#snapshot();
  }

  async session(targetId: string): Promise<CodexNativeTargetSession> {
    if (targetId !== DEFAULT_TARGET_ID) throw new Error(`unknown built-in default Desktop target: ${targetId}`);
    return (await this.#snapshot()).session;
  }

  async quit(targetId: string): Promise<CodexNativeTargetSession> {
    const before = await this.session(targetId);
    if (before.state === "available") return before;
    if (!before.desktopProcessId) throw new Error("default Desktop process identity is unavailable for normal quit");
    await this.#normalQuit(this.#installation(), before.desktopProcessId);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const current = await this.session(targetId);
      if (current.state === "available") return current;
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
    }
    throw new Error("official ChatGPT Desktop did not exit after normal quit request");
  }

  profileRuntimeEnvironment(target: CodexNativeTarget): Readonly<Record<string, string>> {
    if (target.slot !== 1 || target.id !== DEFAULT_TARGET_ID || target.adapterKind !== "default-desktop") {
      throw new Error("built-in default Desktop adapter received a foreign target");
    }
    return Object.freeze({
      CHATGPT_TELA_PRODUCT_NATIVE_TARGET_KIND: "default-desktop",
      CHATGPT_TELA_PRODUCT_TARGET_ID: DEFAULT_TARGET_ID,
    });
  }
}

export class CompositeNativeTargetAdapter implements CodexNativeTargetAdapter {
  readonly kind = "composite" as const;
  readonly #defaultDesktop: CodexNativeTargetAdapter;
  readonly #multiProfile: CodexNativeTargetAdapter | undefined;

  constructor(input: {
    readonly defaultDesktop?: CodexNativeTargetAdapter;
    readonly multiProfile?: CodexNativeTargetAdapter;
  } = {}) {
    this.#defaultDesktop = input.defaultDesktop ?? new DefaultDesktopNativeTargetAdapter();
    this.#multiProfile = input.multiProfile;
  }

  async profiles(signal?: AbortSignal) {
    const primary = await this.#defaultDesktop.resolve(1, signal);
    if (!this.#multiProfile) return Object.freeze([primary]);
    let optionalProfiles: readonly { readonly target: CodexNativeTarget; readonly session: CodexNativeTargetSession }[];
    try {
      optionalProfiles = await this.#multiProfile.profiles(signal);
    } catch {
      return Object.freeze([primary]);
    }
    const extras = optionalProfiles.filter(item => item.target.slot > 1);
    const slots = new Set<number>([1]);
    for (const item of extras) {
      if (slots.has(item.target.slot)) throw new Error(`duplicate native target profile slot ${item.target.slot}`);
      slots.add(item.target.slot);
    }
    return Object.freeze([primary, ...extras]);
  }

  async resolve(slotValue: number, signal?: AbortSignal) {
    const selected = slot(slotValue);
    if (selected === 1) return await this.#defaultDesktop.resolve(1, signal);
    if (!this.#multiProfile) {
      throw new Error(`profile slot ${selected} requires the optional Multi-Profile adapter`);
    }
    return await this.#multiProfile.resolve(selected, signal);
  }

  session(targetId: string, signal?: AbortSignal): Promise<CodexNativeTargetSession> {
    if (targetId === DEFAULT_TARGET_ID) return this.#defaultDesktop.session(targetId, signal);
    if (!this.#multiProfile) throw new Error(`unknown native target without Multi-Profile adapter: ${targetId}`);
    return this.#multiProfile.session(targetId, signal);
  }

  quit(targetId: string, signal?: AbortSignal): Promise<CodexNativeTargetSession> {
    if (targetId === DEFAULT_TARGET_ID) return this.#defaultDesktop.quit(targetId, signal);
    if (!this.#multiProfile) throw new Error(`unknown native target without Multi-Profile adapter: ${targetId}`);
    return this.#multiProfile.quit(targetId, signal);
  }

  profileRuntimeEnvironment(target: CodexNativeTarget): Readonly<Record<string, string>> {
    return target.adapterKind === "default-desktop"
      ? this.#defaultDesktop.profileRuntimeEnvironment(target)
      : this.#multiProfile
        ? this.#multiProfile.profileRuntimeEnvironment(target)
        : (() => { throw new Error("Multi-Profile target is unavailable"); })();
  }
}

function mappedSession(session: MultiProfileTargetSession): CodexNativeTargetSession {
  return Object.freeze({
    targetId: session.targetId,
    state: session.state,
    ...(session.responsesRouteFingerprint
      ? { responsesRouteFingerprint: session.responsesRouteFingerprint }
      : {}),
  });
}

export class MultiProfileNativeTargetAdapter implements CodexNativeTargetAdapter {
  readonly kind = "multi-profile" as const;
  readonly #launcherCli: string;
  readonly #client: MultiProfileControlContract;
  readonly #requiresLauncherFile: boolean;

  constructor(input: {
    readonly launcherCli: string;
    readonly client?: MultiProfileControlContract;
  }) {
    if (!input.launcherCli.trim() || /[\u0000\r\n]/.test(input.launcherCli)) {
      throw new Error("Multi-Profile launcher CLI is invalid");
    }
    this.#launcherCli = input.launcherCli;
    this.#requiresLauncherFile = input.client === undefined;
    this.#client = input.client ?? new MultiProfileControlClient({ command: [input.launcherCli] });
  }

  #assertLauncherAvailable(): void {
    if (!this.#requiresLauncherFile) return;
    if (!existsSync(this.#launcherCli)) {
      throw new Error(`optional Multi-Profile launcher is unavailable: ${this.#launcherCli}`);
    }
    const stat = lstatSync(this.#launcherCli);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("optional Multi-Profile launcher path is unsafe or replaced");
    }
  }

  async profiles(signal?: AbortSignal) {
    this.#assertLauncherAvailable();
    const targets = await this.#client.targets(signal);
    const mapped = targets.map(mappedTarget).filter((value): value is CodexNativeTarget => value !== undefined);
    return Object.freeze(await Promise.all(mapped.map(async target => Object.freeze({
      target,
      session: mappedSession(await this.#client.targetSession(target.id, signal)),
    }))));
  }

  async resolve(slotValue: number, signal?: AbortSignal) {
    const expected = slot(slotValue);
    const matches = (await this.profiles(signal)).filter(item => item.target.slot === expected);
    if (matches.length !== 1) {
      throw new Error(`Multi-Profile adapter does not expose exactly one target for Tela profile slot ${expected}`);
    }
    return matches[0]!;
  }

  async session(targetId: string, signal?: AbortSignal): Promise<CodexNativeTargetSession> {
    this.#assertLauncherAvailable();
    return mappedSession(await this.#client.targetSession(targetId, signal));
  }

  async quit(targetId: string, signal?: AbortSignal): Promise<CodexNativeTargetSession> {
    this.#assertLauncherAvailable();
    return mappedSession(await this.#client.quitTarget(targetId, signal));
  }

  profileRuntimeEnvironment(target: CodexNativeTarget): Readonly<Record<string, string>> {
    return Object.freeze({
      CHATGPT_TELA_PRODUCT_NATIVE_TARGET_KIND: "multi-profile",
      CHATGPT_TELA_PRODUCT_TARGET_ID: target.id,
      CHATGPT_TELA_PRODUCT_LAUNCHER_CLI: this.#launcherCli,
    });
  }
}
