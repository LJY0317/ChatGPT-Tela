import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

/** Read only a direct job field; nested coalition/argument dictionaries are not job authority. */
export function launchdJobField(stdout: string, field: "state" | "path"): string {
  const values: string[] = [];
  let depth = 0;
  let roots = 0;
  for (const line of stdout.split(/\r?\n/)) {
    if (/=>?\s*\{\s*$/.test(line)) {
      if (depth === 0) roots++;
      depth++;
    } else if (/^\s*}\s*$/.test(line)) {
      if (depth === 0) throw new Error("launchd service dictionary is malformed");
      depth--;
    } else if (depth === 1) {
      const entry = /^\s*([a-z]+)\s*=\s*(.+?)\s*$/.exec(line);
      if (entry?.[1] === field) values.push(entry[2]!);
    }
  }
  if (roots !== 1 || depth !== 0 || values.length !== 1) {
    throw new Error(`launchd service ${field} is ambiguous`);
  }
  return values[0]!;
}

/** Session-wide labels must resolve to this install's physical definition before mutation. */
export function assertLaunchdJobDefinition(stdout: string, expectedPath: string | undefined): void {
  const loadedPath = launchdJobField(stdout, "path");
  if (!isAbsolute(loadedPath) || !expectedPath
    || realpathSync(loadedPath) !== realpathSync(expectedPath)) {
    throw new Error("loaded launchd registration belongs to a different definition");
  }
}
