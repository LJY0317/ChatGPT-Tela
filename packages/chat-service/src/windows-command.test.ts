import { expect, test } from "bun:test";
import { windowsCommandLine } from "./windows-command";

test("Windows multiline commands retain each nonblank statement in order", () => {
  expect(windowsCommandLine("echo first>>result.txt\r\necho second>>result.txt"))
    .toBe("echo first>>result.txt & echo second>>result.txt");
  expect(windowsCommandLine("echo one\n\n echo two\r echo three"))
    .toBe("echo one &  echo two &  echo three");
});
