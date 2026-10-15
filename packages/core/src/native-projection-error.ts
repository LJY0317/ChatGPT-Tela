/** Fixed, payload-free classification shared by planning, retirement and transport. */
export class NativeProjectionUnsupported extends Error {
  readonly code = "native_projection_unsupported";

  constructor() {
    super("Native request contains content that Tela cannot safely project to Web. Continue on Native until supported; repeating this Web request cannot recover it.");
    this.name = "NativeProjectionUnsupported";
  }
}
