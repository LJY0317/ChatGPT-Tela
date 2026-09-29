import { randomUUID } from "node:crypto";
import {
  createElectronMainProcessBrowserHost,
  type ElectronMainRuntimeLike,
} from "@chatgpt-tela/electron-host";
import {
  type ChatGptAccountIdentity,
  type ChatGptConnectorProbe,
  ChatGptSemanticProvider,
  type ChatGptCapabilities,
  createChatGptContextAttachment,
  requireProven,
  type WebConversationProvider,
} from "@chatgpt-tela/chatgpt";
import {
  resolveChatGptTelaBrowserProfile,
  type ChatGptTelaBrowserProfile,
} from "./browser-profile";
import {
  createChatGptProfileControl,
  type ChatGptAccountIdentityObserver,
  type ElectronProfileSetupSurface,
} from "./profile-control";

export interface ElectronProfileSetupConfig {
  readonly slot: number;
  readonly profileId: string;
  readonly profileRoot: string;
  readonly browserUserDataDir: string;
  readonly accountBindingPath: string;
  readonly chatGptUrl?: string;
  readonly revealWhenReady: boolean;
  readonly runContextCanary: boolean;
}

export interface ElectronProfileSetupRuntime {
  probeChatGptReadiness(signal?: AbortSignal): Promise<ChatGptCapabilities>;
  probeChatGptProfile(signal?: AbortSignal): Promise<{
    readonly capabilities: ChatGptCapabilities;
    readonly account: ChatGptAccountIdentity;
  }>;
  recoverChatGptStartupArtifact(signal?: AbortSignal): Promise<boolean>;
  probeChatGptContextAttachment(signal?: AbortSignal): Promise<{
    readonly attachmentBytes: number;
    readonly receiptVerified: true;
  }>;
  openProfileSetupSurface(options?: { readonly reveal?: boolean }): Promise<ElectronProfileSetupSurface>;
  stop(): Promise<void>;
}

function required(env: Readonly<Record<string, string | undefined>>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`profile setup requires ${key}`);
  return value;
}

function optional(env: Readonly<Record<string, string | undefined>>, key: string): string | undefined {
  const value = env[key]?.trim();
  return value || undefined;
}

function optionalBoolean(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): boolean {
  const value = optional(env, key);
  if (value === undefined || value === "0") return false;
  if (value === "1") return true;
  throw new Error(`${key} must be 0 or 1`);
}

export function loadElectronProfileSetupConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ElectronProfileSetupConfig {
  const profile: ChatGptTelaBrowserProfile = resolveChatGptTelaBrowserProfile({
    slot: required(env, "CHATGPT_TELA_PROFILE_SETUP_SLOT"),
    ...(optional(env, "CHATGPT_TELA_PROFILE_ROOT")
      ? { profileRoot: optional(env, "CHATGPT_TELA_PROFILE_ROOT")! }
      : {}),
    environment: env,
  });
  const chatGptUrl = optional(env, "CHATGPT_TELA_PROFILE_SETUP_CHATGPT_URL");
  return Object.freeze({
    slot: profile.slot,
    profileId: profile.profileId,
    profileRoot: profile.profileRoot,
    browserUserDataDir: profile.userDataDir,
    accountBindingPath: profile.accountBindingPath,
    ...(chatGptUrl ? { chatGptUrl } : {}),
    revealWhenReady: optionalBoolean(env, "CHATGPT_TELA_PROFILE_SETUP_REVEAL"),
    runContextCanary: optionalBoolean(env, "CHATGPT_TELA_PROFILE_SETUP_CONTEXT_CANARY"),
  });
}

/**
 * Setup-only Electron composition.
 *
 * This intentionally starts no Responses server, MCP listener/exposure, Native current-turn source,
 * or Codex route. It owns only the persistent ChatGPT browser profile and non-consequential profile
 * control surfaces needed to prepare and verify that profile.
 */
export async function startElectronProfileSetupRuntime(
  config: ElectronProfileSetupConfig,
  options: {
    readonly provider?: Pick<WebConversationProvider, "observeCapabilities">
      & Partial<Pick<WebConversationProvider, "preloadContextAttachment">>
      & Partial<ChatGptConnectorProbe>;
    readonly accountIdentityObserver?: ChatGptAccountIdentityObserver;
    readonly electron?: {
      readonly loadRuntime?: () => Promise<ElectronMainRuntimeLike>;
      readonly window?: {
        readonly width?: number;
        readonly height?: number;
        readonly minWidth?: number;
        readonly minHeight?: number;
        readonly title?: string;
      };
    };
  } = {},
): Promise<ElectronProfileSetupRuntime> {
  const browserHost = await createElectronMainProcessBrowserHost({
    profileId: config.profileId,
    userDataDir: config.browserUserDataDir,
    initialUrl: config.chatGptUrl ?? "https://chatgpt.com/",
    ...(options.electron?.window ? { window: options.electron.window } : {}),
    ...(options.electron?.loadRuntime ? { loadRuntime: options.electron.loadRuntime } : {}),
  });
  const provider = options.provider ?? new ChatGptSemanticProvider();
  const control = createChatGptProfileControl({
    browserHost,
    provider,
    ...(options.accountIdentityObserver ? { accountIdentityObserver: options.accountIdentityObserver } : {}),
  });
  let stopping: Promise<void> | undefined;
  return Object.freeze({
    probeChatGptReadiness: (signal?: AbortSignal) => control.probeChatGptReadiness(signal),
    probeChatGptProfile: (signal?: AbortSignal) => control.probeChatGptProfile(signal),
    async recoverChatGptStartupArtifact(signal?: AbortSignal) {
      if (!provider.recoverConnectorProbeArtifact) return false;
      return control.recoverChatGptConnectorProbeArtifact(signal);
    },
    async probeChatGptContextAttachment(signal?: AbortSignal) {
      const preload = provider.preloadContextAttachment;
      if (!preload) throw new Error("Web provider does not support context attachment preload");
      const epochId = `profile-setup-context-canary-${randomUUID()}`;
      const taskId = `profile-setup-context-canary:${config.profileId}`;
      const surface = await browserHost.acquire({ taskId, epochId });
      try {
        const attachment = createChatGptContextAttachment(Object.freeze({
          headRevisionId: "context-canary-r1",
          activeRequestRevisionId: "context-canary-r1",
          mode: "full" as const,
          logicalTokens: 12,
          transferTokens: 12,
          segments: Object.freeze([Object.freeze({
            type: "revision" as const,
            revisionId: "context-canary-r1",
            kind: "user" as const,
            content: "ChatGPT Tela setup-only context attachment canary. No Native task execution is requested.",
          })]),
        }));
        const result = requireProven(await preload.call(provider as WebConversationProvider, surface, {
          nativeTaskId: taskId,
          webEpochId: epochId,
          attachment,
        }, signal));
        if (result.nativeTaskId !== taskId
          || result.webEpochId !== epochId
          || result.attachmentName !== attachment.name
          || result.attachmentSha256 !== attachment.sha256
          || !result.providerOperationId.trim()) {
          throw new Error("setup-only context attachment canary returned mismatched proof identity");
        }
        return Object.freeze({
          attachmentBytes: Buffer.byteLength(attachment.contextJson, "utf8"),
          receiptVerified: true as const,
        });
      } finally {
        await browserHost.release(surface.leaseId);
      }
    },
    openProfileSetupSurface: (options?: { readonly reveal?: boolean }) => control.openProfileSetupSurface(options),
    stop() {
      if (stopping) return stopping;
      stopping = (async () => {
        const failures: unknown[] = [];
        try {
          await control.close();
        } catch (error) {
          failures.push(error);
        }
        try {
          await browserHost.close();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, "ChatGPT profile setup runtime did not fully close owned browser state");
        }
      })().catch(error => {
        stopping = undefined;
        throw error;
      });
      return stopping;
    },
  });
}
