import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { packagedPayloadFingerprint } from "@chatgpt-tela/product-lifecycle";

// Cross-runtime integration gate: an ASAR archive must remain a physical file.
const electron = createRequire(import.meta.url)("electron") as string;
const archive = process.platform === "darwin"
  ? join(dirname(electron), "..", "Resources", "default_app.asar")
  : join(dirname(electron), "resources", "default_app.asar");
const root = mkdtempSync(join(tmpdir(), "tela-payload-asar-"));
try {
  const source = join(root, "payload");
  mkdirSync(source);
  writeFileSync(join(source, "app.asar"), readFileSync(archive));
  const entry = join(root, "proof.ts");
  writeFileSync(entry, `import { packagedPayloadFingerprint } from ${JSON.stringify(join(import.meta.dir, "../../../packages/product-lifecycle/src/packaged-payload.ts"))};\nconsole.log(packagedPayloadFingerprint(process.argv[2]));\n`);
  const compiled = join(root, "proof.cjs");
  execFileSync(process.execPath, ["build", entry, "--target=node", "--format=cjs", `--outfile=${compiled}`], {
    stdio: ["pipe", "pipe", "pipe"], timeout: 10_000,
  });
  const child = Bun.spawn([electron, compiled, source], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  child.stdin.end();
  const timeout = setTimeout(() => child.kill(), 10_000);
  let actual: string;
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (code !== 0) throw new Error(`Electron ownership proof failed: ${stderr}`);
    actual = stdout.trim();
  } finally {
    clearTimeout(timeout);
  }
  if (actual !== packagedPayloadFingerprint(source)) throw new Error("Electron package fingerprint differs from physical bytes");
  console.log(JSON.stringify({physicalArchiveFingerprintMatches: true}));
} finally {
  rmSync(root, { recursive: true, force: true });
}
