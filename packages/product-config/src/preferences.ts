import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveProductPaths, type ProductPathOptions } from "@chatgpt-tela/product-lifecycle";

export type ProductApprovalAutomationMode = "off" | "recognized_once";

export interface ProductPreferences {
  readonly version: 1;
  readonly approvalAutomation: ProductApprovalAutomationMode;
}

export const DEFAULT_PRODUCT_PREFERENCES: ProductPreferences = Object.freeze({
  version: 1,
  approvalAutomation: "off",
});

export function parseProductPreferences(value: unknown): ProductPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ChatGPT Tela preferences must be a JSON object");
  }
  const item = value as Record<string, unknown>;
  const extra = Object.keys(item).filter(key => !["version", "approvalAutomation"].includes(key));
  if (extra.length > 0) throw new Error(`ChatGPT Tela preferences contain unknown fields: ${extra.join(", ")}`);
  if (item.version !== 1) throw new Error("unsupported ChatGPT Tela preferences version");
  const approvalAutomation = item.approvalAutomation ?? "off";
  if (approvalAutomation !== "off" && approvalAutomation !== "recognized_once") {
    throw new Error("ChatGPT Tela approval automation mode is invalid");
  }
  return Object.freeze({ version: 1, approvalAutomation });
}

export function resolveProductPreferencesPath(options: ProductPathOptions = {}): string {
  return join(resolveProductPaths(options).configRoot, "preferences-v1.json");
}

export function readProductPreferences(path = resolveProductPreferencesPath()): ProductPreferences {
  if (!existsSync(path)) return DEFAULT_PRODUCT_PREFERENCES;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("ChatGPT Tela preferences path is unsafe or replaced");
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")) as unknown; }
  catch (error) { throw new Error("ChatGPT Tela preferences are unreadable", { cause: error }); }
  return parseProductPreferences(value);
}

export function writeProductPreferences(
  preferences: ProductPreferences,
  path = resolveProductPreferencesPath(),
): void {
  const normalized = parseProductPreferences(preferences);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try { chmodSync(temporary, 0o600); } catch { /* Windows ACLs own permissions there. */ }
  renameSync(temporary, path);
}
