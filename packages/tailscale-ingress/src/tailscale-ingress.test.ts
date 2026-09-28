import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOwnershipManifest } from "@chatgpt-tela/product-lifecycle";
import {
  createTailscaleFunnelLease,
  inspectTailscaleBackendHealth,
  inspectTailscaleFunnelLease,
  planAcquireTailscaleFunnelLease,
  planReleaseTailscaleFunnelLease,
  tailscaleFunnelOwnedResource,
  TailscaleFunnelExposure,
  TailscaleFunnelLeaseManager,
  TailscaleFunnelOwnershipObserver,
  tailscaleDiagnosisDetail,
  type TailscaleCommandResult,
  type TailscaleCommandRunner,
} from "./index";

const status = {
  TCP: { "443": { HTTPS: true } },
  Web: {
    "machine.tail.example.ts.net:443": {
      Handlers: {
        "/": { Proxy: "http://127.0.0.1:7676" },
        "/tela": { Proxy: "http://127.0.0.1:19000/" },
      },
    },
  },
  AllowFunnel: { "machine.tail.example.ts.net:443": true },
};

class FakeTailscaleRunner implements TailscaleCommandRunner {
  readonly host = "machine.tail.example.ts.net";
  readonly calls: string[][] = [];
  readonly handlers = new Map<string, string>([["/", "http://127.0.0.1:7676"]]);
  failAfterMutation = false;

  status() {
    return {
      TCP: { "443": { HTTPS: true } },
      Web: {
        [`${this.host}:443`]: {
          Handlers: Object.fromEntries([...this.handlers].map(([path, target]) => [path, { Proxy: target }])),
        },
      },
      AllowFunnel: { [`${this.host}:443`]: true },
    };
  }

  async run(arguments_: readonly string[]): Promise<TailscaleCommandResult> {
    this.calls.push([...arguments_]);
    if (arguments_.join(" ") === "status --json") {
      return {
        stdout: JSON.stringify({ BackendState: "Running", Self: { Online: true } }),
        stderr: "",
      };
    }
    if (arguments_.join(" ") === "serve status --json") {
      return { stdout: JSON.stringify(this.status()), stderr: "" };
    }
    if (arguments_[0] !== "funnel") throw new Error("unexpected fake Tailscale command");
    const pathArg = arguments_.find(argument => argument.startsWith("--set-path="));
    if (!pathArg) throw new Error("missing fake Funnel path");
    const publicPath = pathArg.slice("--set-path=".length);
    const tail = arguments_[arguments_.length - 1];
    if (tail === "off") this.handlers.delete(publicPath);
    else if (tail) this.handlers.set(publicPath, new URL(tail).href.replace(/\/$/, tail.endsWith("/") ? "/" : ""));
    if (this.failAfterMutation) {
      this.failAfterMutation = false;
      throw new Error("simulated Tailscale CLI post-mutation failure");
    }
    return { stdout: "", stderr: "" };
  }
}

describe("Tailscale Funnel ownership lease", () => {
  test("separates local Tailscale backend health from Funnel route ownership", () => {
    expect(inspectTailscaleBackendHealth({
      BackendState: "Running",
      Self: { Online: true },
    })).toEqual({ state: "ready", backendState: "Running" });
    expect(inspectTailscaleBackendHealth({
      BackendState: "Running",
      Self: { Online: false },
    })).toEqual({ state: "offline", backendState: "Running" });
    expect(inspectTailscaleBackendHealth({
      BackendState: "NeedsLogin",
      Self: { Online: false },
    })).toEqual({ state: "needs-login", backendState: "NeedsLogin" });
    expect(inspectTailscaleBackendHealth({
      BackendState: "Stopped",
      Self: { Online: false },
    })).toEqual({ state: "stopped", backendState: "Stopped" });
  });

  test("diagnosis reports Tailscale-off as the root cause before inspecting Funnel state", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-tailscale-diagnose-off-"));
    const calls: string[][] = [];
    const runner: TailscaleCommandRunner = {
      async run(arguments_) {
        calls.push([...arguments_]);
        if (arguments_.join(" ") === "status --json") {
          const error = new Error("failed to connect to local Tailscale service; is Tailscale running?") as Error & { stderr?: string };
          error.stderr = "failed to connect to local Tailscale service";
          throw error;
        }
        throw new Error("Funnel status must not be inspected while the backend is unreachable");
      },
    };
    const manager = new TailscaleFunnelLeaseManager({
      runner,
      manifestPath: join(root, "ownership-v1.json"),
      installId: "diagnose-off",
      productVersion: "0.0.0",
    });
    const lease = createTailscaleFunnelLease({
      publicUrl: "https://machine.tail.example.ts.net/tela",
      localTarget: "http://127.0.0.1:19000/mcp",
    });
    try {
      const diagnosis = await manager.diagnose(lease);
      expect(diagnosis).toMatchObject({
        availability: "unavailable",
        cause: "tailscale-backend-unreachable",
        backend: { state: "backend-unreachable" },
      });
      expect(calls).toEqual([["status", "--json"]]);
      expect(tailscaleDiagnosisDetail(diagnosis.cause)).toContain("open Tailscale");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("diagnosis distinguishes online Tailscale from a missing Funnel path", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-tailscale-diagnose-route-"));
    const runner: TailscaleCommandRunner = {
      async run(arguments_) {
        if (arguments_.join(" ") === "status --json") {
          return { stdout: JSON.stringify({ BackendState: "Running", Self: { Online: true } }), stderr: "" };
        }
        if (arguments_.join(" ") === "serve status --json") {
          return {
            stdout: JSON.stringify({
              Web: { "machine.tail.example.ts.net:443": { Handlers: {} } },
              AllowFunnel: { "machine.tail.example.ts.net:443": true },
            }),
            stderr: "",
          };
        }
        throw new Error("unexpected fake command");
      },
    };
    const manager = new TailscaleFunnelLeaseManager({
      runner,
      manifestPath: join(root, "ownership-v1.json"),
      installId: "diagnose-route",
      productVersion: "0.0.0",
    });
    const lease = createTailscaleFunnelLease({
      publicUrl: "https://machine.tail.example.ts.net/tela",
      localTarget: "http://127.0.0.1:19000/mcp",
    });
    try {
      expect(await manager.diagnose(lease)).toMatchObject({
        availability: "unavailable",
        cause: "funnel-route-absent",
        backend: { state: "ready" },
        route: { state: "absent" },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recognizes only the exact path and loopback target as owned", () => {
    const lease = createTailscaleFunnelLease({
      publicUrl: "https://machine.tail.example.ts.net/tela",
      localTarget: "http://127.0.0.1:19000/",
    });
    expect(inspectTailscaleFunnelLease(lease, status)).toEqual({
      state: "owned",
      currentTarget: "http://127.0.0.1:19000/",
    });
    expect(lease.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  test("release removes only the owned path and never resets unrelated Funnel routes", () => {
    const lease = createTailscaleFunnelLease({
      publicUrl: "https://machine.tail.example.ts.net/tela",
      localTarget: "http://127.0.0.1:19000/",
    });
    const plan = planReleaseTailscaleFunnelLease(lease, inspectTailscaleFunnelLease(lease, status));
    expect(plan).toEqual({
      action: "apply",
      arguments: ["funnel", "--https=443", "--set-path=/tela", "off"],
      reason: "current Funnel path still matches Tela ownership",
    });
    expect(JSON.stringify(plan)).not.toContain("reset");
  });

  test("drift is preserved rather than overwritten or removed", () => {
    const lease = createTailscaleFunnelLease({
      publicUrl: "https://machine.tail.example.ts.net/tela",
      localTarget: "http://127.0.0.1:19001/",
    });
    const observed = inspectTailscaleFunnelLease(lease, status);
    expect(observed.state).toBe("drift");
    expect(planAcquireTailscaleFunnelLease(lease, observed).action).toBe("preserve");
    expect(planReleaseTailscaleFunnelLease(lease, observed).action).toBe("preserve");
  });

  test("acquire creates only the selected path mapping when absent", () => {
    const lease = createTailscaleFunnelLease({
      publicUrl: "https://machine.tail.example.ts.net/tela",
      localTarget: "http://127.0.0.1:19002/",
    });
    const absent = inspectTailscaleFunnelLease(lease, {
      Web: { "machine.tail.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:7676" } } } },
      AllowFunnel: { "machine.tail.example.ts.net:443": true },
    });
    expect(planAcquireTailscaleFunnelLease(lease, absent)).toEqual({
      action: "apply",
      arguments: ["funnel", "--bg", "--https=443", "--set-path=/tela", "http://127.0.0.1:19002/"],
      reason: "Tela Funnel path is absent",
    });
  });

  test("managed acquire and release mutate only one exact path and mirror manifest ownership", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-tailscale-owned-"));
    const manifestPath = join(root, "ownership-v1.json");
    const runner = new FakeTailscaleRunner();
    const manager = new TailscaleFunnelLeaseManager({
      runner,
      manifestPath,
      installId: "tailscale-install-1",
      productVersion: "0.0.0",
    });
    const lease = createTailscaleFunnelLease({
      publicUrl: `https://${runner.host}/tela`,
      localTarget: "http://127.0.0.1:19000/mcp",
    });
    try {
      const acquired = await manager.acquire(lease);
      expect(acquired.state).toBe("acquired");
      expect(runner.handlers.get("/")).toBe("http://127.0.0.1:7676");
      expect(runner.handlers.get("/tela")).toBe("http://127.0.0.1:19000/mcp");
      expect(readOwnershipManifest(manifestPath)?.resources).toContainEqual(tailscaleFunnelOwnedResource(lease));

      const manifest = readOwnershipManifest(manifestPath)!;
      const observer = new TailscaleFunnelOwnershipObserver(manager);
      expect(await observer.observe(manifest.resources[0]!, manifest)).toBe("owned");

      const released = await manager.release(lease);
      expect(released.state).toBe("released");
      expect(runner.handlers.has("/tela")).toBe(false);
      expect(runner.handlers.get("/")).toBe("http://127.0.0.1:7676");
      expect(readOwnershipManifest(manifestPath)?.resources).toEqual([]);
      expect(runner.calls.some(call => call.includes("reset"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a matching pre-existing route is usable but never silently adopted or removed", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-tailscale-external-"));
    const manifestPath = join(root, "ownership-v1.json");
    const runner = new FakeTailscaleRunner();
    runner.handlers.set("/tela", "http://127.0.0.1:19000/mcp");
    const manager = new TailscaleFunnelLeaseManager({
      runner,
      manifestPath,
      installId: "tailscale-install-external",
      productVersion: "0.0.0",
    });
    const lease = createTailscaleFunnelLease({
      publicUrl: `https://${runner.host}/tela`,
      localTarget: "http://127.0.0.1:19000/mcp",
    });
    try {
      expect((await manager.acquire(lease)).state).toBe("external-match");
      expect(readOwnershipManifest(manifestPath)).toBeUndefined();
      expect((await manager.release(lease)).state).toBe("preserved");
      expect(runner.handlers.get("/tela")).toBe("http://127.0.0.1:19000/mcp");
      expect(runner.calls.filter(call => call[0] === "funnel")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("post-mutation CLI errors use verified exact state instead of duplicating the command", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-tailscale-post-error-"));
    const runner = new FakeTailscaleRunner();
    const manager = new TailscaleFunnelLeaseManager({
      runner,
      manifestPath: join(root, "ownership-v1.json"),
      installId: "tailscale-install-post-error",
      productVersion: "0.0.0",
    });
    const lease = createTailscaleFunnelLease({
      publicUrl: `https://${runner.host}/tela`,
      localTarget: "http://127.0.0.1:19000/mcp",
    });
    try {
      runner.failAfterMutation = true;
      expect((await manager.acquire(lease)).state).toBe("acquired");
      expect(runner.calls.filter(call => call[0] === "funnel")).toHaveLength(1);
      runner.failAfterMutation = true;
      expect((await manager.release(lease)).state).toBe("released");
      expect(runner.calls.filter(call => call[0] === "funnel")).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("startup verification failure rolls back only a route acquired by that prepare attempt", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-tailscale-exposure-"));
    const runner = new FakeTailscaleRunner();
    const manager = new TailscaleFunnelLeaseManager({
      runner,
      manifestPath: join(root, "ownership-v1.json"),
      installId: "tailscale-install-exposure",
      productVersion: "0.0.0",
    });
    const exposure = new TailscaleFunnelExposure({
      publicUrl: `https://${runner.host}/tela`,
      localTarget: "http://127.0.0.1:19000/mcp",
      authentication: { kind: "none" },
      manager,
      probe: async () => ({ ready: false, detail: "simulated public probe failure" }),
    });
    try {
      const endpoint = await exposure.prepare();
      expect((await exposure.verify(endpoint)).ready).toBe(false);
      await exposure.stop();
      expect(runner.handlers.has("/tela")).toBe(false);
      expect(readOwnershipManifest(join(root, "ownership-v1.json"))?.resources).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("managed exposure reports Tailscale-off before attempting Funnel mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-tailscale-exposure-off-"));
    const calls: string[][] = [];
    const runner: TailscaleCommandRunner = {
      async run(arguments_) {
        calls.push([...arguments_]);
        if (arguments_.join(" ") === "status --json") {
          throw new Error("failed to connect to local Tailscale service; is Tailscale running?");
        }
        throw new Error("unexpected command after backend preflight");
      },
    };
    const manager = new TailscaleFunnelLeaseManager({
      runner,
      manifestPath: join(root, "ownership-v1.json"),
      installId: "tailscale-install-exposure-off",
      productVersion: "0.0.0",
    });
    const exposure = new TailscaleFunnelExposure({
      publicUrl: "https://machine.tail.example.ts.net/tela",
      localTarget: "http://127.0.0.1:19000/mcp",
      authentication: { kind: "none" },
      manager,
      probe: async () => ({ ready: true }),
    });
    try {
      await expect(exposure.prepare()).rejects.toThrow("open Tailscale");
      expect(calls).toEqual([["status", "--json"]]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("verified exposure keeps its install-owned route across ordinary Gateway shutdown", async () => {
    const root = mkdtempSync(join(tmpdir(), "tela-tailscale-exposure-ready-"));
    const runner = new FakeTailscaleRunner();
    const manifestPath = join(root, "ownership-v1.json");
    const manager = new TailscaleFunnelLeaseManager({
      runner,
      manifestPath,
      installId: "tailscale-install-exposure-ready",
      productVersion: "0.0.0",
    });
    const exposure = new TailscaleFunnelExposure({
      publicUrl: `https://${runner.host}/tela/`,
      localTarget: "http://127.0.0.1:19000/mcp",
      authentication: { kind: "none" },
      manager,
      probe: async endpoint => ({ ready: endpoint.url.pathname === "/tela" }),
    });
    try {
      const endpoint = await exposure.prepare();
      expect(endpoint.url.pathname).toBe("/tela");
      expect((await exposure.verify(endpoint)).ready).toBe(true);
      await exposure.stop();
      expect(runner.handlers.get("/tela")).toBe("http://127.0.0.1:19000/mcp");
      expect(readOwnershipManifest(manifestPath)?.resources).toHaveLength(1);
      expect(runner.calls.filter(call => call.at(-1) === "off")).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
