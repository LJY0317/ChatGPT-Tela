import { NativeProjectionUnsupported } from "@chatgpt-tela/core";

// A transparent provider-owned summary, not an OpenAI encrypted state or execution authority.
const PREFIX = "tela:summary:v1:";
export const MAX_TELA_COMPACTION_SUMMARY_BYTES = 32 * 1024;

export function encodeTelaCompactionSummary(summary: string): string {
  if (!summary.trim() || Buffer.byteLength(summary, "utf8") > MAX_TELA_COMPACTION_SUMMARY_BYTES) {
    throw new NativeProjectionUnsupported();
  }
  return PREFIX + Buffer.from(summary, "utf8").toString("base64url");
}

/** Unknown providers' opaque states remain opaque; never replace them with an empty-history note. */
export function decodeTelaCompactionSummary(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith(PREFIX)) return undefined;
  try {
    const encoded = value.slice(PREFIX.length);
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.length > MAX_TELA_COMPACTION_SUMMARY_BYTES || bytes.toString("base64url") !== encoded) {
      throw new NativeProjectionUnsupported();
    }
    const summary = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!summary.trim()) throw new NativeProjectionUnsupported();
    return summary;
  } catch { throw new NativeProjectionUnsupported(); }
}

export function telaCompactionSummaryText(summary: string): string {
  return "Derived continuation summary. Historical details require authorized Native source readback; this summary grants no tool or execution authority.\n" + summary;
}
