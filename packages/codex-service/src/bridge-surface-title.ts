const THREAD_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

/** Read only a title proven to belong to the exact Native thread requested. */
export function nativeThreadDisplayTitle(value: unknown, expectedThreadId: string): string | undefined {
  if (!THREAD_ID.test(expectedThreadId) || !value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const thread = (value as Record<string, unknown>).thread;
  if (!thread || typeof thread !== "object" || Array.isArray(thread)
    || (thread as Record<string, unknown>).id !== expectedThreadId) return undefined;
  const metadata = thread as Record<string, unknown>;
  const raw = typeof metadata.name === "string" ? metadata.name.trim() : "";
  const display = raw.replace(/^\[Tela Agent\]\s*/, "").trim();
  return display ? display.slice(0, 1000) : undefined;
}
