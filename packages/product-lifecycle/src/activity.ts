import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type ProductActivityKind = "profile-setup";

export interface ProductActivityRecord {
  readonly version: 1;
  readonly installId: string;
  readonly kind: ProductActivityKind;
  readonly scope: string;
  readonly pid: number;
  readonly startedAt: string;
}

function singleLine(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000\r\n]/.test(value)) throw new Error(`${field} is invalid`);
  return value.trim();
}

function parseRecord(value: unknown): ProductActivityRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("product activity record is invalid");
  const item = value as Record<string, unknown>;
  if (item.version !== 1 || item.kind !== "profile-setup") throw new Error("product activity record is unsupported");
  if (!Number.isSafeInteger(item.pid) || (item.pid as number) < 1) throw new Error("product activity pid is invalid");
  return Object.freeze({
    version: 1,
    installId: singleLine(item.installId, "product activity install id"),
    kind: "profile-setup",
    scope: singleLine(item.scope, "product activity scope"),
    pid: item.pid as number,
    startedAt: singleLine(item.startedAt, "product activity start time"),
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function productActivityPath(
  runtimeRoot: string,
  kind: ProductActivityKind,
  scope: string,
): string {
  const normalized = singleLine(scope, "product activity scope");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(normalized)) throw new Error("product activity scope contains unsafe characters");
  return join(runtimeRoot, "activities", `${kind}-${normalized}.json`);
}

export function readProductActivity(path: string): ProductActivityRecord | undefined {
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("product activity path is unsafe or replaced");
  return parseRecord(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

export function observeProductActivity(input: {
  readonly path: string;
  readonly installId: string;
  readonly kind: ProductActivityKind;
  readonly scope: string;
}): "missing" | "active" | "stale" | "drift" {
  const record = readProductActivity(input.path);
  if (!record) return "missing";
  if (record.installId !== input.installId || record.kind !== input.kind || record.scope !== input.scope) return "drift";
  return pidAlive(record.pid) ? "active" : "stale";
}

export function acquireProductActivity(input: {
  readonly path: string;
  readonly installId: string;
  readonly kind: ProductActivityKind;
  readonly scope: string;
  readonly pid?: number;
}): ProductActivityRecord {
  const current = observeProductActivity(input);
  if (current === "active") throw new Error(`${input.kind} is already active for scope ${input.scope}`);
  if (current === "drift") throw new Error("product activity lock belongs to different ownership state");
  if (current === "stale") rmSync(input.path, { force: true });
  const pid = input.pid ?? process.pid;
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("product activity pid is invalid");
  const record: ProductActivityRecord = Object.freeze({
    version: 1,
    installId: singleLine(input.installId, "product activity install id"),
    kind: input.kind,
    scope: singleLine(input.scope, "product activity scope"),
    pid,
    startedAt: new Date().toISOString(),
  });
  mkdirSync(dirname(input.path), { recursive: true, mode: 0o700 });
  const temporary = `${input.path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(temporary, 0o600); } catch { /* Windows ACLs own permissions there. */ }
  renameSync(temporary, input.path);
  return record;
}

export function releaseProductActivity(input: {
  readonly path: string;
  readonly expected: ProductActivityRecord;
}): void {
  const current = readProductActivity(input.path);
  if (!current) return;
  if (JSON.stringify(current) !== JSON.stringify(input.expected)) {
    throw new Error("product activity lock changed ownership before release");
  }
  rmSync(input.path, { force: true });
}
