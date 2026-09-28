export type NativeSandboxAuthority =
  | { kind: "read-only"; network: "enabled" | "restricted" }
  | { kind: "workspace-write"; writableRoots: readonly string[]; network: "enabled" | "restricted" }
  | { kind: "danger-full-access" }
  | {
      /**
       * The public Native runtime proves and enforces the sandbox, but does not expose its full
       * policy through the integration boundary. ChatGPT Tela may route tool calls back to Native
       * Codex, but must not perform direct filesystem/network work from this authority variant.
       */
      kind: "native-enforced";
    };

export interface NativeTurnAuthority {
  readonly source: "native-current-turn";
  readonly threadId: string;
  readonly turnId: string;
  readonly cwd: string;
  readonly workspaceRoots: readonly string[];
  readonly sandbox: NativeSandboxAuthority;
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must be non-empty`);
  return normalized;
}

/**
 * Marks already-observed Native Codex evidence as current-turn authority.
 * Filesystem/path validation belongs to the Native/platform adapter that owns that evidence.
 */
export function defineNativeTurnAuthority(
  input: Omit<NativeTurnAuthority, "source">,
): NativeTurnAuthority {
  return Object.freeze({
    source: "native-current-turn" as const,
    threadId: nonEmpty(input.threadId, "threadId"),
    turnId: nonEmpty(input.turnId, "turnId"),
    cwd: nonEmpty(input.cwd, "cwd"),
    workspaceRoots: Object.freeze([...input.workspaceRoots]),
    sandbox: input.sandbox,
  });
}
