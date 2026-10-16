export type ProfileConnectionPhase = "checking" | "closing" | "preparing" | "connecting" | "ready" | "browser" | "account" | "connector" | "models" | "opening";
export interface ProfileStartOptions {
  /** Consent applies to this exact running Desktop; a replaced app must be preserved. */
  readonly expectedDesktopProcessId?: number;
  readonly requireStopped?: boolean;
  readonly onProgress?: (phase: ProfileConnectionPhase) => void;
}
const messages: Record<ProfileConnectionPhase, string> = {
  browser: "Couldn’t open the Web connection. Check Work and try again.",
  account: "Couldn’t verify your Web sign-in. Sign in from Work.",
  connector: "Couldn’t verify the Tela connection. Check Work setup.",
  models: "Couldn’t load the model catalog. Check Work and try again.",
  opening: "Couldn’t open ChatGPT. Check its app status before trying again.",
  checking: "Couldn't connect to this ChatGPT app. Check its status in Work before trying again.",
  closing: "ChatGPT couldn’t close. Finish your work and confirm Quit in ChatGPT, then try again.",
  preparing: "Couldn't get Web models ready. Open Work to check your connection.",
  connecting: "Couldn't finish connecting ChatGPT. Open Work to check your connection.",
  ready: "Couldn't save your connection choice. Check Tela settings before trying again.",
};
export class ProfileConnectionError extends Error {
  constructor(readonly phase: ProfileConnectionPhase, options?: ErrorOptions) {
    super(messages[phase], options);
    this.name = "ProfileConnectionError";
  }
}
