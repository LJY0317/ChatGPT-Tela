/** ChatGPT-only file transport; workspace writes remain in Tela Chat. */
export const CHATGPT_FILE_CONNECT_ORIGINS = ["https://files.oaiusercontent.com"] as const;

export async function readChatGptFile(
  host: { getFileDownloadUrl(input: { fileId: string }): Promise<{ downloadUrl: string }> },
  selected: { fileId: string; fileName: string },
  maxBytes: number,
  allowedOrigins: readonly string[],
  fetchFile: (url: string, options?: RequestInit) => Promise<Response> = fetch,
): Promise<{ name: string; bytes: Uint8Array }> {
  // Keep this function self-contained: the same implementation runs in the card.
  if (!selected || typeof selected.fileId !== "string" || !selected.fileId
    || selected.fileId.length > 512 || typeof selected.fileName !== "string"
    || !selected.fileName || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("ChatGPT did not provide a valid file selection.");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    // Host authorization, not a caller-supplied URL, is the source of the reference.
    const reference = await Promise.race([
      host.getFileDownloadUrl({ fileId: selected.fileId }),
      new Promise<never>((_, reject) => controller.signal.addEventListener("abort",
        () => reject(new Error("File transfer timed out.")), { once: true })),
    ]);
    let url: URL;
    try { url = new URL(reference.downloadUrl); }
    catch { throw new Error("ChatGPT did not provide a valid file address."); }
    if (url.protocol !== "https:" || url.username || url.password || url.hash
      || !allowedOrigins.includes(url.origin)) {
      throw new Error("This ChatGPT file storage location is not supported yet.");
    }
    const response = await fetchFile(url.toString(), {
      signal: controller.signal, credentials: "omit", redirect: "error",
      referrerPolicy: "no-referrer", cache: "no-store",
    });
    if (!response.ok || !response.body) throw new Error("ChatGPT file could not be retrieved.");
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
      await response.body.cancel();
      throw new Error("This file exceeds the workspace import limit.");
    }
    reader = response.body.getReader();
    // Bound memory independently of the number or size of network chunks.
    const buffer = new Uint8Array(maxBytes);
    let size = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.byteLength > maxBytes - size) throw new Error("This file exceeds the workspace import limit.");
      buffer.set(next.value, size);
      size += next.value.byteLength;
    }
    return { name: selected.fileName, bytes: buffer.slice(0, size) };
  } catch (error) {
    if (controller.signal.aborted) throw new Error("File transfer timed out.");
    // Never show a signed URL, fetch error text, or host error payload.
    if (error instanceof Error && [
      "ChatGPT did not provide a valid file address.",
      "This ChatGPT file storage location is not supported yet.",
      "ChatGPT file could not be retrieved.",
      "This file exceeds the workspace import limit.",
    ].includes(error.message)) throw error;
    throw new Error("ChatGPT file could not be retrieved. Select the file again.");
  } finally {
    clearTimeout(timer);
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}
