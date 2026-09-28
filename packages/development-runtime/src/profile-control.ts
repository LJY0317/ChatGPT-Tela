import { randomUUID } from "node:crypto";
import type { BrowserHost, BrowserSurfaceLease } from "@chatgpt-tela/browser-host";
import type {
  ChatGptAccountIdentity,
  ChatGptCapabilities,
  ChatGptConnectorObservation,
  ChatGptConnectorProbe,
  WebConversationProvider,
} from "@chatgpt-tela/chatgpt";
import { observeChatGptAccountIdentity } from "@chatgpt-tela/chatgpt";

export interface ChatGptProfileObservation {
  readonly capabilities: ChatGptCapabilities;
  readonly account: ChatGptAccountIdentity;
}

export type ChatGptAccountIdentityObserver = (
  surface: BrowserSurfaceLease,
  signal?: AbortSignal,
) => Promise<ChatGptAccountIdentity>;

export interface ElectronProfileSetupSurface {
  readonly leaseId: string;
  probeChatGptReadiness(signal?: AbortSignal): Promise<ChatGptCapabilities>;
  probeChatGptProfile(signal?: AbortSignal): Promise<ChatGptProfileObservation>;
  reveal(): Promise<void>;
  close(): Promise<void>;
}

export interface ChatGptProfileControl {
  probeChatGptReadiness(signal?: AbortSignal): Promise<ChatGptCapabilities>;
  probeChatGptProfile(signal?: AbortSignal): Promise<ChatGptProfileObservation>;
  recoverChatGptConnectorProbeArtifact(signal?: AbortSignal): Promise<boolean>;
  probeChatGptConnector(signal?: AbortSignal): Promise<ChatGptConnectorObservation>;
  openProfileSetupSurface(options?: { readonly reveal?: boolean }): Promise<ElectronProfileSetupSurface>;
  close(): Promise<void>;
}

async function proveReadiness(
  surface: Parameters<Pick<WebConversationProvider, "observeCapabilities">["observeCapabilities"]>[0],
  provider: Pick<WebConversationProvider, "observeCapabilities">,
  signal?: AbortSignal,
): Promise<ChatGptCapabilities> {
  const observation = await provider.observeCapabilities(surface, signal);
  if (observation.state !== "proven") {
    throw new Error(
      `ChatGPT profile readiness is not proven: ${observation.state}; ${observation.evidence.join("; ")}`,
    );
  }
  if (!observation.value.observed.has("composer") || !observation.value.observed.has("send")) {
    throw new Error("ChatGPT profile readiness is missing composer/send capability");
  }
  return observation.value;
}

async function proveProfile(
  surface: Parameters<Pick<WebConversationProvider, "observeCapabilities">["observeCapabilities"]>[0],
  provider: Pick<WebConversationProvider, "observeCapabilities">,
  accountIdentityObserver: ChatGptAccountIdentityObserver,
  signal?: AbortSignal,
): Promise<ChatGptProfileObservation> {
  const capabilities = await proveReadiness(surface, provider, signal);
  const account = await accountIdentityObserver(surface, signal);
  return Object.freeze({ capabilities, account });
}

/**
 * Own only non-consequential ChatGPT profile-control surfaces.
 *
 * Readiness observes one isolated surface and submits nothing. Setup surfaces may be revealed for
 * human login/Developer Mode/connector preparation, but they never receive Native turn authority or
 * an MCP bearer. The BrowserHost itself remains caller-owned.
 */
export function createChatGptProfileControl(input: {
  readonly browserHost: BrowserHost;
  readonly provider: Pick<WebConversationProvider, "observeCapabilities"> & Partial<ChatGptConnectorProbe>;
  readonly accountIdentityObserver?: ChatGptAccountIdentityObserver;
}): ChatGptProfileControl {
  const setupLeases = new Set<string>();
  let closed = false;
  let closing: Promise<void> | undefined;

  const requireOpen = (): void => {
    if (closed || closing) throw new Error("ChatGPT profile control is closing");
  };
  const accountIdentityObserver = input.accountIdentityObserver ?? observeChatGptAccountIdentity;

  return Object.freeze({
    async probeChatGptReadiness(signal?: AbortSignal) {
      requireOpen();
      const lease = await input.browserHost.acquire({
        taskId: "chatgpt-tela-profile-readiness",
        epochId: `readiness-${randomUUID()}`,
      });
      try {
        return await proveReadiness(lease, input.provider, signal);
      } finally {
        await input.browserHost.release(lease.leaseId);
      }
    },
    async probeChatGptProfile(signal?: AbortSignal) {
      requireOpen();
      const lease = await input.browserHost.acquire({
        taskId: "chatgpt-tela-profile-identity",
        epochId: `identity-${randomUUID()}`,
      });
      try {
        return await proveProfile(lease, input.provider, accountIdentityObserver, signal);
      } finally {
        await input.browserHost.release(lease.leaseId);
      }
    },
    async probeChatGptConnector(signal?: AbortSignal) {
      requireOpen();
      if (!input.provider.probeConnector) {
        throw new Error("ChatGPT provider does not support connector preflight");
      }
      const lease = await input.browserHost.acquire({
        taskId: "chatgpt-tela-connector-readiness",
        epochId: `connector-${randomUUID()}`,
      });
      try {
        return await input.provider.probeConnector(lease, signal);
      } finally {
        await input.browserHost.release(lease.leaseId);
      }
    },
    async recoverChatGptConnectorProbeArtifact(signal?: AbortSignal) {
      requireOpen();
      if (!input.provider.recoverConnectorProbeArtifact) {
        throw new Error("ChatGPT provider does not support connector artifact recovery");
      }
      const lease = await input.browserHost.acquire({
        taskId: "chatgpt-tela-connector-recovery",
        epochId: `connector-recovery-${randomUUID()}`,
      });
      try {
        return await input.provider.recoverConnectorProbeArtifact(lease, signal);
      } finally {
        await input.browserHost.release(lease.leaseId);
      }
    },
    async openProfileSetupSurface(options: { readonly reveal?: boolean } = {}) {
      requireOpen();
      const lease = await input.browserHost.acquire({
        taskId: "chatgpt-tela-profile-setup",
        epochId: `setup-${randomUUID()}`,
      });
      try {
        if (options.reveal !== false) await lease.reveal();
      } catch (error) {
        await input.browserHost.release(lease.leaseId).catch(() => {});
        throw error;
      }
      setupLeases.add(lease.leaseId);
      let surfaceClosed = false;
      const requireSurfaceOpen = (): void => {
        if (surfaceClosed || !setupLeases.has(lease.leaseId)) {
          throw new Error("ChatGPT profile setup surface is closed");
        }
      };
      return Object.freeze({
        leaseId: lease.leaseId,
        async probeChatGptReadiness(signal?: AbortSignal) {
          requireSurfaceOpen();
          return proveReadiness(lease, input.provider, signal);
        },
        async probeChatGptProfile(signal?: AbortSignal) {
          requireSurfaceOpen();
          return proveProfile(lease, input.provider, accountIdentityObserver, signal);
        },
        async reveal() {
          requireSurfaceOpen();
          await lease.reveal();
        },
        async close() {
          if (surfaceClosed) return;
          surfaceClosed = true;
          if (!setupLeases.delete(lease.leaseId)) return;
          await input.browserHost.release(lease.leaseId);
        },
      });
    },
    close() {
      if (closing) return closing;
      if (closed) return Promise.resolve();
      closing = (async () => {
        const leases = [...setupLeases];
        setupLeases.clear();
        const results = await Promise.allSettled(leases.map(leaseId => input.browserHost.release(leaseId)));
        const failures = results
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map(result => result.reason);
        closed = true;
        if (failures.length > 0) {
          throw new AggregateError(failures, `${failures.length} ChatGPT profile-control surface(s) failed to close`);
        }
      })().finally(() => {
        closing = undefined;
      });
      return closing;
    },
  });
}
