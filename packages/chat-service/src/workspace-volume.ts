import { execFileSync } from "node:child_process";

// Darwin's dev_t is a mount-time identifier, not a durable volume identity.
// Keep only the most recently resolved device; no disk cache or resident observer.
let cached: { device: string; volume: string | undefined } | undefined;
export function workspaceVolume(root: string, device: string): string | undefined {
  if (process.platform !== "darwin") return undefined;
  if (cached?.device === device) return cached.volume;
  let volume: string | undefined;
  try {
    const filesystem = execFileSync("/bin/df", ["-P", root], { encoding: "utf8" })
      .match(/^\/dev\/\S+/m)?.[0];
    if (filesystem) {
      const plist = execFileSync("/usr/sbin/diskutil", ["info", "-plist", filesystem]);
      const info = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"],
        { input: plist, encoding: "utf8" }));
      if (typeof info.VolumeUUID === "string" && /^[a-f\d-]{36}$/i.test(info.VolumeUUID)) {
        volume = info.VolumeUUID.toLowerCase();
      }
    }
  } catch (error) {
    throw new Error("workspace volume lookup failed; check that the disk is available", { cause: error });
  }
  if (volume) cached = { device, volume };
  return volume;
}
