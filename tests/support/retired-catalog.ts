import { createHash } from "node:crypto";
/** Historical configuration fixture for removal tests, never a production writer. */
export function retiredCatalogConfig(content: string, installId: string, path: string): string {
  const hash = createHash("sha256").update(`${installId}\0${path}`).digest("hex");
  return `# ChatGPT Tela catalog begin: ${installId} ${hash}\nmodel_catalog_json = ${JSON.stringify(path)}\n# ChatGPT Tela catalog end: ${installId}\n` + content;
}
