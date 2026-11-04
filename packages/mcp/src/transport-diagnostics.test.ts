import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeMcpEnvelope } from "./transport-diagnostics";

test("sent MCP receipt measures preserved read text without persisting its content", () => {
  const root = mkdtempSync(join(tmpdir(), "tela-mcp-envelope-"));
  const path = join(root, "events.jsonl");
  const prior = process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
  process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = path;
  try {
    const privateText = "PRIVATE_FILE_CONTENT_한글";
    observeMcpEnvelope({ jsonrpc: "2.0", id: 12, result: {
      content: [{ type: "text", text: privateText }],
    } }, "test-connection", "emitted");
    const raw = readFileSync(path, "utf8");
    const emitted = raw.trim().split("\n").map(line => JSON.parse(line))
      .find(row => row.stage === "mcp_rpc_emitted");
    expect(emitted).toMatchObject({ delivery: "transport_send_returned", part_count: 1,
      text_part_count: 1, image_part_count: 0, resource_part_count: 0,
      text_measurement_complete: true, text_bytes: Buffer.byteLength(privateText),
      structured_present: false, error_result: false });
    expect(raw).not.toContain(privateText);
  } finally {
    if (prior === undefined) delete process.env.CHATGPT_TELA_DIAGNOSTIC_FILE;
    else process.env.CHATGPT_TELA_DIAGNOSTIC_FILE = prior;
    rmSync(root, { recursive: true, force: true });
  }
});
