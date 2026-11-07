import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chatGptWebFamilyKey, chatGptWebModelId } from "@chatgpt-tela/chatgpt";
import { createOwnershipManifest, readOwnershipManifest, resolveProductPaths, writeOwnershipManifest } from "@chatgpt-tela/product-lifecycle";
import { appOwnedDesktopCatalogPath, publishAppOwnedDesktopCatalog, readPreparedAppOwnedDesktopCatalog } from "./app-owned-desktop-catalog";

test("cold installed catalog is created from verified Native and account-bound Web families, replaced atomically, and retained", async () => {
  const home = mkdtempSync(join(tmpdir(), "tela-cold-owned-catalog-"));
  try {
    const paths = resolveProductPaths({ platform: "linux", home, environment: {} });
    const manifest = createOwnershipManifest("fixture", new Date(), "11111111-2222-4333-8444-555555555555");
    writeOwnershipManifest(paths.installManifest, manifest);
    const path = appOwnedDesktopCatalogPath(paths);
    expect(() => readPreparedAppOwnedDesktopCatalog({ paths, installId: manifest.installId })).toThrow("no owned resource");
    const native = { object: "list", models: [{ slug: "native", display_name: "Native",
      visibility: "list", supported_reasoning_levels: [{ effort: "medium", description: "Native medium" }] }] };
    const family = { key: chatGptWebFamilyKey("Browser model"), label: "Browser model", availableEfforts: ["medium"] as const };
    const input = { paths, installId: manifest.installId, nativeCatalog: native,
      webFamilies: [family], assertCurrentAccount: () => {} };
    expect(await publishAppOwnedDesktopCatalog(input)).toBe(path);
    const models = JSON.parse(readFileSync(path, "utf8")).models as { slug: string }[];
    expect(models.map(model => model.slug)).toEqual(["native", chatGptWebModelId(family.key)]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readOwnershipManifest(paths.installManifest)?.resources.some(resource => resource.id === "app-owned-desktop-model-catalog")).toBe(true);
    const prior = readFileSync(path, "utf8");
    expect(await publishAppOwnedDesktopCatalog(input)).toBe(path);
    expect(readFileSync(path, "utf8")).toBe(prior);
    await expect(publishAppOwnedDesktopCatalog({ ...input, webFamilies: [],
      assertCurrentAccount: () => { throw new Error("account binding changed"); } })).rejects.toThrow("account binding changed");
    expect(readFileSync(path, "utf8")).toBe(prior);
    expect(await publishAppOwnedDesktopCatalog({ ...input, webFamilies: [] })).toBe(path);
    expect(JSON.parse(readFileSync(path, "utf8")).models.map((model: { slug: string }) => model.slug)).toEqual(["native"]);
    expect(readPreparedAppOwnedDesktopCatalog({ paths, installId: manifest.installId })).toBe(path);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("producer refuses to adopt a foreign pre-existing catalog directory", async () => {
  const home = mkdtempSync(join(tmpdir(), "tela-foreign-owned-catalog-"));
  try {
    const paths = resolveProductPaths({ platform: "linux", home, environment: {} });
    const manifest = createOwnershipManifest("fixture", new Date(), "11111111-2222-4333-8444-555555555555");
    writeOwnershipManifest(paths.installManifest, manifest);
    const directory = dirname(appOwnedDesktopCatalogPath(paths));
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "foreign.txt"), "owned by another installer");
    await expect(publishAppOwnedDesktopCatalog({ paths, installId: manifest.installId,
      nativeCatalog: { models: [] }, webFamilies: [], assertCurrentAccount: () => {} }))
      .rejects.toThrow("another owner");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
