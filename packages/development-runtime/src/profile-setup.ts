import {
  createElectronMainProcessBrowserHost,
  type ElectronMainRuntimeLike,
} from "@chatgpt-tela/electron-host";
import {
  type ChatGptAccountIdentity,
  ChatGptSemanticProvider,
  type ChatGptCapabilities,
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
}

export interface ElectronProfileSetupRuntime {
  probeChatGptReadiness(signal?: AbortSignal): Promise<ChatGptCapabilities>;
  probeChatGptProfile(signal?: AbortSignal): Promise<{
    readonly capabilities: ChatGptCapabilities;
    readonly account: ChatGptAccountIdentity;
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
    readonly provider?: Pick<WebConversationProvider, "observeCapabilities">;
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
