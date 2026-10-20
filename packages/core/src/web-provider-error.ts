/** A provider-declared failure after submission; never permission to resend. */
export class WebProviderResponseFailed extends Error {
  readonly code = "tela_web_provider_response_failed";
  readonly retryable = false;
  constructor(detail?: string) {
    super(detail ? `Web turn failed: ${detail}` : "The accepted Web response failed");
    this.name = "WebProviderResponseFailed";
  }
}
