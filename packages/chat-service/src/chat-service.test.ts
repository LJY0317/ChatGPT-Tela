import { describe, expect, test } from "bun:test";
import { startChatService } from "./index";

describe("Tela Chat service boundary", () => {
  test("starts independently with no Codex/browser dependency and serves only a private loopback contract", async () => {
    const token = "c".repeat(48);
    const service = await startChatService({ bearerToken: token });
    try {
      const response = await fetch(new URL("v1/status", service.endpoint), {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      expect((await response.json() as { state: string }).state).toBe("ready");
      const unauthenticated = await fetch(new URL("v1/status", service.endpoint));
      expect(unauthenticated.status).toBe(401);
    } finally {
      await service.close();
    }
  });
});
