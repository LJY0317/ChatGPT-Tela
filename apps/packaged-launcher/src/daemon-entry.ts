/** Record import-time failures before the daemon's own failure handlers exist. */
export async function launchDaemon(service: "gateway" | "chat" | "codex", load: () => Promise<unknown>): Promise<void> {
  try {
    await load();
  } catch (error) {
    try {
      const { reportDaemonFailure } = await import("@chatgpt-tela/core");
      reportDaemonFailure(service, error);
    } catch { /* Diagnostic recording must preserve the original failure. */ }
    throw error;
  }
}
