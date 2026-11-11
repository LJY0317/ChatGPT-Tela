import type { ProductConfig } from "@chatgpt-tela/product-config";
import type { ProductProfileRuntimeConfig } from "@chatgpt-tela/development-runtime";

/** Installed Responses configuration selects the sole supported runtime. Plura remains
 * the lifecycle owner of any additional managed Desktop target. */
export function selectAppOwnedProfileIngress(
  config: ProductProfileRuntimeConfig,
  product: ProductConfig | undefined,
): { readonly port: number; readonly capability: string } {
  const route = product?.appOwnedResponses?.find(item => item.slot === config.slot);
  if (!route) throw new Error("Configure the app-owned Responses route for this profile before connecting Tela Web");
  if (config.nativeTarget.kind === "default-desktop" ? config.slot !== 1 : config.slot < 2) {
    throw new Error("App-owned Responses target does not match its Desktop profile slot");
  }
  if (config.acceptanceSavedChat) {
    throw new Error("App-owned Responses cannot enable managed Native saved-chat acceptance");
  }
  return Object.freeze({ port: route.port, capability: route.capability });
}
