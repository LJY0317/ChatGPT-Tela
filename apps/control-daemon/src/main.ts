import {
  readProductControlConfig,
  removeProductDaemonState,
  resolveProductControlPaths,
  startProductControlDaemon,
  writeProductDaemonState,
} from "@chatgpt-tela/control-plane";

async function main(): Promise<void> {
  const executable = process.env.CHATGPT_TELA_PRODUCT_PROFILE_RUNTIME_EXECUTABLE?.trim();
  const entrypoint = process.env.CHATGPT_TELA_PRODUCT_PROFILE_RUNTIME_ENTRYPOINT?.trim();
  if (!executable || !entrypoint) throw new Error("control daemon is missing the profile runtime command");
  const paths = resolveProductControlPaths();
  const config = readProductControlConfig(paths);
  const daemon = await startProductControlDaemon({
    config,
    profileRuntimeCommand: [executable, entrypoint],
    environment: process.env,
  });
  writeProductDaemonState({
    version: 1,
    pid: process.pid,
    controlUrl: daemon.endpoint.href,
    controlToken: daemon.token,
  }, paths);

  let stopping: Promise<void> | undefined;
  const stop = () => {
    if (!stopping) {
      stopping = daemon.stop().finally(() => removeProductDaemonState(paths));
    }
    return stopping;
  };
  let resolveSignal!: () => void;
  const signaled = new Promise<void>(resolvePromise => { resolveSignal = resolvePromise; });
  const signal = () => { resolveSignal(); };
  process.once("SIGINT", signal);
  process.once("SIGTERM", signal);
  await Promise.race([daemon.shutdownRequested, signaled]);
  await stop();
}

void main().catch(error => {
  console.error(error);
  removeProductDaemonState(resolveProductControlPaths());
  process.exitCode = 1;
});
