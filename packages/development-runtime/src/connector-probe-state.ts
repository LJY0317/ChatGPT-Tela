import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

interface ConnectorProbeMarker {
  readonly version: 1;
  readonly connectorFingerprint: string;
}

function connectorFingerprint(name: string): string {
  return createHash("sha256").update(name).digest("hex");
}

function markerValue(connectorName: string): ConnectorProbeMarker {
  return Object.freeze({
    version: 1 as const,
    connectorFingerprint: connectorFingerprint(connectorName),
  });
}

export class ConnectorProbeState {
  readonly path: string;
  readonly #expected: ConnectorProbeMarker;

  constructor(input: { readonly directory: string; readonly connectorName: string }) {
    const connectorName = input.connectorName.trim();
    if (!connectorName || connectorName.length > 128 || /[\u0000\r\n]/.test(connectorName)) {
      throw new Error("connector probe state requires a valid connector name");
    }
    this.path = resolve(input.directory, "chatgpt-tela-connector-probe.json");
    this.#expected = markerValue(connectorName);
  }

  pending(): boolean {
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2048) {
      throw new Error("connector probe marker is unsafe or malformed");
    }
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      throw new Error("connector probe marker permissions are too broad");
    }
    let value: unknown;
    try { value = JSON.parse(readFileSync(this.path, "utf8")); }
    catch (error) { throw new Error("connector probe marker is unreadable", { cause: error }); }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("connector probe marker has an invalid shape");
    }
    const marker = value as Record<string, unknown>;
    if (marker.version !== this.#expected.version
      || marker.connectorFingerprint !== this.#expected.connectorFingerprint
      || Object.keys(marker).some(key => key !== "version" && key !== "connectorFingerprint")) {
      throw new Error("connector probe marker does not match this runtime");
    }
    return true;
  }

  begin(): void {
    try {
      lstatSync(this.path);
      throw new Error("connector probe marker already exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = `${this.path}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(this.#expected)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    try { chmodSync(temporary, 0o600); } catch { /* Windows ACLs own permissions there. */ }
    try {
      renameSync(temporary, this.path);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  clear(): void {
    if (!this.pending()) return;
    rmSync(this.path);
  }
}
