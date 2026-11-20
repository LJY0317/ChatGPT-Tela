import { spawnSync } from "node:child_process";
import { expect, test } from "bun:test";
import { windowsPowerShellArguments } from "./windows-powershell";

test.skipIf(process.platform !== "win32")("Windows PowerShell preserves path, blank and Unicode data", () => {
  const values = ["C:\\Users\\이재엽\\App's Files\\Tela.exe", "", 'call "value"'];
  const result = spawnSync("powershell.exe", windowsPowerShellArguments(
    "[Console]::Write((ConvertTo-Json -InputObject $telaArguments -Compress))", values,
  ), { encoding: "utf8", windowsHide: true });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(values);
});
