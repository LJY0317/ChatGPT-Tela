import { createConnection, type Socket } from "node:net";
import type { EventEmitter } from "node:events";

type SignalSource = Pick<EventEmitter, "once" | "removeListener">;

export interface ProfileSupervisorLifecycle {
  readonly signal: AbortSignal;
  readonly shutdownRequested: Promise<void>;
  publishReady(value: Readonly<Record<string, unknown>>): Promise<void>;
  dispose(): void;
}

function supervisorPort(): number {
  const value = Number(process.env.CHATGPT_TELA_PRODUCT_SUPERVISOR_PORT ?? "");
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error("profile runtime requires a valid supervisor port");
  }
  return value;
}

function supervisorToken(): string {
  const value = process.env.CHATGPT_TELA_PRODUCT_SUPERVISOR_TOKEN?.trim();
  if (!value || value.length < 32 || value.length > 256 || /[\u0000\r\n]/.test(value)) {
    throw new Error("profile runtime requires a valid supervisor token");
  }
  return value;
}

async function connectSupervisor(port: number, token: string): Promise<Socket> {
  const socket = createConnection({ host: "127.0.0.1", port });
  socket.setNoDelay(true);
  let buffer = "";
  return await new Promise<Socket>((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeListener("connect", onConnect);
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      if (error) {
        socket.destroy();
        rejectPromise(error);
      } else {
        resolvePromise(socket);
      }
    };
    const onConnect = () => socket.write(`${token}\n`);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 64) return finish(new Error("profile supervisor handshake exceeded its bounded response"));
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      if (buffer.slice(0, newline) !== "ok") return finish(new Error("profile supervisor handshake was rejected"));
      finish();
    };
    const onError = () => finish(new Error("profile supervisor connection failed"));
    const onClose = () => finish(new Error("profile supervisor connection closed during handshake"));
    socket.once("connect", onConnect);
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    const timeout = setTimeout(() => finish(new Error("profile supervisor handshake timed out")), 5_000);
  });
}

/**
 * Bind the profile runtime to the lifetime of its Codex-service parent.
 *
 * A private authenticated loopback socket is the supervision lease. It is
 * event-driven and portable across macOS/Windows/Linux. If the parent exits
 * abruptly, the OS closes the socket and this runtime immediately begins its
 * normal teardown instead of surviving as an orphan.
 */
export async function createProfileSupervisorLifecycle(input: {
  readonly signalSource?: SignalSource;
  readonly socket?: Socket;
} = {}): Promise<ProfileSupervisorLifecycle> {
  const signalSource = input.signalSource ?? process;
  const socket = input.socket ?? await connectSupervisor(supervisorPort(), supervisorToken());
  const controller = new AbortController();
  let resolveShutdown!: () => void;
  const shutdownRequested = new Promise<void>(resolvePromise => { resolveShutdown = resolvePromise; });
  let requested = false;
  let publicationAttempted = false;
  const requestShutdown = () => {
    if (requested) return;
    requested = true;
    controller.abort();
    resolveShutdown();
  };
  const onSigint = () => requestShutdown();
  const onSigterm = () => requestShutdown();
  const onSupervisorClosed = () => requestShutdown();
  signalSource.once("SIGINT", onSigint);
  signalSource.once("SIGTERM", onSigterm);
  socket.once("end", onSupervisorClosed);
  socket.once("close", onSupervisorClosed);
  socket.once("error", onSupervisorClosed);
  socket.resume();

  return Object.freeze({
    signal: controller.signal,
    shutdownRequested,
    async publishReady(value: Readonly<Record<string, unknown>>) {
      if (publicationAttempted) throw new Error("profile readiness has already been published");
      if (controller.signal.aborted || socket.destroyed) throw new Error("profile supervisor is closed");
      if (value.stage !== "product-profile-ready") throw new Error("profile readiness publication has an invalid stage");
      const frame = JSON.stringify(value) + "\n";
      if (Buffer.byteLength(frame) > 64 * 1024) throw new Error("profile readiness publication exceeded its bounded limit");
      publicationAttempted = true;
      await new Promise<void>((resolve, reject) => socket.write(frame, error => error ? reject(error) : resolve()));
    },
    dispose() {
      signalSource.removeListener("SIGINT", onSigint);
      signalSource.removeListener("SIGTERM", onSigterm);
      socket.removeListener("end", onSupervisorClosed);
      socket.removeListener("close", onSupervisorClosed);
      socket.removeListener("error", onSupervisorClosed);
      socket.destroy();
    },
  });
}
