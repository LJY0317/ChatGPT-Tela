export const PROCESS_OUTPUT_LIMIT = 512 * 1024;
export interface ProcessOutputState {
  chunks: Buffer[]; outputBytes: number; baseOffset: number; readOffset: number; truncated: boolean;
}
export function appendProcessOutput(session: ProcessOutputState, chunk: Buffer): void {
    if (chunk.length === 0) return;
    session.chunks.push(Buffer.from(chunk));
    session.outputBytes += chunk.length;
    while (session.outputBytes > PROCESS_OUTPUT_LIMIT) {
      const first = session.chunks[0]!;
      const removedBytes = Math.min(first.length, session.outputBytes - PROCESS_OUTPUT_LIMIT);
      if (removedBytes === first.length) session.chunks.shift();
      else session.chunks[0] = Buffer.from(first.subarray(removedBytes));
      session.outputBytes -= removedBytes;
      session.baseOffset += removedBytes;
      session.truncated = true;
    }
}

export function consumeProcessOutput(session: ProcessOutputState): { readonly output: string; readonly truncated: boolean } {
    const buffer = Buffer.concat(session.chunks);
    const localOffset = Math.max(0, session.readOffset - session.baseOffset);
    const output = buffer.subarray(localOffset).toString("utf8");
    session.readOffset = session.baseOffset + buffer.length;
    return { output, truncated: session.truncated && localOffset === 0 };
}
