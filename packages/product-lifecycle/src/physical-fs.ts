import * as systemFs from "node:fs";
import { createRequire } from "node:module";

// Electron virtualizes ASAR archives through node:fs. Package ownership describes
// physical bytes, so use its standard original-fs API without changing global noAsar.
export const physicalFs: typeof systemFs = process.versions.electron
  ? createRequire(process.execPath)("original-fs")
  : systemFs;
