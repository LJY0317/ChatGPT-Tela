/**
 * Manual setup/account repair stays on the ordinary saved-chat surface. Hidden Work provider state
 * starts from a fresh Temporary Chat so a user's home composer draft or attachment can never become
 * implicit Work input.
 */
export const CHATGPT_SAVED_CHAT_URL = "https://chatgpt.com/";
export const CHATGPT_TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";

/** Current Web adapter: optimistic local conversation handle before server hydration. */
export function isChatGptProvisionalConversationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === "https://chatgpt.com"
      && /^\/c\/local-chatgpt:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decodeURIComponent(url.pathname));
  } catch { return false; }
}

export function isChatGptTemporaryChatUrl(value: string): boolean {
  let url: URL;
  try { url = new URL(value); }
  catch { return false; }
  return url.origin === "https://chatgpt.com"
    && url.pathname === "/"
    && url.searchParams.get("temporary-chat") === "true";
}
