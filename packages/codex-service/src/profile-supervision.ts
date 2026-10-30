import { StringDecoder } from "node:string_decoder";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { diagnosticFingerprint, emitDiagnosticEvent } from "@chatgpt-tela/core";

export interface ProfileSupervisorLease {
  readonly environment: Readonly<Record<string, string>>;
  readonly connected: Promise<void>;
  readonly ready: Promise<unknown>;
  close(): Promise<void>;
}

function sameToken(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** One authenticated loopback connection whose lifetime is owned by the Codex service process. */
export async function createProfileSupervisorLease(input: { readonly onProgress?: (phase: string) => void } = {}): Promise<ProfileSupervisorLease> {
  const token = randomBytes(36).toString("base64url");
  const leaseFingerprint = diagnosticFingerprint(token), startedAt = performance.now();
  const observe = (phase: string) => emitDiagnosticEvent("chatgpt_tela_codex", "profile_supervisor_lifecycle", {
    lease_fingerprint: leaseFingerprint, phase, duration_ms: Math.round(performance.now() - startedAt),
  });
  let accepted: Socket | undefined;
  let resolveConnected!: () => void;
  let rejectConnected!: (error: Error) => void;
  const connected = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveConnected = resolvePromise;
    rejectConnected = rejectPromise;
  });
  // A caller can fail before it begins awaiting the lease (for example if the
  // child executable cannot spawn). Keep the original promise rejectable for
  // callers while preventing an abandoned lease from becoming an unhandled
  // rejection.
  void connected.catch(() => {});
  let resolveReady!: (value: unknown) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<unknown>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => {});
  let readyReceived = false;
  const rejectStartup = (error: Error) => { rejectConnected(error); rejectReady(error); };
  let settled = false;
  let closed = false;
  let rejectedConnections = 0;
  let connectTimeout: ReturnType<typeof setTimeout> | undefined;
  const server: Server = createServer(socket => {
    if (accepted) { socket.destroy(); return; }
    socket.setNoDelay(true);
    socket.on("error", () => { if (accepted === socket && !readyReceived) rejectReady(new Error("profile supervision connection failed")); });
    let buffer = "";
    const reject = () => {
      rejectedConnections += 1;
      socket.destroy();
      if (rejectedConnections >= 8 && !settled) {
        settled = true;
        if (connectTimeout) clearTimeout(connectTimeout);
        rejectStartup(new Error("profile supervisor received too many invalid handshakes"));
      }
    };
    socket.setTimeout(5_000, reject);
    socket.on("data", chunk => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 512) return reject();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const candidate = buffer.slice(0, newline);
      if (!sameToken(candidate, token)) return reject();
      observe("authenticated");
      socket.removeAllListeners("data");
      const decoder = new StringDecoder("utf8");
      let lifecycleBuffer = buffer.slice(newline + 1);
      let lifecycleBytes = Buffer.byteLength(lifecycleBuffer);
      const receiveLifecycle = (chunk = "") => {
        lifecycleBytes += Buffer.byteLength(chunk);
        lifecycleBuffer += chunk;
        if (lifecycleBytes > 64 * 1024) {
          rejectReady(new Error("profile lifecycle publication exceeded its bounded limit")); socket.destroy(); return;
        }
        while (true) {
          const end = lifecycleBuffer.indexOf("\n");
          if (end < 0) return;
          const line = lifecycleBuffer.slice(0, end); lifecycleBuffer = lifecycleBuffer.slice(end + 1);
          try {
            const value = JSON.parse(line);
            if (!value || typeof value !== "object" || Array.isArray(value) || readyReceived) throw new Error("invalid lifecycle publication");
            if (value.stage === "product-profile-progress" && typeof value.phase === "string"
              && ["browser", "account", "connector", "models", "opening"].includes(value.phase)) {
              input.onProgress?.(value.phase);
            } else if (value.stage === "product-profile-ready") {
              observe("ready");
              readyReceived = true; resolveReady(value);
            } else throw new Error("invalid lifecycle publication");
          } catch {
            rejectReady(new Error("profile lifecycle publication is invalid")); socket.destroy(); return;
          }
        }
      };
      socket.on("data", chunk => receiveLifecycle(decoder.write(chunk)));
      socket.once("close", () => { if (!readyReceived) rejectReady(new Error("profile supervisor closed before readiness")); });
      receiveLifecycle();
      socket.setTimeout(0);
      accepted = socket;
      socket.write("ok\n");
      if (!settled) {
        settled = true;
        if (connectTimeout) clearTimeout(connectTimeout);
        resolveConnected();
      }
      server.close();
    });
  });
  server.on("error", error => {
    if (!settled) {
      settled = true;
      rejectStartup(new Error("profile supervisor listener failed", { cause: error }));
    }
  });
  observe("listen_started");
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  observe("listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("profile supervisor loopback listener has no TCP address");
  }
  connectTimeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectStartup(new Error("profile supervisor child handshake timed out"));
    server.close();
  }, 10_000);

  return Object.freeze({
    environment: Object.freeze({
      CHATGPT_TELA_PRODUCT_SUPERVISOR_PORT: String(address.port),
      CHATGPT_TELA_PRODUCT_SUPERVISOR_TOKEN: token,
    }),
    connected,
    ready,
    async close() {
      if (closed) return;
      closed = true;
      observe("close_requested");
      rejectReady(new Error("profile supervisor closed before readiness"));
      accepted?.destroy();
      if (!settled) {
        settled = true;
        if (connectTimeout) clearTimeout(connectTimeout);
        rejectStartup(new Error("profile supervisor closed before the child connected"));
      }
      if (server.listening) await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
    },
  });
}
