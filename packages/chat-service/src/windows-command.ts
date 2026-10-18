/** cmd.exe /c accepts one command line; CRLF alone discards later statements. */
export function windowsCommandLine(command: string): string {
  return command.split(/\r\n|\r|\n/).filter(line => line.trim().length > 0).join(" & ");
}
