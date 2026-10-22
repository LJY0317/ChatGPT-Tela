import type { App } from "electron";

export function bindBeforeQuitToStop(
  app: App,
  stop: () => Promise<void>,
  onError: (error: unknown) => void,
): () => void {
  let quitAllowed = false;
  let stopping: Promise<void> | undefined;
  app.on("before-quit", event => {
    if (quitAllowed) return;
    event.preventDefault();
    if (stopping) return;
    stopping = stop().catch(error => {
      stopping = undefined;
      onError(error);
    });
  });
  return () => { quitAllowed = true; };
}
