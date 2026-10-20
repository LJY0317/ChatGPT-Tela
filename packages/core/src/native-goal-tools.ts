import type { NativeToolDescriptor } from "./tools";

/** Original harness controls, never similarly named MCP/workspace tools. */
export function isNativeGoalTool(tool: NativeToolDescriptor): boolean {
  return tool.kind === "function" && (tool.namespace === undefined || tool.namespace === "functions")
    && (tool.name === "get_goal" || tool.name === "update_goal");
}
