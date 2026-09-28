import { expect, test } from "bun:test";
import { executeSetup } from "./index";

test("setup planning is read-only until apply is explicitly requested", async () => {
  let writes = 0;
  const driver = {
    inspect: async () => ({ installed: false }),
    plan: () => ({ action: "install" as const }),
    apply: async () => { writes += 1; return { installed: true }; },
    verify: async () => ({ healthy: true }),
  };

  const dryRun = await executeSetup(driver, { apply: false });
  expect(dryRun.mode).toBe("plan");
  expect(writes).toBe(0);

  const applied = await executeSetup(driver, { apply: true });
  expect(applied.mode).toBe("applied");
  expect(writes).toBe(1);
});
