import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

// Bun on Windows can crash after collecting many tests in one process, even
// when the command is scoped to a single package. Keep every original test,
// but isolate each test file to identify a genuine failing file and avoid
// carrying native handles across otherwise independent test suites.
const testFile = /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mts|mjs|cjs)$/;

function testFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== "dist") {
      found.push(...testFiles(join(directory, entry.name)));
    } else if (entry.isFile() && testFile.test(entry.name)) {
      found.push(join(directory, entry.name).replaceAll("\\", "/"));
    }
  }
  return found.sort();
}

const groups: string[] = [];
const files: string[] = [];
for (const root of ["apps", "packages"]) {
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const target = join(root, entry.name);
    const matched = entry.isDirectory() ? testFiles(target) : entry.isFile() && testFile.test(entry.name) ? [target.replaceAll("\\", "/")] : [];
    if (!matched.length) continue;
    groups.push(`./${root}/${entry.name}`);
    files.push(...matched);
  }
}
if (!groups.length || !files.length) throw new Error("No Windows test files were discovered");
console.log(`Windows CI will run ${files.length} test files from ${groups.length} workspaces in separate Bun processes.`);
if (process.argv.includes("--list")) process.exit(0);

const failures: string[] = [];
for (const file of files) {
  console.log(`Testing ${file}`);
  const result = spawnSync(process.execPath, ["test", file], { stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    failures.push(`${file}: exit ${result.status}, signal ${result.signal ?? "none"}`);
  }
}
if (failures.length > 0) {
  throw new Error(`Windows tests failed in ${failures.length} file(s):\n${failures.join("\n")}`);
}
