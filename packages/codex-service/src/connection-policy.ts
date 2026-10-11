import type { CodexProfileStatus } from "./controller";

/** Saved intent cannot authorize taking over or restarting an existing app. */
export function restorableWorkProfiles(profiles: readonly CodexProfileStatus[], identities: readonly string[]): readonly number[] {
  const wanted = new Set(identities);
  return profiles.filter(profile => wanted.has(profile.targetId)
    && profile.controlState === "stopped" && profile.targetSessionState === "available"
    && profile.targetState !== "running").map(profile => profile.slot);
}
