import { existsSync } from "node:fs";
import { join } from "node:path";
import { readProductControlConfig, type ProductControlPaths } from "@chatgpt-tela/control-plane";
import { readProductConfigIfPresent, type ProductConfig } from "@chatgpt-tela/product-config";
import type { ProductPaths } from "@chatgpt-tela/product-lifecycle";

export function nativeProductConfigPath(productPaths: ProductPaths): string {
  return join(productPaths.configRoot, "product-v1.json");
}

export function readEffectiveProductConfig(
  controlPaths: ProductControlPaths,
  productPaths: ProductPaths,
): ProductConfig {
  return readProductConfigIfPresent(nativeProductConfigPath(productPaths)) ?? readProductControlConfig(controlPaths);
}

export function hasEffectiveProductConfig(
  controlPaths: ProductControlPaths,
  productPaths: ProductPaths,
): boolean {
  return existsSync(nativeProductConfigPath(productPaths)) || existsSync(controlPaths.config);
}
