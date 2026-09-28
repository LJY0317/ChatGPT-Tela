import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type TelaServiceId = "gateway" | "chat" | "codex";

export interface ProductPaths {
  readonly binaryRoot: string;
  readonly configRoot: string;
  readonly stateRoot: string;
  readonly cacheRoot: string;
  readonly logsRoot: string;
  readonly runtimeRoot: string;
  readonly installManifest: string;
  serviceState(service: TelaServiceId): string;
  serviceRuntime(service: TelaServiceId): string;
}

export interface ProductPathOptions {
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

function envPath(env: Readonly<Record<string, string | undefined>>, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? resolve(value) : undefined;
}

export function resolveProductPaths(options: ProductPathOptions = {}): ProductPaths {
  const platform = options.platform ?? process.platform;
  const home = resolve(options.home ?? homedir());
  const env = options.environment ?? process.env;
  let configRoot: string;
  let binaryRoot: string;
  let stateRoot: string;
  let cacheRoot: string;
  let logsRoot: string;
  let runtimeRoot: string;

  if (platform === "darwin") {
    const support = join(home, "Library", "Application Support", "ChatGPT Tela");
    binaryRoot = join(support, "bin");
    configRoot = join(support, "config");
    stateRoot = join(support, "state");
    runtimeRoot = join(support, "runtime");
    cacheRoot = join(home, "Library", "Caches", "ChatGPT Tela");
    logsRoot = join(home, "Library", "Logs", "ChatGPT Tela");
  } else if (platform === "win32") {
    const roaming = envPath(env, "APPDATA") ?? join(home, "AppData", "Roaming");
    const local = envPath(env, "LOCALAPPDATA") ?? join(home, "AppData", "Local");
    configRoot = join(roaming, "ChatGPT Tela");
    const localRoot = join(local, "ChatGPT Tela");
    binaryRoot = join(localRoot, "bin");
    stateRoot = join(localRoot, "state");
    runtimeRoot = join(localRoot, "runtime");
    cacheRoot = join(localRoot, "cache");
    logsRoot = join(localRoot, "logs");
  } else {
    binaryRoot = join(envPath(env, "XDG_DATA_HOME") ?? join(home, ".local", "share"), "chatgpt-tela", "bin");
    configRoot = join(envPath(env, "XDG_CONFIG_HOME") ?? join(home, ".config"), "chatgpt-tela");
    stateRoot = join(envPath(env, "XDG_STATE_HOME") ?? join(home, ".local", "state"), "chatgpt-tela");
    cacheRoot = join(envPath(env, "XDG_CACHE_HOME") ?? join(home, ".cache"), "chatgpt-tela");
    logsRoot = join(stateRoot, "logs");
    const xdgRuntime = envPath(env, "XDG_RUNTIME_DIR");
    runtimeRoot = xdgRuntime ? join(xdgRuntime, "chatgpt-tela") : join(stateRoot, "runtime");
  }

  return Object.freeze({
    binaryRoot,
    configRoot,
    stateRoot,
    cacheRoot,
    logsRoot,
    runtimeRoot,
    installManifest: join(stateRoot, "install", "ownership-v1.json"),
    serviceState: (service: TelaServiceId) => join(stateRoot, "services", service),
    serviceRuntime: (service: TelaServiceId) => join(runtimeRoot, "services", service),
  });
}
