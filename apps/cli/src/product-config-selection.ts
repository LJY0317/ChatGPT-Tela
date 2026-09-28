import { existsSync } from "node:fs";
import { join } from "node:path";
import { readProductConfig, type ProductConfig } from "@chatgpt-tela/product-config";
import type { ProductPaths } from "@chatgpt-tela/product-lifecycle";

export function nativeProductConfigPath(productPaths: ProductPaths): string {
  return join(productPaths.configRoot, "product-v1.json");
}

export function readEffectiveProductConfig(
  productPaths: ProductPaths,
): ProductConfig {
  return readProductConfig(nativeProductConfigPath(productPaths));
}

export function hasEffectiveProductConfig(
  productPaths: ProductPaths,
): boolean {
  return existsSync(nativeProductConfigPath(productPaths));
}
