import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
type Role = "desktop" | "renderer" | "gpu" | "desktop-service" | "tela" | "compositor";
interface ProcessObservation { pid: number; parent: number; cpuMs: number; rssKiB: number; executable: string; gpu?: boolean }

/** Only the public Chromium child-process type is retained from transient process metadata. */
export function gpuProcessIds(text: string): Set<number> {
  return new Set(text.split("\n").flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    return match && /(?:^|\s)--type=gpu-process(?:\s|$)/.test(match[2]!) ? [Number(match[1])] : [];
  }));
}

export function parseProcessObservation(text: string): ProcessObservation[] {
  return text.split("\n").flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+([\d:.]+)\s+(\d+)\s+(.+)$/);
    if (!match) return [];
    const parts = match[3]!.split(":").map(Number);
    if (parts.length < 2 || parts.length > 3 || parts.some(value => !Number.isFinite(value))) return [];
    const seconds = parts.reduce((total, value) => total * 60 + value, 0);
    return [{ pid: Number(match[1]), parent: Number(match[2]), cpuMs: seconds * 1000,
      rssKiB: Number(match[4]), executable: match[5]! }];
  });
}

// External executable conventions stay at this diagnostic adapter boundary.
function roles(processes: readonly ProcessObservation[]): Map<number, Role> {
  const result = new Map<number, Role>();
  const desktops = new Set(processes.filter(p => p.executable.endsWith("/ChatGPT.app/Contents/MacOS/ChatGPT")).map(p => p.pid));
  for (const p of processes) {
    if (p.executable.endsWith("/WindowServer")) result.set(p.pid, "compositor");
    else if (desktops.has(p.pid)) result.set(p.pid, "desktop");
    else if (desktops.has(p.parent) && p.gpu === true) result.set(p.pid, "gpu");
    else if (desktops.has(p.parent) && p.executable.endsWith("/Codex (Renderer)")) result.set(p.pid, "renderer");
    else if (desktops.has(p.parent) && p.executable.endsWith("/Codex (Service)")) result.set(p.pid, "desktop-service");
    else if (p.executable.includes("/ChatGPT Tela/bin/")) result.set(p.pid, "tela");
  }
  return result;
}

export function summarizeProcessInterval(previous: readonly ProcessObservation[], current: readonly ProcessObservation[], elapsedMs: number) {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) throw new Error("elapsedMs must be positive");
  const before = new Map(previous.map(p => [p.pid, p]));
  const classified = roles(current);
  const totals: Partial<Record<Role, { processCount: number; measuredProcesses: number; cpuPercent: number; rssMiB: number }>> = {};
  for (const p of current) {
    const role = classified.get(p.pid);
    if (!role) continue;
    const total = totals[role] ??= { processCount: 0, measuredProcesses: 0, cpuPercent: 0, rssMiB: 0 };
    total.processCount++;
    total.rssMiB += p.rssKiB / 1024;
    const old = before.get(p.pid);
    if (old && old.executable === p.executable && old.parent === p.parent && p.cpuMs >= old.cpuMs) {
      total.measuredProcesses++;
      total.cpuPercent += (p.cpuMs - old.cpuMs) / elapsedMs * 100;
    }
  }
  for (const total of Object.values(totals)) {
    total.cpuPercent = Math.round(total.cpuPercent * 10) / 10;
    total.rssMiB = Math.round(total.rssMiB);
  }
  return totals;
}

export async function observeDesktopPerformance(seconds = 20) {
  if (!Number.isSafeInteger(seconds) || seconds < 5 || seconds > 60) throw new Error("--seconds must be an integer from 5 to 60");
  if (process.platform !== "darwin") throw new Error("Desktop performance observation currently supports macOS only");
  const serviceKinds = new Map<number, { executable: string; parent: number; gpu: boolean }>();
  const read = async () => {
    const processes = parseProcessObservation((await execute("/bin/ps", ["-axo", "pid=,ppid=,time=,rss=,comm="],
      { timeout: 2000, maxBuffer: 4 * 1024 * 1024 })).stdout);
    const desktops = new Set(processes.filter(p => p.executable.endsWith("/ChatGPT.app/Contents/MacOS/ChatGPT")).map(p => p.pid));
    const services = processes.filter(p => desktops.has(p.parent) && p.executable.endsWith("/Codex (Service)"));
    const unknown = services.filter(p => {
      const cached = serviceKinds.get(p.pid);
      return !cached || cached.executable !== p.executable || cached.parent !== p.parent;
    });
    if (unknown.length > 0) {
      // Inspect only candidate Desktop children; never print or store their arguments.
      const gpuIds = gpuProcessIds((await execute("/bin/ps", ["-p", unknown.map(p => p.pid).join(","), "-o", "pid=,args="],
        { timeout: 2000, maxBuffer: 4 * 1024 * 1024 })).stdout);
      for (const p of unknown) serviceKinds.set(p.pid, { executable: p.executable, parent: p.parent, gpu: gpuIds.has(p.pid) });
    }
    const liveIds = new Set(services.map(p => p.pid));
    for (const pid of serviceKinds.keys()) if (!liveIds.has(pid)) serviceKinds.delete(pid);
    return processes.map(p => ({ ...p, gpu: serviceKinds.get(p.pid)?.gpu === true }));
  };
  const start = performance.now();
  let previous = await read();
  let previousAt = performance.now();
  const intervals = [];
  for (let index = 0; index < seconds; index++) {
    await new Promise<void>(resolve => setTimeout(resolve, 1000));
    const current = await read();
    const at = performance.now();
    intervals.push({ elapsedSeconds: Math.round((at - start) / 100) / 10,
      roles: summarizeProcessInterval(previous, current, at - previousAt) });
    previous = current;
    previousAt = at;
  }
  return { schemaVersion: 1, observedAt: new Date().toISOString(), platform: "darwin", mutating: false,
    privacy: "role-counts-cpu-memory-only", pathsEmitted: false, processIdsEmitted: false,
    contentRead: false, cpuUnit: "percent-of-one-core", intervals,
    limitations: ["CPU activity is not frame latency or proof of a bottleneck.",
      "RSS sums can double-count shared memory.", "No original-app instrumentation or persistent monitoring."] };
}
