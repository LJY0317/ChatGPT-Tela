const PROVIDER_ID = "chatgpt_tela_canary";

function loopbackResponsesBaseUrl(value: URL | string): string {
  const url = value instanceof URL ? new URL(value.href) : new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("ChatGPT Tela Codex process route must use loopback http://");
  }
  if (!url.port) throw new Error("ChatGPT Tela Codex process route must include an explicit port");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("ChatGPT Tela Codex process route must not contain credentials, query, or fragment");
  }
  url.pathname = "/v1";
  return url.href.replace(/\/$/, "");
}

function environmentKey(value: string): string {
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(value)) {
    throw new Error("ChatGPT Tela Codex process route env key must be an uppercase environment variable name");
  }
  return value;
}

/**
 * Process-local Codex configuration for development smoke tests.
 *
 * These arguments intentionally use `--ignore-user-config`: a development canary must never rewrite
 * or temporarily replace the user's live `config.toml`. Authentication still comes from CODEX_HOME.
 */
export function codexProcessRouteArguments(input: {
  readonly baseUrl: URL | string;
  readonly envKey: string;
}): readonly string[] {
  const baseUrl = loopbackResponsesBaseUrl(input.baseUrl);
  const envKey = environmentKey(input.envKey);
  return Object.freeze([
    "--ignore-user-config",
    "-c", `model_provider=${JSON.stringify(PROVIDER_ID)}`,
    "-c", `model_providers.${PROVIDER_ID}.name=${JSON.stringify("ChatGPT Tela Development Canary")}`,
    "-c", `model_providers.${PROVIDER_ID}.base_url=${JSON.stringify(baseUrl)}`,
    "-c", `model_providers.${PROVIDER_ID}.env_key=${JSON.stringify(envKey)}`,
    "-c", `model_providers.${PROVIDER_ID}.env_key_instructions=${JSON.stringify(`Set ${envKey} only for the explicit ChatGPT Tela development canary.`)}`,
    "-c", `model_providers.${PROVIDER_ID}.wire_api=${JSON.stringify("responses")}`,
    "-c", `model_providers.${PROVIDER_ID}.requires_openai_auth=false`,
    "-c", `model_providers.${PROVIDER_ID}.supports_websockets=false`,
  ]);
}

export const CHATGPT_TELA_DEVELOPMENT_PROVIDER_ID = PROVIDER_ID;
