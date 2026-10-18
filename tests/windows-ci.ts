import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

// Bun on Windows can crash in one long-running test process after many files.
// Run every original app/package test, but give each workspace its own process.
const testFile = /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mts|mjs|cjs)$/;

function countTests(directory: string): number {
  let found = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== "dist") {
      found += countTests(join(directory, entry.name));
    } else if (entry.isFile() && testFile.test(entry.name)) {
      found++;
    }
  }
  return found;
}

const groups: string[] = [];
let files = 0;
for (const root of ["apps", "packages"]) {
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const target = join(root, entry.name);
    const count = entry.isDirectory() ? countTests(target) : entry.isFile() && testFile.test(entry.name) ? 1 : 0;
    if (!count) continue;
    groups.push(`./${root}/${entry.name}`);
    files += count;
  }
}
if (!groups.length || !files) throw new Error("No Windows test files were discovered");
console.log(`Windows CI will run ${files} test files across ${groups.length} isolated Bun processes.`);
if (process.argv.includes("--list")) process.exit(0);

for (const group of groups) {
  console.log(`Testing ${group}`);
  const result = spawnSync(process.execPath, ["test", group], { stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Windows tests failed in ${group}: exit ${result.status}, signal ${result.signal ?? "none"}`);
  }
}
