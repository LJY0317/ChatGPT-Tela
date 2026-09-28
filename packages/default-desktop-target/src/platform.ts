import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DefaultDesktopCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface DefaultDesktopCommandRunner {
  run(command: string, arguments_: readonly string[]): Promise<DefaultDesktopCommandResult>;
}

export interface DefaultDesktopDiscoveryResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DefaultDesktopDiscoveryRunner {
  run(command: string, arguments_: readonly string[]): DefaultDesktopDiscoveryResult;
}

const systemCommandRunner: DefaultDesktopCommandRunner = Object.freeze({
  async run(command: string, arguments_: readonly string[]) {
    const result = await execFileAsync(command, [...arguments_], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return Object.freeze({ stdout: result.stdout, stderr: result.stderr });
  },
});

const systemDiscoveryRunner: DefaultDesktopDiscoveryRunner = Object.freeze({
  run(command: string, arguments_: readonly string[]) {
    const result = spawnSync(command, [...arguments_], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error && (result.error as NodeJS.ErrnoException).code !== "ENOENT") throw result.error;
    return Object.freeze({
      exitCode: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? (result.error ? String(result.error) : ""),
    });
  },
});

export type DefaultDesktopPlatformKind = "darwin" | "win32" | "linux";

export interface DefaultDesktopInstallation {
  readonly platform: DefaultDesktopPlatformKind;
  readonly chatGptExecutable: string;
  readonly codexExecutable: string;
  readonly codexHome: string;
  readonly userDataDir: string;
  readonly normalQuitSupported: boolean;
}

function macBundleForExecutable(executable: string): string {
  const macos = dirname(executable);
  const contents = dirname(macos);
  const bundle = dirname(contents);
  if (macos !== join(contents, "MacOS") || !bundle.endsWith(".app")) {
    throw new Error("ChatGPT executable is not inside a canonical macOS app bundle");
  }
  return bundle;
}

function commandMatchesExecutable(command: string, executable: string): boolean {
  return command === executable || command.startsWith(`${executable} `);
}

function parseProcessRows(stdout: string, executable: string): readonly number[] {
  const matches: number[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf(" ");
    if (separator <= 0) continue;
    const pid = Number(trimmed.slice(0, separator));
    const command = trimmed.slice(separator + 1).trim();
    if (Number.isSafeInteger(pid) && pid > 0 && commandMatchesExecutable(command, executable)) matches.push(pid);
  }
  return Object.freeze(matches);
}

export async function defaultDesktopProcessIds(
  installation: DefaultDesktopInstallation,
  runner: DefaultDesktopCommandRunner = systemCommandRunner,
): Promise<readonly number[]> {
  if (installation.platform === "darwin" || installation.platform === "linux") {
    const command = installation.platform === "darwin" ? "/bin/ps" : "ps";
    const result = await runner.run(command, ["-axo", "pid=,args="]);
    return parseProcessRows(result.stdout, installation.chatGptExecutable);
  }
  if (installation.platform === "win32") {
    const script = [
      "$p=$args[0];",
      "Get-CimInstance Win32_Process |",
      "Where-Object { $_.ExecutablePath -and [String]::Equals($_.ExecutablePath,$p,[StringComparison]::OrdinalIgnoreCase) } |",
      "ForEach-Object { $_.ProcessId }",
    ].join(" ");
    const result = await runner.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script,
      installation.chatGptExecutable]);
    const matches = result.stdout.split(/\r?\n/)
      .map(line => Number(line.trim()))
      .filter(pid => Number.isSafeInteger(pid) && pid > 0);
    return Object.freeze(matches);
  }
  throw new Error(`default Desktop process inspection is unsupported on ${installation.platform}`);
}

export async function requestDefaultDesktopNormalQuit(
  installation: DefaultDesktopInstallation,
  expectedPid: number,
  options: {
    readonly runner?: DefaultDesktopCommandRunner;
    readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  } = {},
): Promise<void> {
  if (!installation.normalQuitSupported) {
    throw new Error(`normal default Desktop quit is not supported on ${installation.platform}`);
  }
  const runner = options.runner ?? systemCommandRunner;
  const current = await defaultDesktopProcessIds(installation, runner);
  if (current.length !== 1 || current[0] !== expectedPid) {
    throw new Error("ChatGPT Desktop process identity changed before normal quit");
  }
  if (installation.platform === "darwin") {
    const bundle = macBundleForExecutable(installation.chatGptExecutable);
    const escaped = bundle.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    const result = await runner.run("/usr/bin/osascript", ["-e", `tell application "${escaped}" to quit`]);
    if (result.stderr.trim()) {
      throw new Error(`ChatGPT normal quit reported an error: ${result.stderr.trim().slice(0, 240)}`);
    }
    return;
  }
  if (installation.platform === "linux") {
    (options.kill ?? ((pid, signal) => process.kill(pid, signal)))(expectedPid, "SIGTERM");
    return;
  }
  if (installation.platform === "win32") {
    const script = [
      "$pidValue=[int]$args[0]; $path=$args[1];",
      "$p=Get-Process -Id $pidValue -ErrorAction Stop;",
      "if (-not [String]::Equals($p.Path,$path,[StringComparison]::OrdinalIgnoreCase)) { exit 4 };",
      "if (-not $p.CloseMainWindow()) { exit 5 }",
    ].join(" ");
    await runner.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script,
      String(expectedPid), installation.chatGptExecutable]);
    return;
  }
  throw new Error(`normal default Desktop quit is unsupported on ${installation.platform}`);
}

function regularExecutable(path: string, field: string): string {
  if (!isAbsolute(path) || !existsSync(path)) throw new Error(`${field} does not exist: ${path}`);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${field} must be a regular non-symlink file`);
  return realpathSync(path);
}

function installedExecutable(path: string, field: string, allowedResolvedRoots: readonly string[] = []): string {
  if (!isAbsolute(path) || !existsSync(path)) throw new Error(`${field} does not exist: ${path}`);
  const stat = lstatSync(path);
  if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`${field} must be a file or package symlink`);
  const resolved = realpathSync(path);
  const resolvedStat = lstatSync(resolved);
  if (!resolvedStat.isFile() || resolvedStat.isSymbolicLink()) throw new Error(`${field} must resolve to a regular file`);
  if (allowedResolvedRoots.length > 0) {
    const allowed = allowedResolvedRoots
      .filter(root => existsSync(root))
      .some(root => inside(realpathSync(root), resolved));
    if (!allowed) throw new Error(`${field} resolves outside the supported package roots`);
  }
  return resolved;
}

function inside(root: string, candidate: string): boolean {
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate === root || candidate.startsWith(normalizedRoot);
}

function macCodexExecutable(chatGptExecutable: string): string {
  const contents = dirname(dirname(chatGptExecutable));
  const resources = join(contents, "Resources");
  const legacy = join(resources, "codex");
  if (existsSync(legacy)) return regularExecutable(legacy, "bundled Codex executable");

  const packageRoot = join(resources, "codex-cli");
  const manifestPath = join(packageRoot, "codex-package.json");
  if (!existsSync(manifestPath)) {
    throw new Error("official ChatGPT app does not expose a supported bundled Codex executable");
  }
  let manifest: unknown;
  try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown; }
  catch (error) { throw new Error("bundled Codex package manifest is unreadable", { cause: error }); }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("bundled Codex package manifest is invalid");
  }
  const entrypoint = (manifest as { entrypoint?: unknown }).entrypoint;
  if (typeof entrypoint !== "string" || !entrypoint || isAbsolute(entrypoint) || /[\u0000\r\n]/.test(entrypoint)) {
    throw new Error("bundled Codex package manifest has an invalid entrypoint");
  }
  const root = realpathSync(packageRoot);
  const candidate = resolve(packageRoot, entrypoint);
  const resolvedCandidate = regularExecutable(candidate, "bundled Codex package entrypoint");
  if (!inside(root, resolvedCandidate)) throw new Error("bundled Codex package entrypoint escapes its package root");
  return resolvedCandidate;
}

function commandOverride(value: string | undefined, field: string): string | undefined {
  if (!value?.trim()) return undefined;
  if (/[^\S ]|[\u0000\r\n]/.test(value)) throw new Error(`${field} is invalid`);
  return regularExecutable(resolve(value), field);
}

function sha256File(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytes = readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

function existingRegularFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
  return realpathSync(path);
}

function linuxPackageInstallation(input: {
  readonly launcher?: string;
  readonly allowedRoots?: readonly string[];
  readonly codexCandidates?: readonly string[];
} = {}): { readonly chatGptExecutable: string; readonly codexExecutable: string } {
  const launcher = input.launcher ?? "/usr/bin/chatgpt";
  if (!existsSync(launcher)) {
    throw new Error(`official ChatGPT Linux package was not found at ${launcher}; set CHATGPT_EXECUTABLE and CODEX_EXECUTABLE for a nonstandard install`);
  }
  const chatGptExecutable = installedExecutable(launcher, "official ChatGPT executable", input.allowedRoots ?? ["/usr", "/opt"]);
  const codexCandidates = input.codexCandidates ?? [
    "/usr/lib/chatgpt/resources/codex",
    join(dirname(chatGptExecutable), "resources/codex"),
    join(dirname(dirname(chatGptExecutable)), "resources/codex"),
  ];
  const resolvedCodex = codexCandidates
    .map(candidate => existingRegularFile(candidate))
    .find((candidate): candidate is string => candidate !== undefined);
  if (!resolvedCodex) {
    throw new Error("official ChatGPT Linux package does not expose a supported bundled Codex executable; set CODEX_EXECUTABLE explicitly");
  }
  return Object.freeze({ chatGptExecutable, codexExecutable: resolvedCodex });
}

function windowsPackageInstallLocation(runner: DefaultDesktopDiscoveryRunner): string {
  const script = [
    "$p=@(Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue |",
    "Where-Object { $_.Status -eq 'Ok' });",
    "if ($p.Count -ne 1) { exit 4 };",
    "$p[0] | Select-Object Name,PackageFamilyName,InstallLocation,Status | ConvertTo-Json -Compress",
  ].join(" ");
  const result = runner.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
  if (result.exitCode !== 0) {
    throw new Error("official ChatGPT Windows package could not be resolved uniquely; set CHATGPT_EXECUTABLE and CODEX_EXECUTABLE explicitly");
  }
  let value: unknown;
  try { value = JSON.parse(result.stdout) as unknown; }
  catch (error) { throw new Error("ChatGPT Windows package discovery returned invalid JSON", { cause: error }); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ChatGPT Windows package discovery returned an invalid object");
  const item = value as Record<string, unknown>;
  if (item.Name !== "OpenAI.Codex" || item.Status !== "Ok") throw new Error("ChatGPT Windows package identity is invalid");
  if (item.PackageFamilyName !== "OpenAI.Codex_2p2nqsd0c76g0") {
    throw new Error("ChatGPT Windows package family identity is invalid");
  }
  if (typeof item.InstallLocation !== "string" || !isAbsolute(item.InstallLocation)) {
    throw new Error("ChatGPT Windows package install location is invalid");
  }
  return realpathSync(item.InstallLocation);
}

function windowsRelocatedCodex(localAppData: string, packagedCodex: string): string {
  const root = join(localAppData, "OpenAI/Codex/bin");
  if (!existsSync(root)) {
    throw new Error("ChatGPT Windows has not materialized its per-user Codex runtime yet; open ChatGPT once or set CODEX_EXECUTABLE explicitly");
  }
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("ChatGPT Windows Codex runtime root is unsafe or replaced");
  const expectedHash = sha256File(packagedCodex);
  const direct = existingRegularFile(join(root, "codex.exe"));
  if (direct && inside(realpathSync(root), direct) && sha256File(direct) === expectedHash) return direct;
  const matches: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".staging-")) continue;
    const candidate = join(root, entry.name, "codex.exe");
    const resolved = existingRegularFile(candidate);
    if (!resolved) continue;
    if (!inside(realpathSync(root), resolved)) continue;
    if (sha256File(resolved) === expectedHash) matches.push(resolved);
  }
  const unique = [...new Set(matches)];
  if (unique.length !== 1) {
    throw new Error(`ChatGPT Windows per-user Codex runtime is ${unique.length === 0 ? "missing or stale" : "ambiguous"}; open ChatGPT once or set CODEX_EXECUTABLE explicitly`);
  }
  return unique[0]!;
}

export function resolveDefaultDesktopInstallation(input: {
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly discoveryRunner?: DefaultDesktopDiscoveryRunner;
  readonly linuxPackageLayout?: {
    readonly launcher: string;
    readonly allowedRoots: readonly string[];
    readonly codexCandidates: readonly string[];
  };
} = {}): DefaultDesktopInstallation {
  const platform = input.platform ?? process.platform;
  const home = resolve(input.home ?? homedir());
  const environment = input.environment ?? process.env;
  const discoveryRunner = input.discoveryRunner ?? systemDiscoveryRunner;
  const chatOverride = commandOverride(environment.CHATGPT_EXECUTABLE, "CHATGPT_EXECUTABLE");
  const codexOverride = commandOverride(environment.CODEX_EXECUTABLE, "CODEX_EXECUTABLE");

  if (platform === "darwin") {
    const chatGptExecutable = chatOverride
      ?? regularExecutable("/Applications/ChatGPT.app/Contents/MacOS/ChatGPT", "official ChatGPT executable");
    const codexExecutable = codexOverride ?? macCodexExecutable(chatGptExecutable);
    return Object.freeze({
      platform: "darwin",
      chatGptExecutable,
      codexExecutable,
      codexHome: join(home, ".codex"),
      userDataDir: join(home, "Library/Application Support/Codex"),
      normalQuitSupported: true,
    });
  }

  if (platform === "win32") {
    const localAppData = environment.LOCALAPPDATA
      ? resolve(environment.LOCALAPPDATA)
      : join(home, "AppData/Local");
    let chatGptExecutable = chatOverride;
    let codexExecutable = codexOverride;
    if (!chatGptExecutable || !codexExecutable) {
      const packageRoot = windowsPackageInstallLocation(discoveryRunner);
      chatGptExecutable ??= regularExecutable(join(packageRoot, "app/ChatGPT.exe"), "official ChatGPT executable");
      if (!codexExecutable) {
        const packagedCodex = regularExecutable(join(packageRoot, "app/resources/codex.exe"), "bundled Codex executable");
        codexExecutable = windowsRelocatedCodex(localAppData, packagedCodex);
      }
    }
    return Object.freeze({
      platform: "win32",
      chatGptExecutable,
      codexExecutable,
      codexHome: join(home, ".codex"),
      userDataDir: join(localAppData, "Codex"),
      normalQuitSupported: true,
    });
  }

  if (platform === "linux") {
    const configHome = environment.XDG_CONFIG_HOME
      ? resolve(environment.XDG_CONFIG_HOME)
      : join(home, ".config");
    let packaged: { readonly chatGptExecutable: string; readonly codexExecutable: string } | undefined;
    if (!chatOverride || !codexOverride) packaged = linuxPackageInstallation(input.linuxPackageLayout ?? {});
    return Object.freeze({
      platform: "linux",
      chatGptExecutable: chatOverride ?? packaged!.chatGptExecutable,
      codexExecutable: codexOverride ?? packaged!.codexExecutable,
      codexHome: join(home, ".codex"),
      userDataDir: join(configHome, "Codex"),
      normalQuitSupported: true,
    });
  }

  throw new Error(`built-in default Desktop adapter is unsupported on ${platform}`);
}
