import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDefaultDesktopLaunch,
  defaultDesktopProcessIds,
  requestDefaultDesktopNormalQuit,
  resolveDefaultDesktopInstallation,
  type DefaultDesktopCommandRunner,
  type DefaultDesktopDiscoveryRunner,
  type DefaultDesktopInstallation,
} from "./platform";

function executable(path: string): void {
  writeFileSync(path, "fixture", { mode: 0o700 });
  chmodSync(path, 0o700);
}

describe("built-in default Desktop installation resolver", () => {
  test("derives the normal one-account macOS roots without Multi-Profile state", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-default-desktop-mac-"));
    const app = join(root, "ChatGPT.app");
    const chat = join(app, "Contents/MacOS/ChatGPT");
    const resources = join(app, "Contents/Resources");
    mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
    mkdirSync(join(resources, "codex-cli/bin"), { recursive: true });
    executable(chat);
    const codex = join(resources, "codex-cli/bin/codex");
    executable(codex);
    writeFileSync(join(resources, "codex-cli/codex-package.json"), JSON.stringify({ entrypoint: "bin/codex" }));
    try {
      expect(resolveDefaultDesktopInstallation({
        platform: "darwin",
        home: join(root, "home"),
        environment: { CHATGPT_EXECUTABLE: chat },
      })).toEqual({
        platform: "darwin",
        chatGptExecutable: realpathSync(chat),
        codexExecutable: realpathSync(codex),
        codexHome: join(root, "home/.codex"),
        userDataDir: join(root, "home/Library/Application Support/Codex"),
        normalQuitSupported: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps explicit Windows/Linux executable overrides as the highest-authority path", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-default-desktop-portable-"));
    const chat = join(root, "ChatGPT");
    const codex = join(root, "codex");
    executable(chat);
    executable(codex);
    try {
      expect(resolveDefaultDesktopInstallation({
        platform: "linux",
        home: join(root, "home"),
        environment: { CHATGPT_EXECUTABLE: chat, CODEX_EXECUTABLE: codex },
      })).toMatchObject({
        platform: "linux",
        chatGptExecutable: realpathSync(chat),
        codexExecutable: realpathSync(codex),
        normalQuitSupported: true,
      });
      expect(() => resolveDefaultDesktopInstallation({
        platform: "win32",
        home: join(root, "home"),
        environment: {},
        discoveryRunner: { run: () => ({ exitCode: 4, stdout: "", stderr: "not installed" }) },
      })).toThrow("could not be resolved uniquely");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("discovers the official Linux package from the canonical launcher and bundled Codex", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-default-desktop-linux-package-"));
    const usr = join(root, "usr");
    const actualChat = join(usr, "lib/chatgpt/chatgpt");
    const launcher = join(usr, "bin/chatgpt");
    const codex = join(usr, "lib/chatgpt/resources/codex");
    mkdirSync(join(usr, "bin"), { recursive: true });
    mkdirSync(join(usr, "lib/chatgpt/resources"), { recursive: true });
    executable(actualChat);
    executable(codex);
    symlinkSync(actualChat, launcher);
    try {
      expect(resolveDefaultDesktopInstallation({
        platform: "linux",
        home: join(root, "home"),
        environment: {},
        linuxPackageLayout: {
          launcher,
          allowedRoots: [usr],
          codexCandidates: [codex],
        },
      })).toEqual({
        platform: "linux",
        chatGptExecutable: realpathSync(actualChat),
        codexExecutable: realpathSync(codex),
        codexHome: join(root, "home/.codex"),
        userDataDir: join(root, "home/.config/Codex"),
        normalQuitSupported: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("discovers the official Windows package and selects only the current matching relocated Codex runtime", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-default-desktop-windows-package-"));
    const packageRoot = join(root, "WindowsApps/OpenAI.Codex_current");
    const chat = join(packageRoot, "app/ChatGPT.exe");
    const packagedCodex = join(packageRoot, "app/resources/codex.exe");
    const localAppData = join(root, "LocalAppData");
    const currentCodex = join(localAppData, "OpenAI/Codex/bin/current/codex.exe");
    const staleCodex = join(localAppData, "OpenAI/Codex/bin/stale/codex.exe");
    const stagedCodex = join(localAppData, "OpenAI/Codex/bin/.staging-current/codex.exe");
    mkdirSync(join(packageRoot, "app/resources"), { recursive: true });
    mkdirSync(join(localAppData, "OpenAI/Codex/bin/current"), { recursive: true });
    mkdirSync(join(localAppData, "OpenAI/Codex/bin/stale"), { recursive: true });
    mkdirSync(join(localAppData, "OpenAI/Codex/bin/.staging-current"), { recursive: true });
    executable(chat);
    writeFileSync(packagedCodex, "current-codex", { mode: 0o700 });
    writeFileSync(currentCodex, "current-codex", { mode: 0o700 });
    writeFileSync(staleCodex, "stale-codex", { mode: 0o700 });
    writeFileSync(stagedCodex, "current-codex", { mode: 0o700 });
    const runner: DefaultDesktopDiscoveryRunner = {
      run(command, arguments_) {
        expect(command).toBe("powershell.exe");
        expect(arguments_).toContain("-NonInteractive");
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            Name: "OpenAI.Codex",
            PackageFamilyName: "OpenAI.Codex_2p2nqsd0c76g0",
            InstallLocation: packageRoot,
            Status: "Ok",
          }),
          stderr: "",
        };
      },
    };
    try {
      expect(resolveDefaultDesktopInstallation({
        platform: "win32",
        home: join(root, "home"),
        environment: { LOCALAPPDATA: localAppData },
        discoveryRunner: runner,
      })).toEqual({
        platform: "win32",
        chatGptExecutable: realpathSync(chat),
        codexExecutable: realpathSync(currentCodex),
        codexHome: join(root, "home/.codex"),
        userDataDir: join(localAppData, "Codex"),
        normalQuitSupported: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Windows package discovery rejects a foreign package family before executable selection", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-default-desktop-windows-foreign-"));
    const packageRoot = join(root, "package");
    mkdirSync(packageRoot);
    try {
      expect(() => resolveDefaultDesktopInstallation({
        platform: "win32",
        home: join(root, "home"),
        environment: { LOCALAPPDATA: join(root, "local") },
        discoveryRunner: {
          run: () => ({
            exitCode: 0,
            stdout: JSON.stringify({ Name: "OpenAI.Codex", PackageFamilyName: "OpenAI.Codex_foreign",
              InstallLocation: packageRoot, Status: "Ok" }),
            stderr: "",
          }),
        },
      })).toThrow("family identity");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Windows package discovery fails closed when multiple relocated Codex runtimes match the current package", () => {
    const root = mkdtempSync(join(tmpdir(), "tela-default-desktop-windows-ambiguous-"));
    const packageRoot = join(root, "WindowsApps/OpenAI.Codex_current");
    const chat = join(packageRoot, "app/ChatGPT.exe");
    const packagedCodex = join(packageRoot, "app/resources/codex.exe");
    const localAppData = join(root, "LocalAppData");
    const first = join(localAppData, "OpenAI/Codex/bin/a/codex.exe");
    const second = join(localAppData, "OpenAI/Codex/bin/b/codex.exe");
    mkdirSync(join(packageRoot, "app/resources"), { recursive: true });
    mkdirSync(join(localAppData, "OpenAI/Codex/bin/a"), { recursive: true });
    mkdirSync(join(localAppData, "OpenAI/Codex/bin/b"), { recursive: true });
    executable(chat);
    for (const path of [packagedCodex, first, second]) writeFileSync(path, "same-codex", { mode: 0o700 });
    try {
      expect(() => resolveDefaultDesktopInstallation({
        platform: "win32",
        home: join(root, "home"),
        environment: { LOCALAPPDATA: localAppData },
        discoveryRunner: {
          run: () => ({
            exitCode: 0,
            stdout: JSON.stringify({ Name: "OpenAI.Codex", PackageFamilyName: "OpenAI.Codex_2p2nqsd0c76g0",
              InstallLocation: packageRoot, Status: "Ok" }),
            stderr: "",
          }),
        },
      })).toThrow("ambiguous");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("macOS normal quit addresses only the proved Desktop process id", async () => {
    const installation: DefaultDesktopInstallation = {
      platform: "darwin",
      chatGptExecutable: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      codexExecutable: "/Applications/ChatGPT.app/Contents/Resources/codex",
      codexHome: "/tmp/fixture-codex",
      userDataDir: "/tmp/fixture-data",
      normalQuitSupported: true,
    };
    const calls: Array<{ command: string; arguments_: readonly string[] }> = [];
    const runner: DefaultDesktopCommandRunner = {
      async run(command, arguments_) {
        calls.push({ command, arguments_ });
        return { stdout: command === "/bin/ps" ? `301 ${installation.chatGptExecutable}\n` : "requested\n", stderr: "" };
      },
    };
    await requestDefaultDesktopNormalQuit(installation, 301, { runner });
    expect(calls.at(-1)?.command).toBe("/usr/bin/osascript");
    expect(calls.at(-1)?.arguments_.slice(0, 3)).toEqual(["-l", "JavaScript", "-e"]);
    expect(calls.at(-1)?.arguments_.at(-1)).toContain("runningApplicationWithProcessIdentifier(301)");
    expect(calls.at(-1)?.arguments_.at(-1)).toContain("const requested = app.terminate;");
    expect(calls.at(-1)?.arguments_.at(-1)).not.toContain("app.terminate()");
    expect(calls.at(-1)?.arguments_.at(-1)).not.toContain("tell application");
  });

  test.skipIf(process.platform !== "darwin")("real JXA bridge sends exactly one zero-argument request and preserves BOOL refusal", async () => {
    // Capture the actual production script through a fake process inventory.
    // Substitute a private synthetic NSObject; never target any running app.
    const installation: DefaultDesktopInstallation = {
      platform:"darwin",chatGptExecutable:"/fixture/chat",codexExecutable:"/fixture/codex",
      codexHome:"/fixture/home",userDataDir:"/fixture/data",normalQuitSupported:true,
    };
    let script="";
    await requestDefaultDesktopNormalQuit(installation,301,{runner:{async run(command,args){
      if(command==="/bin/ps")return{stdout:"301 /fixture/chat\n",stderr:""};
      script=args.at(-1)!;return{stdout:"requested\n",stderr:""};
    }}});
    const target="$.NSRunningApplication.runningApplicationWithProcessIdentifier(301)";
    expect(script.split(target)).toHaveLength(2);
    for(const accepted of [true,false]){
      const fixture=`ObjC.import('Foundation'); var count=0; ObjC.registerSubclass({name:'TelaNormalQuitFixture',superclass:'NSObject',methods:{terminate:{types:['bool',[]],implementation:function(){count++;return ${accepted};}}}}); var fixture=$.TelaNormalQuitFixture.alloc.init; `;
      const safe=script.replace(target,"fixture");
      expect(safe).not.toContain("NSRunningApplication");
      const child=Bun.spawn(["/usr/bin/osascript","-l","JavaScript","-e",fixture+`var ack=(function(){${safe.replace('requested ? "requested" : "refused";', 'return requested ? "requested" : "refused";')}})(); JSON.stringify({ack:ack,count:count});`],{stdout:"pipe",stderr:"pipe"});
      const stdout=await new Response(child.stdout).text(),stderr=await new Response(child.stderr).text();
      expect(await child.exited).toBe(0);expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toEqual({ack:accepted?"requested":"refused",count:1});
    }
  });

  test("macOS normal quit refuses an unacknowledged termination and never falls back to a kill", async () => {
    const installation: DefaultDesktopInstallation = {
      platform: "darwin", chatGptExecutable: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      codexExecutable: "/fixture/codex", codexHome: "/fixture/home", userDataDir: "/fixture/data", normalQuitSupported: true,
    };
    await expect(requestDefaultDesktopNormalQuit(installation, 301, {
      runner: { async run(command) {
        return { stdout: command === "/bin/ps" ? `301 ${installation.chatGptExecutable}\n` : "refused\n", stderr: "" };
      } },
      kill() { throw new Error("must not signal Desktop"); },
    })).rejects.toMatchObject({ reasonClass: "request_rejected" });
  });

  test("Linux process lifecycle re-proves the exact executable before graceful SIGTERM", async () => {
    const installation: DefaultDesktopInstallation = {
      platform: "linux",
      chatGptExecutable: "/opt/chatgpt/ChatGPT",
      codexExecutable: "/opt/chatgpt/codex",
      codexHome: "/home/test/.codex",
      userDataDir: "/home/test/.config/Codex",
      normalQuitSupported: true,
    };
    const calls: Array<{ command: string; arguments_: readonly string[] }> = [];
    const runner: DefaultDesktopCommandRunner = {
      async run(command, arguments_) {
        calls.push({ command, arguments_ });
        return {
          stdout: "  301 /opt/chatgpt/ChatGPT --user-data-dir=/home/test/.config/Codex\n  999 /other/app\n",
          stderr: "",
        };
      },
    };
    expect(await defaultDesktopProcessIds(installation, runner)).toEqual([301]);
    const killed: Array<[number, NodeJS.Signals]> = [];
    await requestDefaultDesktopNormalQuit(installation, 301, {
      runner,
      kill(pid, signal) { killed.push([pid, signal]); },
    });
    expect(killed).toEqual([[301, "SIGTERM"]]);
    expect(calls.every(call => call.command === "ps")).toBe(true);
  });

  test("Windows process lifecycle uses exact executable identity and CloseMainWindow only", async () => {
    const installation: DefaultDesktopInstallation = {
      platform: "win32",
      chatGptExecutable: "C:\\Program Files\\ChatGPT\\ChatGPT.exe",
      codexExecutable: "C:\\Program Files\\ChatGPT\\codex.exe",
      codexHome: "C:\\Users\\test\\.codex",
      userDataDir: "C:\\Users\\test\\AppData\\Local\\Codex",
      normalQuitSupported: true,
    };
    const calls: Array<{ command: string; arguments_: readonly string[] }> = [];
    const runner: DefaultDesktopCommandRunner = {
      async run(command, arguments_) {
        calls.push({ command, arguments_ });
        const script = arguments_[3] ?? "";
        if (script.includes("Get-CimInstance")) return { stdout: "4242\r\n", stderr: "" };
        if (script.includes("CloseMainWindow")) return { stdout: "", stderr: "" };
        throw new Error("unexpected PowerShell fixture command");
      },
    };
    expect(await defaultDesktopProcessIds(installation, runner)).toEqual([4242]);
    await requestDefaultDesktopNormalQuit(installation, 4242, { runner });
    expect(calls).toHaveLength(3);
    expect(calls.every(call => call.command === "powershell.exe")).toBe(true);
    expect(calls.at(-1)?.arguments_.join(" ")).toContain("CloseMainWindow");
    expect(calls.at(-1)?.arguments_).toContain("4242");
    expect(calls.at(-1)?.arguments_).toContain(installation.chatGptExecutable);
  });

  test("normal quit refuses a changed process identity on every platform", async () => {
    const installation: DefaultDesktopInstallation = {
      platform: "linux",
      chatGptExecutable: "/opt/chatgpt/ChatGPT",
      codexExecutable: "/opt/chatgpt/codex",
      codexHome: "/home/test/.codex",
      userDataDir: "/home/test/.config/Codex",
      normalQuitSupported: true,
    };
    const runner: DefaultDesktopCommandRunner = {
      async run() { return { stdout: "302 /opt/chatgpt/ChatGPT\n", stderr: "" }; },
    };
    let killed = false;
    await expect(requestDefaultDesktopNormalQuit(installation, 301, {
      runner,
      kill() { killed = true; },
    })).rejects.toThrow("identity changed");
    expect(killed).toBe(false);
  });
});

test("Desktop launch owns one profile/transport contract across platform launchers", () => {
  const installation = { platform: "darwin" as const, chatGptExecutable: "/fixture/ChatGPT.app/Contents/MacOS/ChatGPT", codexExecutable: "/fixture/codex", codexHome: "/fixture/.codex", userDataDir: "/fixture/data with spaces", normalQuitSupported: true };
  const endpoint = "ws://127.0.0.1:18741/";
  const base = { INHERITED_SECRET: "fixture-secret", CODEX_HOME: "/wrong-profile" };
  const mac = createDefaultDesktopLaunch(installation, endpoint, base);
  expect(mac.command).toBe("/usr/bin/open");
  expect(mac.arguments).toEqual(["-W", "-n",
    "--env", "CODEX_HOME=/fixture/.codex",
    "--env", "CODEX_ELECTRON_USER_DATA_PATH=/fixture/data with spaces",
    "--env", "CODEX_APP_SERVER_WS_URL=ws://127.0.0.1:18741/",
    "-a", "/fixture/ChatGPT.app", "--args", "--user-data-dir=/fixture/data with spaces"]);
  expect(mac.arguments.join(" ")).not.toContain("fixture-secret");
  expect(mac.environment.CODEX_HOME).toBe(installation.codexHome);
  for (const platform of ["linux", "win32"] as const) {
    const direct = createDefaultDesktopLaunch({ ...installation, platform }, endpoint, base);
    expect(direct.command).toBe(installation.chatGptExecutable);
    expect(direct.arguments).toEqual(["--user-data-dir=/fixture/data with spaces"]);
    expect(direct.environment).toEqual(mac.environment);
  }
  expect(() => createDefaultDesktopLaunch({ ...installation, chatGptExecutable: "/fixture/non-app" }, endpoint)).toThrow("application bundle");
  for (const invalid of ["", "ws://example.com:1234/", "ws://user:password@127.0.0.1:1234/", "ws://127.0.0.1:1234/?token=private", "http://127.0.0.1:1234/"]) {
    expect(() => createDefaultDesktopLaunch(installation, invalid)).toThrow("owned loopback");
  }
});
