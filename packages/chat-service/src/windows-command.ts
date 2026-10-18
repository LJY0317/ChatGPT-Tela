/** cmd.exe /c accepts one command line; CRLF alone discards later statements. */
export function windowsCommandLine(command: string): string {
  // No whitespace before &: cmd.exe otherwise writes that space into an
  // adjacent echo redirection (echo first>>file & echo second>>file).
  return command.split(/\r\n|\r|\n/).filter(line => line.trim().length > 0).join("& ");
}
