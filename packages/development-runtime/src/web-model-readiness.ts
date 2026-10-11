import { chatGptWebModelId, type ChatGptWebModelFamily } from "@chatgpt-tela/chatgpt";
import { readVisibleWebModelCatalog, type CodexAppServerRpc } from "@chatgpt-tela/codex";

// A route and an augmented API response alone do not prove Desktop model visibility.
// Confirm the effective startup catalog and the complete visible Web set together.
export async function verifyWebModelReadiness(
  rpc: Pick<CodexAppServerRpc, "request">,
  families: readonly ChatGptWebModelFamily[],
  signal: AbortSignal,
): Promise<void> {
  const expected = new Set(families.map(family => chatGptWebModelId(family.key)));
  if (!expected.size || expected.size !== families.length) throw new Error("Web model discovery is incomplete");
  const visible = await readVisibleWebModelCatalog(rpc, signal);
  if (visible.length !== expected.size || visible.some(model => !expected.delete(model)) || expected.size) {
    throw new Error("Web model list does not match the active discovery");
  }
}
