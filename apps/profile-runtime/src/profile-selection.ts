import type { ProductConfig } from "@chatgpt-tela/product-config";
import type { ProductProfileRuntimeConfig } from "@chatgpt-tela/development-runtime";

/** Only explicit installed configuration opts into app ownership. The legacy
 * default and all Multi-Profile targets keep their existing managed lifecycle. */
export function selectAppOwnedProfileIngress(
  config: ProductProfileRuntimeConfig,
  product: ProductConfig | undefined,
): { readonly port: number; readonly capability: string } | undefined {
  const route = product?.appOwnedResponses?.find(item => item.slot === config.slot);
  if (!route) return undefined;
  if (config.nativeTarget.kind !== "default-desktop" || config.slot !== 1) {
    throw new Error("App-owned Responses cannot replace a managed native target");
  }
  if (config.acceptanceSavedChat) {
    throw new Error("App-owned Responses cannot enable managed Native saved-chat acceptance");
  }
  return Object.freeze({ port: route.port, capability: route.capability });
}
