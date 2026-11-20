/** Windows PowerShell treats tokens after a string -Command as script text. */
export function windowsPowerShellArguments(script: string, values: readonly string[] = []): string[] {
  const data = Buffer.from(JSON.stringify({ values }), "utf8").toString("base64");
  const command = [
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);",
    `$telaArguments = (ConvertFrom-Json -InputObject ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')))).values;`,
    script,
  ].join("\n");
  return ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")];
}
