import { expect, test } from "bun:test";
import { NativeIngressMediaRegistry, prepareNativeIngressTurnMedia } from "./native-ingress-media";

const png = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex");
const data = "data:image/png;base64," + png.toString("base64");

test("Native ingress bytes gain current turn identity only after upstream acknowledgement", () => {
  const registry = new NativeIngressMediaRegistry();
  const pending = prepareNativeIngressTurnMedia({
    threadId: "thread-a", input: [
      { type: "text", text: "What is shown?" },
      { type: "image", url: data },
    ],
  });
  expect(pending?.assets).toHaveLength(1);
  expect(registry.current("thread-a", "turn-1")).toBeUndefined();
  registry.accept(pending, "turn-1", "other-thread");
  expect(registry.current("thread-a", "turn-1")).toBeUndefined();
  registry.accept(pending, "turn-1", "thread-a");
  const attached = registry.current("thread-a", "turn-1");
  expect(attached?.assets).toHaveLength(1);
  expect(attached?.assets[0]?.bytes).toEqual(png);
  expect(attached?.assets[0]?.evidence).toMatchObject({
    origin: "current-user", source: "native_request", kind: "image",
    availability: "verified_inline_bytes",
  });
  expect(registry.current("thread-a", "turn-2")).toBeUndefined();
  expect(registry.current("thread-b", "turn-1")).toBeUndefined();
  registry.retire("thread-a", "turn-1");
  expect(registry.current("thread-a", "turn-1")).toBeUndefined();
});

test("repeated image references consume one physical byte budget but retain two refs", () => {
  const pending = prepareNativeIngressTurnMedia({
    threadId: "thread", input: [
      { type: "image", url: data }, { type: "image", url: data },
    ],
  });
  expect(pending?.assets).toHaveLength(2);
  const registry = new NativeIngressMediaRegistry();
  registry.accept(pending, "turn");
  const result = registry.current("thread", "turn");
  expect(result?.assets).toHaveLength(2);
  expect(result?.assets[0]?.evidence.id).not.toBe(result?.assets[1]?.evidence.id);
  expect(result?.assets[0]?.evidence.sha256).toBe(result?.assets[1]?.evidence.sha256);
  expect(result?.assets[0]?.bytes).toBe(result?.assets[1]?.bytes);
});

test("opaque Native local paths, file IDs and URLs stay marked unavailable", () => {
  const pending = prepareNativeIngressTurnMedia({ threadId: "thread", input: [
    { type: "localImage", path: "/private/path/image.png" },
    { type: "image", fileId: "opaque" },
    { type: "image", url: "https://private.invalid/asset?token=secret" },
  ] });
  expect(pending?.assets).toHaveLength(0);
  expect(pending?.unavailable).toBe(3);
  const registry = new NativeIngressMediaRegistry();
  registry.accept(pending, "turn");
  expect(registry.current("thread", "turn")?.unavailable).toBe(3);
  expect(JSON.stringify(registry.current("thread", "turn"))).not.toContain("/private/path");
  expect(JSON.stringify(registry.current("thread", "turn"))).not.toContain("secret");
});

test("expired ingress receipts and account revocations cannot authorize later media", () => {
  let now = 0;
  const registry = new NativeIngressMediaRegistry(() => now);
  registry.accept(prepareNativeIngressTurnMedia({
    threadId: "thread", input: [{ type: "image", url: data }],
  }), "turn");
  expect(registry.current("thread", "turn")).toBeDefined();
  now = 11 * 60 * 1000;
  expect(registry.current("thread", "turn")).toBeUndefined();
  registry.accept(prepareNativeIngressTurnMedia({
    threadId: "thread", input: [{ type: "image", url: data }],
  }), "another");
  registry.clear();
  expect(registry.current("thread", "another")).toBeUndefined();
});

test("an old in-flight Native acknowledgement cannot resurrect bytes after account change", () => {
  const registry = new NativeIngressMediaRegistry();
  const staged = prepareNativeIngressTurnMedia({
    threadId: "thread", input: [{ type: "image", url: data }],
  });
  const generation = registry.generation;
  registry.clear();
  registry.accept(staged, "turn", "thread", generation);
  expect(registry.current("thread", "turn")).toBeUndefined();
});
