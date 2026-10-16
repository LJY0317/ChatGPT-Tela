/** Discovery advice only. The owning service still authorizes every call. */
export interface ChatCapabilitySemantics {
  readonly version: 1;
  readonly authority: "chat_service";
  readonly effect: "read" | "service_state" | "workspace_write" | "arbitrary_execution" | "resource_removal";
  readonly scope: "approved_root" | "workspace" | "owned_process" | "owned_worktree" | "owned_agent" | "service";
  readonly replay: "observe_again" | "inspect_before_repeat" | "same_operation_id";
  readonly verification: "bounded_result" | "workspace_diff" | "process_status" | "review_checkpoint" | "worktree_status" | "agent_status" | "user_confirmation";
  readonly maturity: "implemented";
}

export function parseChatCapabilitySemantics(value: unknown): ChatCapabilitySemantics {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid Chat capability semantics");
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || row.authority !== "chat_service" || row.maturity !== "implemented"
    || !["read", "service_state", "workspace_write", "arbitrary_execution", "resource_removal"].includes(row.effect as string)
    || !["approved_root", "workspace", "owned_process", "owned_worktree", "owned_agent", "service"].includes(row.scope as string)
    || !["observe_again", "inspect_before_repeat", "same_operation_id"].includes(row.replay as string)
    || !["bounded_result", "workspace_diff", "process_status", "review_checkpoint", "worktree_status", "agent_status", "user_confirmation"].includes(row.verification as string)) {
    throw Error("Invalid Chat capability semantics");
  }
  // Strip unknown fields; discovery must not transport credentials or arbitrary metadata.
  return Object.freeze({ version: 1, authority: "chat_service", effect: row.effect,
    scope: row.scope, replay: row.replay, verification: row.verification,
    maturity: "implemented" }) as ChatCapabilitySemantics;
}
