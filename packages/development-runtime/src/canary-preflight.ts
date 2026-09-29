import { createServer } from "node:net";
import {
  MultiProfileControlClient,
} from "@chatgpt-tela/setup";
import type { WebConversationProvider } from "@chatgpt-tela/chatgpt";
import type { ElectronMainRuntimeLike } from "@chatgpt-tela/electron-host";
import type { DevelopmentCanaryPreflightConfig } from "./canary";
import { startElectronProfileSetupRuntime } from "./profile-setup";
import {
  assertChatGptTelaAccountBinding,
  readChatGptTelaAccountBinding,
  type ChatGptTelaBrowserProfile,
} from "./browser-profile";
import type { ChatGptAccountIdentityObserver } from "./profile-control";

export type CanaryPreflightStatus = "pass" | "warning" | "blocked";

export interface CanaryPreflightCheck {
  readonly id: string;
  readonly status: CanaryPreflightStatus;
  readonly detail: string;
}

export interface DevelopmentCanaryPreflight {
  readonly ready: boolean;
  readonly nativeProfile: "stock" | "multi-profile";
  readonly checks: readonly CanaryPreflightCheck[];
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function portAvailable(port: number): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const server = createServer();
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    server.once("error", () => finish(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(error => finish(!error));
    });
  });
}

/**
 * Read-only/live-safe preflight for the development canary.
 *
 * It may briefly bind the two configured loopback ports and create one hidden ChatGPT browser surface,
 * but it never starts Responses/MCP services, changes Codex config, launches a managed profile, or
 * acquires an external tunnel. This keeps user-owned restart/login boundaries explicit.
 */
export async function preflightDevelopmentCanary(
  config: DevelopmentCanaryPreflightConfig,
  options: {
    readonly provider?: Pick<WebConversationProvider, "observeCapabilities">;
    readonly accountIdentityObserver?: ChatGptAccountIdentityObserver;
    readonly electron?: {
      readonly loadRuntime?: () => Promise<ElectronMainRuntimeLike>;
    };
    readonly multiProfileClient?: MultiProfileControlClient;
    readonly signal?: AbortSignal;
  } = {},
): Promise<DevelopmentCanaryPreflight> {
  const checks: CanaryPreflightCheck[] = [];
  const push = (id: string, status: CanaryPreflightStatus, message: string) => {
    checks.push(Object.freeze({ id, status, detail: message }));
  };

  const responsesAvailable = await portAvailable(config.responsesPort);
  push(
    "responses-port",
    responsesAvailable ? "pass" : "blocked",
    responsesAvailable
      ? `127.0.0.1:${config.responsesPort} is available`
      : `127.0.0.1:${config.responsesPort} is already in use`,
  );
  const mcpAvailable = await portAvailable(config.mcp.localPort);
  push(
    "mcp-port",
    mcpAvailable ? "pass" : "blocked",
    mcpAvailable
      ? `127.0.0.1:${config.mcp.localPort} is available`
      : `127.0.0.1:${config.mcp.localPort} is already in use`,
  );

  if (config.nativeProfile.kind === "stock") {
    push(
      "stock-process-route",
      "pass",
      "stock canary uses process-local Codex overrides and never rewrites the live config.toml",
    );
  } else {
    const nativeProfile = config.nativeProfile;
    try {
      const client = options.multiProfileClient ?? new MultiProfileControlClient({
        command: [nativeProfile.controlCli],
      });
      const targets = await client.targets(options.signal);
      const target = targets.find(candidate => candidate.id === nativeProfile.targetId);
      if (!target) {
        push("managed-target-contract", "blocked", `Multi-Profile target is not available: ${nativeProfile.targetId}`);
      } else if (!target.managed || !target.sharedAppServerSupported || !target.responsesRouteSupported) {
        push("managed-target-contract", "blocked", "selected Multi-Profile target does not support the required managed app-server/Responses contract");
      } else {
        push("managed-target-contract", "pass", `${target.displayName} exposes the required public control contract`);
        const session = await client.targetSession(target.id, options.signal);
        if (session.state === "ready") {
          push(
            "managed-target-restart-boundary",
            "blocked",
            `${target.displayName} is currently running; quit it normally before the launch-time Responses route canary`,
          );
        } else {
          push("managed-target-restart-boundary", "pass", `${target.displayName} is not holding a live routed session`);
        }
      }
    } catch (error) {
      push("managed-target-contract", "blocked", detail(error));
    }
  }

  push(
    "mcp-exposure-config",
    "pass",
    config.mcp.kind === "existing-https"
      ? `existing HTTPS MCP endpoint configured at ${config.mcp.publicUrl.origin}`
      : `OpenAI Secure MCP Tunnel runtime configured for tunnel ${config.mcp.tunnelId}`,
  );

  let profileRuntime: Awaited<ReturnType<typeof startElectronProfileSetupRuntime>> | undefined;
  try {
    const existingBinding = readChatGptTelaAccountBinding(config.browserProfile);
    if (!existingBinding) {
      push(
        "chatgpt-readiness",
        "blocked",
        `${config.chatGptTelaProfileId} has no verified ChatGPT account binding; run profile setup for slot ${config.browserProfile.slot} first`,
      );
      return Object.freeze({
        ready: false,
        nativeProfile: config.nativeProfile.kind,
        checks: Object.freeze(checks),
      });
    }
    profileRuntime = await startElectronProfileSetupRuntime({
      slot: config.browserProfile.slot,
      profileId: config.chatGptTelaProfileId,
      profileRoot: config.browserProfile.profileRoot,
      browserUserDataDir: config.browserUserDataDir,
      accountBindingPath: config.browserProfile.accountBindingPath,
      revealWhenReady: false,
      runContextCanary: false,
    }, {
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.accountIdentityObserver ? { accountIdentityObserver: options.accountIdentityObserver } : {}),
      ...(options.electron ? { electron: options.electron } : {}),
    });
    const setupSurface = await profileRuntime.openProfileSetupSurface({ reveal: false });
    try {
      const observed = await setupSurface.probeChatGptProfile(options.signal);
      assertChatGptTelaAccountBinding(
        config.browserProfile as ChatGptTelaBrowserProfile,
        observed.account.accountFingerprint,
      );
      push(
        "chatgpt-readiness",
        "pass",
        `${config.chatGptTelaProfileId} proves one composer/send surface and its verified account binding without submitting a turn`,
      );
    } finally {
      await setupSurface.close();
    }
  } catch (error) {
    push("chatgpt-readiness", "blocked", detail(error));
  } finally {
    if (profileRuntime) {
      try {
        await profileRuntime.stop();
      } catch (error) {
        push("chatgpt-profile-cleanup", "blocked", detail(error));
      }
    }
  }

  return Object.freeze({
    ready: !checks.some(check => check.status === "blocked"),
    nativeProfile: config.nativeProfile.kind,
    checks: Object.freeze(checks),
  });
}
