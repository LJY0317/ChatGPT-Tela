export type McpEndpointAuthentication =
  | { readonly kind: "none" }
  | { readonly kind: "bearer"; readonly secretReference: string }
  | { readonly kind: "oauth" }
  | { readonly kind: "openai-tunnel" };

export type HttpsMcpEndpointAuthentication = Exclude<
  McpEndpointAuthentication,
  { readonly kind: "openai-tunnel" }
>;

export interface HttpsMcpEndpoint {
  readonly kind: "https";
  readonly url: URL;
  readonly authentication: HttpsMcpEndpointAuthentication;
}

export interface OpenAiSecureTunnelEndpoint {
  readonly kind: "openai-secure-tunnel";
  readonly tunnelId: string;
  readonly authentication: { readonly kind: "openai-tunnel" };
}

export type McpEndpoint = HttpsMcpEndpoint | OpenAiSecureTunnelEndpoint;

export interface McpExposureHealth {
  readonly ready: boolean;
  readonly detail?: string;
}

export interface McpExposureProvider {
  readonly kind: string;
  prepare(signal?: AbortSignal): Promise<McpEndpoint>;
  verify(endpoint: McpEndpoint, signal?: AbortSignal): Promise<McpExposureHealth>;
  stop(): Promise<void>;
}

/**
 * An HTTPS endpoint whose lifecycle is owned elsewhere, such as a Tailscale Funnel managed by
 * DevSpace. ChatGPT Tela verifies and uses the boundary without acquiring a second tunnel.
 */
export class ExistingHttpsExposure implements McpExposureProvider {
  readonly kind = "existing-https-endpoint";
  readonly #endpoint: HttpsMcpEndpoint;
  readonly #probe: (endpoint: HttpsMcpEndpoint, signal?: AbortSignal) => Promise<McpExposureHealth>;

  constructor(input: {
    readonly url: string | URL;
    readonly authentication: HttpsMcpEndpointAuthentication;
    readonly probe: (endpoint: HttpsMcpEndpoint, signal?: AbortSignal) => Promise<McpExposureHealth>;
  }) {
    const url = new URL(input.url);
    if (url.protocol !== "https:") throw new Error("existing MCP exposure must use HTTPS");
    this.#endpoint = Object.freeze({
      kind: "https" as const,
      url,
      authentication: input.authentication,
    });
    this.#probe = input.probe;
  }

  async prepare(): Promise<HttpsMcpEndpoint> {
    return this.#endpoint;
  }

  async verify(endpoint: McpEndpoint, signal?: AbortSignal): Promise<McpExposureHealth> {
    if (endpoint.kind !== "https" || endpoint.url.href !== this.#endpoint.url.href) {
      throw new Error("cannot verify an endpoint not owned by this exposure provider");
    }
    return this.#probe(endpoint, signal);
  }

  async stop(): Promise<void> {
    // External endpoint lifecycle is intentionally not owned by ChatGPT Tela.
  }
}
